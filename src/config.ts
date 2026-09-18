/**
 * Runtime configuration.
 *
 * Everything comes from environment variables so the server works with zero
 * configuration in the common case (PreFormServer installed where we put it or
 * where Formlabs' zip lands, talking over loopback) and can be tuned without
 * code changes. Nothing here touches the network.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parsePathMap, type PathMapping, type PathStyle } from "./pathmap.js";

export type Platform = "darwin" | "win32" | "linux";

export const DEFAULT_PORT = 44388;
export const DOWNLOAD_PAGE = "https://formlabs.com/support/Formlabs-API-downloads-and-release-notes";

export type Credentials = { username: string; password: string } | { accessToken: string };

export interface RemoteConfig {
  /** `user@host` or `host`. Validated so it can never be parsed as an ssh option. */
  host: string;
  /** ssh port. */
  port: number;
  /** PreFormServer port on the remote machine. */
  remotePort?: number;
  /** Explicit path to the remote PreFormServer executable; otherwise well-known paths are tried. */
  serverPath?: string;
  /** Start PreFormServer through the ssh session (true) or only tunnel to one already running (false). */
  spawn: boolean;
}

export interface Config {
  platform: Platform;
  home: string;
  env: Record<string, string | undefined>;
  baseUrl: string;
  preformServerPath: string | undefined;
  preformServerPort: number;
  spawn: boolean;
  /** Extra command prefix used to launch PreFormServer, e.g. ["wine"] on Linux. */
  launcher: string[];
  /** How file paths are written for PreFormServer: as-is, or Wine's `Z:/...` view of this host. */
  pathStyle: PathStyle;
  /** Directory prefixes rewritten before a path is sent (container mounts). */
  pathMap: PathMapping[];
  pollIntervalMs: number;
  pollTimeoutMs: number;
  startupTimeoutMs: number;
  telemetry: boolean;
  allowedPaths: string[];
  allowHiddenPaths: boolean;
  allowRemoteLogin: boolean;
  /** Allow installing a PreFormServer whose signature cannot be checked on this platform. */
  installUnverified: boolean;
  credentials: Credentials | undefined;
  remote: RemoteConfig | undefined;
  /** Loggable view of the config: never includes credentials. */
  summary(): Record<string, unknown>;
}

export interface LoadOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: Platform;
  findServer?: (platform: Platform, home: string, env: Record<string, string | undefined>) => string | undefined;
}

function envBool(env: Record<string, string | undefined>, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function envNum(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  return n;
}

export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

/** Where we install PreFormServer ourselves. User-owned, no admin needed. */
export function managedInstallDir(platform: Platform, home: string, env: Record<string, string | undefined>): string {
  switch (platform) {
    case "darwin":
      return path.posix.join(home, "Library", "Application Support", "formlabs-local-mcp");
    case "win32": {
      const local = env["LOCALAPPDATA"] ?? path.win32.join(home, "AppData", "Local");
      return path.win32.join(local, "formlabs-local-mcp");
    }
    default: {
      const data = env["XDG_DATA_HOME"] ?? path.posix.join(home, ".local", "share");
      return path.posix.join(data, "formlabs-local-mcp");
    }
  }
}

/** Executable path relative to the managed install dir, per platform. */
export function managedExecutable(platform: Platform, home: string, env: Record<string, string | undefined>): string {
  const dir = managedInstallDir(platform, home, env);
  if (platform === "darwin") return path.posix.join(dir, "PreFormServer.app", "Contents", "MacOS", "PreFormServer");
  if (platform === "win32") return path.win32.join(dir, "PreFormServer", "PreFormServer.exe");
  return path.posix.join(dir, "PreFormServer", "PreFormServer.exe"); // run under Wine
}

/** Where PreFormServer may be, most specific first. */
export function candidatePaths(platform: Platform, home: string, env: Record<string, string | undefined>): string[] {
  const managed = managedExecutable(platform, home, env);
  if (platform === "darwin") {
    const p = path.posix;
    return [
      managed,
      "/Applications/PreFormServer.app/Contents/MacOS/PreFormServer",
      "/Applications/PreFormServer/PreFormServer.app/Contents/MacOS/PreFormServer",
      p.join(home, "Applications", "PreFormServer.app", "Contents", "MacOS", "PreFormServer"),
      p.join(home, "Applications", "PreFormServer", "PreFormServer.app", "Contents", "MacOS", "PreFormServer"),
    ];
  }
  if (platform === "win32") {
    const p = path.win32;
    const pf = env["ProgramFiles"] ?? "C:\\Program Files";
    const local = env["LOCALAPPDATA"] ?? p.join(home, "AppData", "Local");
    return [
      managed,
      p.join(pf, "Formlabs", "PreFormServer", "PreFormServer.exe"),
      p.join(pf, "PreFormServer", "PreFormServer.exe"),
      p.join(local, "Formlabs", "PreFormServer", "PreFormServer.exe"),
      p.join(local, "PreFormServer", "PreFormServer.exe"),
    ];
  }
  const p = path.posix;
  return [managed, "/opt/PreFormServer/PreFormServer.exe", p.join(home, "PreFormServer", "PreFormServer.exe")];
}

export function findPreformServer(platform: Platform, home: string, env: Record<string, string | undefined>): string | undefined {
  for (const c of candidatePaths(platform, home, env)) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      /* unreadable candidate: skip */
    }
  }
  return undefined;
}

