#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   formlabs-local-mcp                 serve MCP over stdio (default)
 *   formlabs-local-mcp install-preform download, verify and install PreFormServer
 *   formlabs-local-mcp doctor          report setup status and the latest Formlabs release
 *   formlabs-local-mcp --version
 */

import { existsSync } from "node:fs";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { fetchReleases, installedVersion, installPreformServer, chooseRelease } from "./installer.js";
import { serve, VERSION } from "./server.js";

const HELP = `formlabs-local-mcp ${VERSION}

Usage:
  formlabs-local-mcp                  Serve MCP over stdio (what MCP clients run)
  formlabs-local-mcp install-preform  Download, verify and install PreFormServer
  formlabs-local-mcp doctor           Check the setup and report the latest release
  formlabs-local-mcp --version

Docs: https://mkebiclioglu.github.io/formlabs-claude-skills/
`;

export type Command = "serve" | "install-preform" | "doctor" | "version" | "help";

export function parseArgs(argv: string[]): { command: Command; force: boolean } {
  const [first, ...rest] = argv;
  const force = rest.includes("--force") || first === "--force";
  switch (first) {
    case undefined:
    case "serve":
      return { command: "serve", force };
    case "install-preform":
    case "install":
      return { command: "install-preform", force };
    case "doctor":
    case "status":
      return { command: "doctor", force };
    case "--version":
    case "-v":
    case "version":
      return { command: "version", force };
    default:
      return { command: "help", force };
  }
}

async function doctor(): Promise<number> {
  const cfg = loadConfig();
  const exe = cfg.preformServerPath;
  const installed = !!exe && existsSync(exe);
  const version = installed ? await installedVersion(exe, cfg) : undefined;
  console.log(`formlabs-local-mcp ${VERSION} on ${cfg.platform}`);
  console.log(`PreFormServer: ${installed ? `installed at ${exe} (version ${version ?? "unknown"})` : "NOT INSTALLED"}`);
  console.log(`Mode: ${cfg.remote ? `remote via ssh ${cfg.remote.host}` : cfg.spawn ? "local, started on demand" : `connect to ${cfg.baseUrl}`}`);
  console.log(`Allowed paths: ${cfg.allowedPaths.join(", ")}`);
  const mapped = cfg.pathMap.map((m) => `${m.local} -> ${m.remote}`);
  console.log(`File paths: ${cfg.pathStyle === "wine" ? "rewritten to Wine's Z: drive" : "sent as-is"}${mapped.length ? `; mapped: ${mapped.join(", ")}` : ""}`);
  if (cfg.platform === "linux" && !cfg.remote && exe?.toLowerCase().endsWith(".exe")) {
    console.log(`Linux: PreFormServer is the Windows build, run through ${cfg.launcher.join(" ") || "wine"} (Wine 11.5+ and Xvfb needed; https://github.com/mkebiclioglu/preform-linux packages this as a container)`);
  }
  console.log(`Formlabs account: ${cfg.credentials ? "configured" : "not configured (only needed for remote printing)"}`);
  try {
    const { release } = chooseRelease(await fetchReleases(), cfg.platform);
    const note = version === release.version ? "up to date" : installed ? `update available: run formlabs-local-mcp install-preform` : "run: formlabs-local-mcp install-preform";
    console.log(`Latest PreFormServer: ${release.version} (API ${release.apiVersion ?? "?"}, ${release.date ?? "?"}) - ${note}`);
  } catch (err) {
    console.log(`Latest PreFormServer: could not check (${(err as Error).message})`);
  }
  return installed ? 0 : 1;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { command, force } = parseArgs(argv);
  if (command === "version") {
    console.log(VERSION);
    return;
  }
  if (command === "help") {
    console.log(HELP);
    process.exitCode = argv[0] === "--help" || argv[0] === "-h" ? 0 : 2;
    return;
  }
  if (command === "doctor") {
    process.exitCode = await doctor();
    return;
  }
  if (command === "install-preform") {
    const cfg = loadConfig();
    const result = await installPreformServer(cfg, { force });
    console.log(`${result.status === "installed" ? "Installed" : "Already installed"}: PreFormServer ${result.version}${result.apiVersion ? ` (Local API ${result.apiVersion})` : ""}`);
    console.log(result.executable);
    return;
  }
  const app = createApp(loadConfig());
  await serve(app);
}

const invokedDirectly = process.argv[1] && /formlabs-local-mcp(\.js)?$|[\\/]index\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
