/**
 * Remote PreFormServer over ssh.
 *
 * One ssh session does two jobs: it forwards a loopback port to PreFormServer
 * on the remote machine, and (by default) it runs PreFormServer as the remote
 * command, so the server dies with the session. Files are copied with scp into
 * a per-session staging directory under the remote user's home.
 *
 * Security notes:
 * - BatchMode: keys only, never an interactive password prompt.
 * - The host string is validated so it can never be read as an ssh option, and
 *   it is always placed after `--`.
 * - The forward binds 127.0.0.1 only; nothing else on this machine's network
 *   can reach the tunnel.
 * - Staged file names are sanitized to [A-Za-z0-9._-].
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { type Backend, waitUntilReachable } from "./backend.js";
import { validateRemoteHost, type Config, type RemoteConfig } from "./config.js";
import { READY_TOKEN } from "./preform.js";
import { createInterface } from "node:readline";

const run = promisify(execFile);

const REMOTE_CANDIDATES = [
  '"$HOME/Library/Application Support/formlabs-local-mcp/PreFormServer.app/Contents/MacOS/PreFormServer"',
  "/Applications/PreFormServer.app/Contents/MacOS/PreFormServer",
  "/Applications/PreFormServer/PreFormServer.app/Contents/MacOS/PreFormServer",
  '"$HOME/Applications/PreFormServer.app/Contents/MacOS/PreFormServer"',
];

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface TunnelSpec {
  localPort: number;
  remotePort: number;
  /** Remote command: argv (quoted for you) or a raw shell snippet. Omit for tunnel-only (-N). */
  command?: string[] | string;
}

export function sshArgs(remote: Pick<RemoteConfig, "host" | "port">, spec: TunnelSpec): string[] {
  const host = validateRemoteHost(remote.host);
  const args = [
    `-p${remote.port}`,
    "-oBatchMode=yes",
    "-oExitOnForwardFailure=yes",
    "-oServerAliveInterval=15",
    "-oServerAliveCountMax=3",
    "-L",
    `127.0.0.1:${spec.localPort}:127.0.0.1:${spec.remotePort}`,
  ];
  if (!spec.command) args.push("-N");
  args.push("--", host);
  if (spec.command) args.push(Array.isArray(spec.command) ? spec.command.map(shellQuote).join(" ") : spec.command);
  return args;
}

/** Shell snippet that starts PreFormServer from the first well-known path that exists. */
export function remoteStartSnippet(remotePort: number, serverPath?: string, telemetry = false): string {
  const env = telemetry ? "" : "DISABLE_PREFORMSERVER_TELEMETRY=1 ";
  const candidates = serverPath ? [shellQuote(serverPath)] : REMOTE_CANDIDATES;
  const tries = candidates.map((c) => `if [ -x ${c} ]; then ${env}exec ${c} --port ${remotePort}; fi`).join("; ");
  return `${tries}; echo NO_PREFORMSERVER; exit 3`;
}

