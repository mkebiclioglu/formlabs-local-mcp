import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chooseRelease, installPreformServer, parseDownloadsPage, validateDownloadUrl } from "../src/installer.js";
import { fakePreform, makeConfig, makeZip, tmp } from "./helpers.js";

const fixture = readFileSync(new URL("./fixtures/downloads.html", import.meta.url), "utf8");

describe("parseDownloadsPage", () => {
  it("extracts releases with version, date, api version and per-platform urls", () => {
    const releases = parseDownloadsPage(fixture);
    expect(releases.length).toBeGreaterThanOrEqual(4);
    const latest = releases[0]!;
    expect(latest.version).toBe("3.62.1");
    expect(latest.apiVersion).toBe("0.9.29");
    expect(latest.date).toBe("August 19, 2026");
    expect(latest.urls.mac).toMatch(/^https:\/\/downloads\.formlabs\.com\/PreFormServer\/Release\/3\.62\.1\/PreForm_Server_mac_3\.62\.1_.*\.zip$/);
    expect(latest.urls.win).toMatch(/PreForm_Server_win_3\.62\.1/);
  });
  it("sorts by version, not page order", () => {
    const shuffled = fixture.replace(/<tbody>/, "<tbody>" + fixture.match(/<tr>(?:(?!<tr>).)*3\.41\.0(?:(?!<\/tr>).)*<\/tr>/s)![0]);
    expect(parseDownloadsPage(shuffled)[0]!.version).toBe("3.62.1");
  });
  it("ignores links that are not on downloads.formlabs.com", () => {
    const evil = fixture.replace("https://downloads.formlabs.com/PreFormServer/Release/3.62.1/PreForm_Server_mac_3.62.1_release_releaser_648_152762.zip",
      "https://evil.example.com/PreFormServer/Release/9.9.9/PreForm_Server_mac_9.9.9_x.zip");
    const r = parseDownloadsPage(evil);
    expect(r.some((x) => x.version === "9.9.9")).toBe(false);
    expect(r[0]!.urls.mac).toBeUndefined();
  });
});

describe("validateDownloadUrl", () => {
  it.each([
    "http://downloads.formlabs.com/PreFormServer/Release/3.62.1/PreForm_Server_mac_3.62.1_a.zip",
    "https://downloads.formlabs.com.evil.com/PreFormServer/Release/3.62.1/PreForm_Server_mac_3.62.1_a.zip",
    "https://downloads.formlabs.com/other/PreForm_Server_mac_3.62.1_a.zip",
    "https://downloads.formlabs.com/PreFormServer/Release/3.62.1/PreForm_Server_mac_3.62.1_a.exe",
    "https://downloads.formlabs.com/PreFormServer/Release/3.62.1/../../x.zip",
  ])("rejects %s", (u) => {
    expect(() => validateDownloadUrl(u)).toThrow();
  });
  it("accepts the real layout", () => {
    expect(validateDownloadUrl("https://downloads.formlabs.com/PreFormServer/Release/3.62.1/PreForm_Server_mac_3.62.1_release_releaser_648_152762.zip")).toBeTruthy();
  });
});

describe("chooseRelease", () => {
  it("picks the platform url and refuses unsupported platforms", () => {
    const releases = parseDownloadsPage(fixture);
    expect(chooseRelease(releases, "darwin").url).toContain("_mac_");
    expect(chooseRelease(releases, "win32").url).toContain("_win_");
    expect(chooseRelease(releases, "linux").url).toContain("_win_"); // Wine
    expect(() => chooseRelease([], "darwin")).toThrow(/no PreFormServer/i);
  });
});

