/**
 * Local PreFormServer lifecycle.
 *
 * We start PreFormServer ourselves on the first tool call, wait for its
 * `READY FOR INPUT` line, and stop it when the MCP server exits. That way its
 * unauthenticated HTTP port is only open while an MCP client is connected.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { type Backend, isReachable, waitUntilReachable } from "./backend.js";
import { DOWNLOAD_PAGE, type Config } from "./config.js";
import { toServerPath } from "./pathmap.js";

export const READY_TOKEN = "READY FOR INPUT";

export function notInstalledMessage(cfg: Config): string {
  return (
    `PreFormServer is not installed. Ask the user for permission, then call the install_preform_server tool ` +
    `(or run: npx -y formlabs-local-mcp install-preform). It downloads PreFormServer from ${DOWNLOAD_PAGE} and verifies ` +
    `Formlabs' code signature. Alternatively set PREFORM_SERVER_PATH to an existing PreFormServer executable. ` +
    `(platform: ${cfg.platform})`
  );
}

export class LocalBackend implements Backend {
  readonly mode = "local" as const;
  private proc: ChildProcess | undefined;

  constructor(private readonly cfg: Config, private readonly log: (line: string) => void = (l) => console.error(l)) {}

  async ensureRunning(): Promise<void> {
    const cfg = this.cfg;
    if (this.proc && this.proc.exitCode === null) {
      if (await isReachable(cfg.baseUrl)) return;
      // Alive but not answering (renderer crash on a headless machine, hung listener): replace it.
      this.log("[preform] PreFormServer is running but not answering; restarting it");
      await this.shutdown();
    }
    if (await isReachable(cfg.baseUrl)) {
      this.log(`[preform] already answering at ${cfg.baseUrl}; not starting another`);
      return;
    }
    if (!cfg.spawn) {
      if (!cfg.preformServerPath && !cfg.env["PREFORM_SERVER_URL"] && cfg.env["PREFORM_SPAWN"] !== "0") throw new Error(notInstalledMessage(cfg));
      await waitUntilReachable(cfg.baseUrl, 3000).catch(() => {
        throw new Error(`PreFormServer at ${cfg.baseUrl} is not reachable. Spawning is disabled (PREFORM_SPAWN=0 or PREFORM_SERVER_URL set), so start PreFormServer yourself and try again.`);
      });
      return;
    }
    const exe = cfg.preformServerPath!;
    if (!existsSync(exe)) throw new Error(`PreFormServer not found at ${exe}. ${notInstalledMessage(cfg)}`);
    await this.spawnServer(exe);
    await waitUntilReachable(cfg.baseUrl, 30_000);
  }

  private async spawnServer(exe: string): Promise<void> {
    const cfg = this.cfg;
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (!cfg.telemetry) env["DISABLE_PREFORMSERVER_TELEMETRY"] = "1";
    if (cfg.launcher.some((w) => /(^|[\\/])wine(64)?$/.test(w))) {
      // Same headless defaults as preform-linux: quiet Wine, no Mono/Gecko prompts, Qt on the bundled software renderer.
      env["WINEDEBUG"] ??= "-all";
      env["WINEDLLOVERRIDES"] ??= "mscoree=d;mshtml=d";
      env["QT_OPENGL"] ??= "software";
    }
    const argv = [...cfg.launcher, exe, "--port", String(cfg.preformServerPort)];
    this.log(`[preform] starting ${argv.join(" ")}`);
    const proc = spawn(argv[0]!, argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.proc = proc;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`PreFormServer did not become ready within ${cfg.startupTimeoutMs / 1000}s. On macOS the first launch can be slow while Gatekeeper verifies the app; try again, or raise PREFORM_STARTUP_TIMEOUT.`));
      }, cfg.startupTimeoutMs);
      const onLine = (line: string) => {
        this.log(`[preform] ${line}`); // stdout is the MCP transport; everything from PreFormServer goes to stderr
        if (line.includes(READY_TOKEN)) {
          clearTimeout(timer);
          resolve();
        }
      };
      createInterface({ input: proc.stdout! }).on("line", onLine);
      createInterface({ input: proc.stderr! }).on("line", onLine);
      proc.once("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Could not start PreFormServer (${argv[0]}): ${err.message}`));
      });
      proc.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`PreFormServer exited with code ${code} before becoming ready`));
      });
    });
    try {
      await ready;
    } catch (err) {
      await this.shutdown();
      throw err;
    }
    proc.once("exit", (code, signal) => {
      if (this.proc === proc) {
        this.log(`[preform] PreFormServer exited unexpectedly (code ${code}, signal ${signal}); it will be restarted on the next call`);
        this.proc = undefined;
      }
    });
  }

  async shutdown(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    if (!proc || proc.exitCode !== null) return;
    const exited = new Promise<void>((r) => proc.once("exit", () => r()));
    proc.kill("SIGTERM");
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000));
    if ((await Promise.race([exited, timeout])) === "timeout") {
      proc.kill("SIGKILL");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
  }

  stageInput(localPath: string): Promise<string> {
    return Promise.resolve(toServerPath(localPath, this.cfg.pathStyle, this.cfg.pathMap));
  }
  outputPath(localPath: string): Promise<string> {
    return Promise.resolve(toServerPath(localPath, this.cfg.pathStyle, this.cfg.pathMap));
  }
  collectOutput(): Promise<void> {
    return Promise.resolve();
  }
}