export interface RemoteOptions {
  localPort: number;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export class RemoteBackend implements Backend {
  readonly mode = "remote" as const;
  private readonly remote: RemoteConfig;
  private session: ChildProcess | undefined;
  private stagingDir: string | undefined;
  private readonly staged = new Map<string, { remote: string; mtimeMs: number }>();
  private readonly log: (line: string) => void;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sessionId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  constructor(private readonly cfg: Config, private readonly opts: RemoteOptions) {
    if (!cfg.remote) throw new Error("RemoteBackend requires cfg.remote");
    this.remote = cfg.remote;
    this.log = opts.log ?? ((l) => console.error(l));
    this.env = opts.env ?? process.env;
  }

  private sshBase(): string[] {
    return [`-p${this.remote.port}`, "-oBatchMode=yes", "-oServerAliveInterval=15"];
  }

  async ensureRunning(): Promise<void> {
    if (this.session && this.session.exitCode === null) return;
    const remotePort = this.remote.remotePort ?? 44388;
    const spec: TunnelSpec = { localPort: this.opts.localPort, remotePort };
    if (this.remote.spawn) spec.command = remoteStartSnippet(remotePort, this.remote.serverPath, this.cfg.telemetry);
    const args = sshArgs(this.remote, spec);
    this.log(`[remote] ssh ${args.join(" ")}`);
    const proc = spawn("ssh", args, { env: this.env, stdio: ["ignore", "pipe", "pipe"] });
    this.session = proc;
    if (this.remote.spawn) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Remote PreFormServer on ${this.remote.host} did not become ready within ${this.cfg.startupTimeoutMs / 1000}s`)), this.cfg.startupTimeoutMs);
        const onLine = (line: string) => {
          this.log(`[remote] ${line}`);
          if (line.includes(READY_TOKEN)) {
            clearTimeout(timer);
            resolve();
          }
          if (line.includes("NO_PREFORMSERVER")) {
            clearTimeout(timer);
            reject(new Error(`No PreFormServer found on ${this.remote.host}. Install it there (npx -y formlabs-local-mcp install-preform) or set PREFORM_REMOTE_SERVER_PATH.`));
          }
        };
        createInterface({ input: proc.stdout! }).on("line", onLine);
        createInterface({ input: proc.stderr! }).on("line", onLine);
        proc.once("error", (e) => {
          clearTimeout(timer);
          reject(new Error(`Could not run ssh: ${e.message}`));
        });
        proc.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`ssh to ${this.remote.host} exited with code ${code} (check keys, host key, and that PreFormServer's port is free)`));
        });
      }).catch(async (err) => {
        await this.shutdown();
        throw err;
      });
    }
    await waitUntilReachable(this.cfg.baseUrl, 30_000);
  }

  private async ssh(command: string): Promise<string> {
    const { stdout } = await run("ssh", [...this.sshBase(), "--", validateRemoteHost(this.remote.host), command], { env: this.env });
    return stdout;
  }

  private async scp(from: string, to: string): Promise<void> {
    await run("scp", [`-P${this.remote.port}`, "-oBatchMode=yes", "-q", "--", from, to], { env: this.env });
  }

  async ensureStaging(): Promise<string> {
    if (this.stagingDir) return this.stagingDir;
    const dir = `$HOME/.formlabs-local-mcp/staging/${this.sessionId}`;
    const out = await this.ssh(`mkdir -p "${dir}" && cd "${dir}" && pwd`);
    const abs = out.trim().split("\n").pop() ?? "";
    if (!abs.startsWith("/")) throw new Error(`Could not create a staging directory on ${this.remote.host}`);
    this.stagingDir = abs;
    return abs;
  }

  safeName(localPath: string): string {
    return path.basename(localPath).replace(/[^A-Za-z0-9._-]/g, "_");
  }

  private remoteFor(localPath: string): string {
    if (!this.stagingDir) throw new Error("staging directory not ready");
    return `${this.stagingDir}/${this.safeName(localPath)}`;
  }

  async stageInput(localPath: string): Promise<string> {
    const mtimeMs = statSync(localPath).mtimeMs;
    const cached = this.staged.get(localPath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.remote;
    await this.ensureStaging();
    const remote = this.remoteFor(localPath);
    await this.scp(localPath, `${validateRemoteHost(this.remote.host)}:${remote}`);
    this.staged.set(localPath, { remote, mtimeMs });
    return remote;
  }

  remoteOutputPath(localPath: string): string {
    return this.remoteFor(localPath);
  }

  async outputPath(localPath: string): Promise<string> {
    await this.ensureStaging();
    return this.remoteOutputPath(localPath);
  }

  async collectOutput(localPath: string): Promise<void> {
    await this.scp(`${validateRemoteHost(this.remote.host)}:${this.remoteFor(localPath)}`, localPath);
  }

  async shutdown(): Promise<void> {
    if (this.stagingDir) {
      const dir = this.stagingDir;
      this.stagingDir = undefined;
      await this.ssh(`rm -rf "${dir}"`).catch(() => {});
    }
    const proc = this.session;
    this.session = undefined;
    if (proc && proc.exitCode === null) {
      proc.kill("SIGTERM");
      await Promise.race([new Promise((r) => proc.once("exit", r)), new Promise((r) => setTimeout(r, 5000))]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
  }
}
