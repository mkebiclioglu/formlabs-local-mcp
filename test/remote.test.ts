import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RemoteBackend, sshArgs } from "../src/remote.js";
import { fakeSshBin, makeConfig, tmp } from "./helpers.js";

const isWin = process.platform === "win32";

describe("sshArgs", () => {
  it("uses key-only batch mode, forward-failure exit, a loopback-only forward, and a -- separator", () => {
    const args = sshArgs({ host: "me@mini.local", port: 2222 }, { localPort: 45000, remotePort: 44388, command: ["/x/PreFormServer", "--port", "44388"] });
    expect(args).toContain("-oBatchMode=yes");
    expect(args).toContain("-oExitOnForwardFailure=yes");
    expect(args).toContain("-L");
    expect(args).toContain("127.0.0.1:45000:127.0.0.1:44388");
    expect(args.indexOf("--")).toBeLessThan(args.indexOf("me@mini.local"));
    expect(args.at(-1)).toContain("--port");
  });
  it("quotes the remote command", () => {
    const args = sshArgs({ host: "h", port: 22 }, { localPort: 1, remotePort: 2, command: ["/Applications/Pre Form/PreFormServer", "--port", "2"] });
    expect(args.at(-1)).toBe("'/Applications/Pre Form/PreFormServer' '--port' '2'");
  });
});

describe.skipIf(isWin)("RemoteBackend", () => {
  it("starts the tunnel session, waits for READY, stages inputs and collects outputs", async () => {
    const { dir, log } = fakeSshBin();
    // Something must answer on the local forward port for the reachability check.
    const http = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"version":"x"}'); });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const localPort = (http.address() as { port: number }).port;
    const home = tmp();
    const cfg = makeConfig({ home, allowedPaths: [home], remote: { host: "me@mini", port: 22, serverPath: "/Applications/PreFormServer.app/Contents/MacOS/PreFormServer", spawn: true }, baseUrl: `http://127.0.0.1:${localPort}` });
    const backend = new RemoteBackend(cfg, { localPort, env: { ...process.env, PATH: `${dir}:${process.env["PATH"]}` } });
    try {
      await backend.ensureRunning();
      const calls = readFileSync(log, "utf8");
      expect(calls).toMatch(/ssh .*-L 127\.0\.0\.1:\d+:127\.0\.0\.1:44388 .*-- me@mini/);
      expect(calls).toContain("--port");

      const local = join(home, "part.stl");
      writeFileSync(local, "solid\n");
      const remote = await backend.stageInput(local);
      expect(remote).toMatch(/\/remote\/stage\/part\.stl$/);
      expect(readFileSync(remote, "utf8")).toBe("solid\n"); // fake scp copied it
      expect(await backend.stageInput(local)).toBe(remote); // cached

      const out = join(home, "job.form");
      const remoteOut = backend.remoteOutputPath(out);
      writeFileSync(remoteOut, "FORM");
      await backend.collectOutput(out);
      expect(readFileSync(out, "utf8")).toBe("FORM");
      expect(readFileSync(log, "utf8")).toMatch(/scp .*-oBatchMode=yes/);
    } finally {
      await backend.shutdown();
      http.close();
    }
    expect(readFileSync(log, "utf8")).toContain("rm -rf");
  });

  it("sanitizes staged file names", () => {
    const cfg = makeConfig({ remote: { host: "h", port: 22, spawn: false } });
    const b = new RemoteBackend(cfg, { localPort: 1 });
    expect(b.safeName("/tmp/my part (v2);rm.stl")).toBe("my_part__v2__rm.stl");
  });
});