describe("installPreformServer", () => {
  it("downloads, scans, extracts, verifies and installs into the managed dir", async () => {
    const zip = makeZip([
      { name: "PreFormServer/PreFormServer.app/Contents/Info.plist", data: '<plist><dict><key>CFBundleShortVersionString</key><string>3.62.1</string></dict></plist>' },
      { name: "PreFormServer/PreFormServer.app/Contents/MacOS/PreFormServer", data: "#!/bin/sh\necho READY FOR INPUT\n" },
    ]);
    const f = await fakePreform({
      "GET /page": (_r, _b, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(fixture); },
      "GET /PreFormServer/Release/3.62.1/PreForm_Server_mac_3.62.1_release_releaser_648_152762.zip": (_r, _b, res) => { res.writeHead(200, { "content-type": "application/zip", "content-length": String(zip.length) }); res.end(zip); },
    });
    try {
      const home = tmp();
      const cfg = makeConfig({ home, platform: "darwin" });
      const verified: string[] = [];
      const result = await installPreformServer(cfg, {
        downloadsPageUrl: `${f.url}/page`,
        // Test hook: rewrite the validated formlabs URL to the fake server while keeping validation on the original.
        rewriteUrl: (u) => u.replace("https://downloads.formlabs.com", f.url),
        verify: async (appPath) => { verified.push(appPath); },
        extract: "node",
        log: () => {},
      });
      expect(result.version).toBe("3.62.1");
      expect(result.apiVersion).toBe("0.9.29");
      expect(existsSync(result.executable)).toBe(true);
      expect(verified).toHaveLength(1);
      expect(result.executable.startsWith(home)).toBe(true);
      const meta = JSON.parse(readFileSync(join(result.installDir, "install.json"), "utf8"));
      expect(meta.version).toBe("3.62.1");
      expect(meta.sourceUrl).toContain("downloads.formlabs.com");
    } finally {
      f.server.close();
    }
  });

  it("refuses to install when verification fails and leaves nothing behind", async () => {
    const zip = makeZip([{ name: "PreFormServer/PreFormServer.app/Contents/MacOS/PreFormServer", data: "x" }]);
    const f = await fakePreform({
      "GET /page": (_r, _b, res) => { res.writeHead(200); res.end(fixture); },
      "GET /PreFormServer/Release/3.62.1/PreForm_Server_mac_3.62.1_release_releaser_648_152762.zip": (_r, _b, res) => { res.writeHead(200, { "content-length": String(zip.length) }); res.end(zip); },
    });
    try {
      const home = tmp();
      const cfg = makeConfig({ home, platform: "darwin" });
      await expect(installPreformServer(cfg, {
        downloadsPageUrl: `${f.url}/page`,
        rewriteUrl: (u) => u.replace("https://downloads.formlabs.com", f.url),
        verify: async () => { throw new Error("signature mismatch: TeamIdentifier=EVIL"); },
        extract: "node",
        log: () => {},
      })).rejects.toThrow(/signature/);
      expect(existsSync(join(home, "Library", "Application Support", "formlabs-local-mcp", "PreFormServer.app"))).toBe(false);
    } finally {
      f.server.close();
    }
  });

  it("refuses downloads larger than the cap", async () => {
    const f = await fakePreform({
      "GET /page": (_r, _b, res) => { res.writeHead(200); res.end(fixture); },
      "GET /PreFormServer/Release/3.62.1/PreForm_Server_mac_3.62.1_release_releaser_648_152762.zip": (_r, _b, res) => { res.writeHead(200, { "content-length": "999999999999" }); res.end("x"); },
    });
    try {
      const cfg = makeConfig({ home: tmp(), platform: "darwin" });
      await expect(installPreformServer(cfg, {
        downloadsPageUrl: `${f.url}/page`,
        rewriteUrl: (u) => u.replace("https://downloads.formlabs.com", f.url),
        verify: async () => {},
        extract: "node",
        log: () => {},
      })).rejects.toThrow(/too large/i);
    } finally {
      f.server.close();
    }
  });

  it("skips the download when the installed version is already the latest", async () => {
    const home = tmp();
    const cfg = makeConfig({ home, platform: "darwin" });
    const dir = join(home, "Library", "Application Support", "formlabs-local-mcp");
    mkdirSync(join(dir, "PreFormServer.app", "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(dir, "PreFormServer.app", "Contents", "MacOS", "PreFormServer"), "");
    writeFileSync(join(dir, "install.json"), JSON.stringify({ version: "3.62.1" }));
    const f = await fakePreform({ "GET /page": (_r, _b, res) => { res.writeHead(200); res.end(fixture); } });
    try {
      const r = await installPreformServer(cfg, { downloadsPageUrl: `${f.url}/page`, verify: async () => {}, extract: "node", log: () => {} });
      expect(r.status).toBe("up_to_date");
      expect(f.calls.some((c) => c.path.endsWith(".zip"))).toBe(false);
    } finally {
      f.server.close();
    }
  });
});