export function isLoopback(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "" || host === "localhost" || host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * ssh interprets a leading "-" as an option, and shells interpret plenty more.
 * Only plain `user@host` / `host` shapes are accepted.
 */
export function validateRemoteHost(raw: string): string {
  const host = raw.trim();
  if (!/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) {
    throw new Error(`Invalid PREFORM_REMOTE_HOST ${JSON.stringify(raw)}: expected user@host or host`);
  }
  return host;
}

export function loadConfig(opts: LoadOptions = {}): Config {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? (process.platform as Platform);
  const home = opts.home ?? homedir();
  const findServer = opts.findServer ?? findPreformServer;

  const port = envNum(env, "PREFORM_SERVER_PORT", DEFAULT_PORT);
  const remoteRaw = env["PREFORM_REMOTE_HOST"];
  let remote: RemoteConfig | undefined;
  if (remoteRaw) {
    remote = {
      host: validateRemoteHost(remoteRaw),
      port: envNum(env, "PREFORM_REMOTE_PORT", 22),
      remotePort: envNum(env, "PREFORM_REMOTE_SERVER_PORT", DEFAULT_PORT),
      spawn: envBool(env, "PREFORM_REMOTE_SPAWN", true),
    };
    if (env["PREFORM_REMOTE_SERVER_PATH"]) remote.serverPath = env["PREFORM_REMOTE_SERVER_PATH"];
  }

  const explicitUrl = env["PREFORM_SERVER_URL"];
  const baseUrl = (explicitUrl || `http://127.0.0.1:${port}`).replace(/\/+$/, "");

  const explicitPath = env["PREFORM_SERVER_PATH"];
  const preformServerPath = explicitPath ? expandHome(explicitPath, home) : findServer(platform, home, env);
  const spawn = envBool(env, "PREFORM_SPAWN", true) && preformServerPath !== undefined && !explicitUrl && !remote;

  const launcherRaw = env["PREFORM_LAUNCHER"];
  let launcher: string[] = [];
  if (launcherRaw) launcher = launcherRaw.split(/\s+/).filter(Boolean);
  else if (platform === "linux" && preformServerPath?.toLowerCase().endsWith(".exe")) launcher = ["wine"];

  const usesWine = launcher.some((w) => /(^|[\\/])wine(64)?(\.exe)?$/i.test(w));
  const styleRaw = (env["PREFORM_SERVER_PATH_STYLE"] ?? "auto").trim().toLowerCase();
  let pathStyle: PathStyle;
  if (styleRaw === "wine" || styleRaw === "native") pathStyle = styleRaw;
  else if (styleRaw === "auto" || styleRaw === "") pathStyle = spawn && usesWine ? "wine" : "native";
  else throw new Error(`PREFORM_SERVER_PATH_STYLE must be auto, native or wine, got ${JSON.stringify(env["PREFORM_SERVER_PATH_STYLE"])}`);
  const pathMap = parsePathMap(env["PREFORM_PATH_MAP"], home);

  const sep = platform === "win32" ? ";" : ":";
  const allowedRaw = env["FORMLABS_ALLOWED_PATHS"];
  const allowedPaths = allowedRaw?.trim()
    ? allowedRaw
        .split(sep)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => path.resolve(expandHome(s, home)))
    : [home];

  let credentials: Credentials | undefined;
  if (env["FORMLABS_ACCESS_TOKEN"]) credentials = { accessToken: env["FORMLABS_ACCESS_TOKEN"] };
  else if (env["FORMLABS_USERNAME"] && env["FORMLABS_PASSWORD"]) {
    credentials = { username: env["FORMLABS_USERNAME"], password: env["FORMLABS_PASSWORD"] };
  }

  const cfg: Config = {
    platform,
    home,
    env,
    baseUrl,
    preformServerPath,
    preformServerPort: port,
    spawn,
    launcher,
    pathStyle,
    pathMap,
    pollIntervalMs: envNum(env, "PREFORM_POLL_INTERVAL", 1) * 1000,
    pollTimeoutMs: envNum(env, "PREFORM_POLL_TIMEOUT", 600) * 1000,
    startupTimeoutMs: envNum(env, "PREFORM_STARTUP_TIMEOUT", 120) * 1000,
    telemetry: envBool(env, "PREFORM_TELEMETRY", false),
    allowedPaths,
    allowHiddenPaths: envBool(env, "FORMLABS_ALLOW_HIDDEN_PATHS", false),
    allowRemoteLogin: envBool(env, "FORMLABS_ALLOW_REMOTE_LOGIN", false),
    installUnverified: envBool(env, "PREFORM_INSTALL_UNVERIFIED", false),
    credentials,
    remote,
    summary() {
      return {
        platform: this.platform,
        baseUrl: this.baseUrl,
        preformServerPath: this.preformServerPath,
        spawn: this.spawn,
        launcher: this.launcher,
        pathStyle: this.pathStyle,
        pathMap: this.pathMap.map((m) => `${m.local}=${m.remote}`),
        allowedPaths: this.allowedPaths,
        allowHiddenPaths: this.allowHiddenPaths,
        telemetry: this.telemetry,
        remote: this.remote ? { host: this.remote.host, port: this.remote.port, spawn: this.remote.spawn } : undefined,
        credentials: this.credentials ? "configured" : "none",
      };
    },
  };
  return cfg;
}
