import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { candidatePaths, isLoopback, loadConfig, managedInstallDir, validateRemoteHost } from "../src/config.js";
import { tmp } from "./helpers.js";

describe("loadConfig", () => {
  it("defaults to loopback, home allowlist, telemetry off, no spawn without a binary", () => {
    const home = tmp();
    const cfg = loadConfig({ env: {}, home, platform: "darwin", findServer: () => undefined });
    expect(cfg.baseUrl).toBe("http://127.0.0.1:44388");
    expect(cfg.preformServerPath).toBeUndefined();
    expect(cfg.spawn).toBe(false);
    expect(cfg.allowedPaths).toEqual([home]);
    expect(cfg.telemetry).toBe(false);
    expect(cfg.remote).toBeUndefined();
    expect(isLoopback(cfg.baseUrl)).toBe(true);
  });

  it("spawns when a binary is auto-detected and honours PREFORM_SERVER_PATH over detection", () => {
    const home = tmp();
    const found = join(home, "found");
    writeFileSync(found, "");
    const cfg = loadConfig({ env: {}, home, platform: "darwin", findServer: () => found });
    expect(cfg.preformServerPath).toBe(found);
    expect(cfg.spawn).toBe(true);
    const explicit = loadConfig({ env: { PREFORM_SERVER_PATH: "/x/y" }, home, platform: "darwin", findServer: () => found });
    expect(explicit.preformServerPath).toBe("/x/y");
  });

  it("disables spawn for PREFORM_SPAWN=0 and for a remote URL", () => {
    const home = tmp();
    const base = { home, platform: "darwin" as const, findServer: () => "/bin/sh" };
    expect(loadConfig({ ...base, env: { PREFORM_SPAWN: "0" } }).spawn).toBe(false);
    const remote = loadConfig({ ...base, env: { PREFORM_SERVER_URL: "http://10.0.0.5:44388/" } });
    expect(remote.spawn).toBe(false);
    expect(remote.baseUrl).toBe("http://10.0.0.5:44388");
    expect(isLoopback(remote.baseUrl)).toBe(false);
  });

  it("reads allowed paths with the platform separator and expands ~", () => {
    const home = tmp();
    mkdirSync(join(home, "a"));
    const cfg = loadConfig({ env: { FORMLABS_ALLOWED_PATHS: `~/a:/tmp` }, home, platform: "darwin", findServer: () => undefined });
    expect(cfg.allowedPaths[0]).toBe(join(home, "a"));
    expect(cfg.allowedPaths[1]).toBe(path.resolve("/tmp")); // drive-prefixed on Windows hosts
  });

  it("keeps credentials out of the loggable summary", () => {
    const cfg = loadConfig({ env: { FORMLABS_USERNAME: "me", FORMLABS_PASSWORD: "hunter2" }, home: tmp(), platform: "darwin", findServer: () => undefined });
    expect(cfg.credentials).toEqual({ username: "me", password: "hunter2" });
    expect(JSON.stringify(cfg.summary())).not.toContain("hunter2");
  });

  it("parses remote host settings and rejects option injection", () => {
    const cfg = loadConfig({ env: { PREFORM_REMOTE_HOST: "me@mini.local", PREFORM_REMOTE_PORT: "2222" }, home: tmp(), platform: "linux", findServer: () => undefined });
    expect(cfg.remote).toEqual(expect.objectContaining({ host: "me@mini.local", port: 2222 }));
    expect(cfg.spawn).toBe(false);
    expect(() => validateRemoteHost("-oProxyCommand=evil")).toThrow(/host/i);
    expect(() => validateRemoteHost("me@host;rm -rf /")).toThrow(/host/i);
    expect(validateRemoteHost("user@10.0.0.7")).toBe("user@10.0.0.7");
  });
});

describe("candidatePaths / managedInstallDir", () => {
  it("lists the managed dir first on every platform", () => {
    const home = "/Users/x";
    const mac = candidatePaths("darwin", home, {});
    expect(mac[0]).toBe(path.posix.join(managedInstallDir("darwin", home, {}), "PreFormServer.app/Contents/MacOS/PreFormServer"));
    expect(mac).toContain("/Applications/PreFormServer.app/Contents/MacOS/PreFormServer");
    const win = candidatePaths("win32", "C:\\Users\\x", { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local", ProgramFiles: "C:\\Program Files" });
    expect(win[0]).toMatch(/PreFormServer\.exe$/);
    expect(win.some((p) => p.includes("Program Files"))).toBe(true);
    const linux = candidatePaths("linux", "/home/x", {});
    expect(linux[0]).toMatch(/PreFormServer\.exe$/); // Wine
  });
});

describe("isLoopback", () => {
  it.each([
    ["http://localhost:44388", true],
    ["http://127.0.0.1:44388", true],
    ["http://[::1]:44388", true],
    ["http://127.5.5.5", true],
    ["http://192.168.1.20:44388", false],
    ["http://preform.example.com", false],
  ])("%s -> %s", (url, expected) => {
    expect(isLoopback(url)).toBe(expected);
  });
});
