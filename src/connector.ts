/**
 * `formlabs-local-mcp connect`: the local connector for Formbridge.
 *
 * Keeps one outbound long-poll open to the hosted service, executes the tool
 * calls it hands out against the local PreFormServer using the very same
 * tool handlers the stdio server uses, and posts results back. Nothing on
 * the local network is exposed; the machine only makes outbound HTTPS calls.
 */

import { hostname } from "node:os";
import type { AppContext } from "./app.js";
import { PreFormError } from "./client.js";
import { PathNotAllowed } from "./paths.js";
import { installedVersion } from "./installer.js";
import { existsSync } from "node:fs";
import { callTool } from "./tools.js";

export interface ConnectorOptions {
  url: string;
  token: string;
  version: string;
  log?: (line: string) => void;
  /** Stop after this many idle polls (tests). */
  maxPolls?: number;
  heartbeatMs?: number;
  fetchImpl?: typeof fetch;
}

export function parseConnectArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): { url: string; token: string } {
  let url = env["FORMBRIDGE_URL"] ?? "https://formbridge.vercel.app";
  let token = env["FORMBRIDGE_TOKEN"] ?? "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--url" && argv[i + 1]) url = argv[++i]!;
    else if (a.startsWith("--url=")) url = a.slice(6);
    else if (a === "--token" && argv[i + 1]) token = argv[++i]!;
    else if (a.startsWith("--token=")) token = a.slice(8);
  }
  url = url.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) throw new Error(`--url must be an http(s) URL, got ${url}`);
  if (!token) throw new Error("A connector token is required: --token fb_conn_... (or FORMBRIDGE_TOKEN). Create one in the Formbridge dashboard under your connected environment.");
  if (!token.startsWith("fb_conn_")) throw new Error("That is not a connector token (expected fb_conn_...). MCP tokens (fb_mcp_...) are for MCP clients.");
  if (url.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) throw new Error("Refusing to send the connector token over plain http to a non-local host.");
  return { url, token };
}

interface RelayRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

function errorText(err: unknown): string {
  if (err instanceof PreFormError) return `${err.code ?? "error"}: ${err.detail}`;
  if (err instanceof PathNotAllowed) return `PATH_NOT_ALLOWED: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export async function runConnector(app: AppContext, opts: ConnectorOptions): Promise<void> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const f = opts.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${opts.token}`, "content-type": "application/json" };
  const api = async (method: string, action: string, body?: unknown, timeoutMs = 40_000): Promise<Record<string, unknown>> => {
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const resp = await f(`${opts.url}/api/connector/${action}`, init);
    const text = await resp.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* non-JSON */
    }
    if (!resp.ok) throw new Error(`${action}: HTTP ${resp.status} ${String(data["error"] ?? text).slice(0, 200)}`);
    return data;
  };

  const preformInfo = async () => {
    const exe = app.config.preformServerPath;
    const installed = !!exe && existsSync(exe);
    return { installed, executable: exe ?? null, version: installed ? ((await installedVersion(exe, app.config)) ?? null) : null, mode: app.backend.mode };
  };

  const hello = await api("POST", "hello", { version: opts.version, hostname: hostname(), platform: process.platform, preform: await preformInfo() });
  const env = hello["environment"] as { id: string; name: string } | undefined;
  log(`[connector] connected to ${opts.url} as environment "${env?.name ?? "?"}" (connector ${opts.version})`);
  const preform = await preformInfo();
  log(preform.installed ? `[connector] PreFormServer ${preform.version ?? "?"} at ${preform.executable}` : "[connector] PreFormServer is not installed yet; the agent can request install_preform_server (needs your approval) or run: formlabs-local-mcp install-preform");

  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  // Heartbeat with the device list so the dashboard can show real printers.
  const heartbeatMs = opts.heartbeatMs ?? Number(hello["heartbeat_interval_ms"] ?? 30_000);
  let lastHeartbeat = 0;
  const heartbeat = async () => {
    if (Date.now() - lastHeartbeat < heartbeatMs) return;
    lastHeartbeat = Date.now();
    let devices: unknown = undefined;
    try {
      const out = (await app.client.get("/devices/")) as unknown;
      devices = Array.isArray(out) ? out : Array.isArray((out as { devices?: unknown })?.devices) ? (out as { devices: unknown[] }).devices : undefined;
    } catch {
      /* PreFormServer not running: heartbeat without devices */
    }
    await api("POST", "heartbeat", { devices, preform: await preformInfo() }).catch((e) => log(`[connector] heartbeat failed: ${errorText(e)}`));
  };

  let polls = 0;
  let backoff = 1000;
  while (!stopped) {
    if (opts.maxPolls !== undefined && polls >= opts.maxPolls) break;
    polls++;
    await heartbeat();
    let req: RelayRequest | null = null;
    try {
      const data = await api("GET", "poll");
      req = (data["request"] as RelayRequest | null) ?? null;
      backoff = 1000;
    } catch (err) {
      log(`[connector] poll failed: ${errorText(err)}; retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
      continue;
    }
    if (!req) continue;
    const current = req;
    log(`[connector] ${current.tool} ${JSON.stringify(current.args).slice(0, 200)}`);
    const started = Date.now();
    let lastProgressAt = 0;
    const progress = async (fraction: number, message: string) => {
      if (Date.now() - lastProgressAt < 2000) return;
      lastProgressAt = Date.now();
      await api("POST", "progress", { id: current.id, progress: fraction, message }).catch(() => {});
    };
    try {
      const result = await callTool(app, current.tool, current.args, { progress, signal: new AbortController().signal });
      await api("POST", "result", { id: current.id, result: result ?? null });
      log(`[connector] ${current.tool} done in ${Date.now() - started} ms`);
    } catch (err) {
      const text = errorText(err);
      log(`[connector] ${current.tool} failed: ${text}`);
      await api("POST", "result", { id: current.id, error: text }).catch((e) => log(`[connector] could not report result: ${errorText(e)}`));
    }
  }
  log("[connector] stopped");
  await app.close().catch(() => {});
}
