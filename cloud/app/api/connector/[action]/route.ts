/**
 * API used by `formlabs-local-mcp connect`. Authenticated with a connector
 * token (`fb_conn_...`) bound to one connected environment.
 *
 *   POST hello      {version, hostname, platform, preform}   -> {environment}
 *   GET  poll       long-polls up to 25 s for one relay request
 *   POST result     {id, result} | {id, error}
 *   POST progress   {id, progress, message}
 *   POST heartbeat  {devices?: [...], preform?: {...}}
 */
import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { serviceClient } from "@/lib/supabase/service";
import { bearerFrom, resolveToken } from "@/lib/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const POLL_MS = 25_000;

function json(status: number, body: unknown) {
  return NextResponse.json(body, { status });
}

export async function GET(request: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (action !== "poll") return json(404, { error: "unknown action" });
  const db = await serviceClient();
  const token = await resolveToken(db, bearerFrom(request) ?? "", "connector");
  if (!token) return json(401, { error: "invalid connector token" });
  const deadline = Date.now() + POLL_MS;
  await db.from("environments").update({ connector_last_seen_at: new Date().toISOString() }).eq("id", token.env.id);
  for (;;) {
    const { data, error } = await db.rpc("claim_relay_request", { env: token.env.id });
    if (error) return json(500, { error: error.message });
    const row = Array.isArray(data) ? data[0] : undefined;
    if (row) return json(200, { request: { id: row["id"], tool: row["tool"], args: row["args"] } });
    if (Date.now() >= deadline) return json(200, { request: null });
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  const db = await serviceClient();
  const token = await resolveToken(db, bearerFrom(request) ?? "", "connector");
  if (!token) return json(401, { error: "invalid connector token" });
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* empty body is fine for some actions */
  }
  const env = token.env;
  const now = new Date().toISOString();
  switch (action) {
    case "hello": {
      const info = { version: body["version"] ?? null, hostname: body["hostname"] ?? null, platform: body["platform"] ?? null, preform: body["preform"] ?? null, connected_at: now };
      await db.from("environments").update({ connector_last_seen_at: now, connector_info: info }).eq("id", env.id);
      await logAudit(db, { user_id: token.user_id, environment_id: env.id, actor: "connector", action: "connector.connected", target: env.name, details: info });
      // Any request left 'running' by a previous connector process is lost.
      await db.from("relay_requests").update({ status: "failed", error: "connector restarted before finishing", finished_at: now }).eq("environment_id", env.id).eq("status", "running");
      return json(200, { environment: { id: env.id, name: env.name, kind: env.kind }, poll_interval_ms: 0, heartbeat_interval_ms: 30_000 });
    }
    case "heartbeat": {
      const patch: Record<string, unknown> = { connector_last_seen_at: now };
      if (Array.isArray(body["devices"])) patch["devices_snapshot"] = body["devices"];
      if (body["preform"] && typeof body["preform"] === "object") patch["connector_info"] = { ...(env.connector_info ?? {}), preform: body["preform"], last_heartbeat: now };
      await db.from("environments").update(patch).eq("id", env.id);
      return json(200, { ok: true });
    }
    case "progress": {
      await db.from("relay_requests").update({ progress: Number(body["progress"] ?? 0), progress_message: String(body["message"] ?? "") }).eq("id", String(body["id"])).eq("environment_id", env.id).eq("status", "running");
      return json(200, { ok: true });
    }
    case "result": {
      const id = String(body["id"] ?? "");
      if (!id) return json(400, { error: "id required" });
      const patch = body["error"] !== undefined && body["error"] !== null
        ? { status: "failed", error: String(body["error"]), finished_at: now }
        : { status: "done", result: (body["result"] ?? null) as never, finished_at: now, progress: 1 };
      const { error } = await db.from("relay_requests").update(patch).eq("id", id).eq("environment_id", env.id);
      if (error) return json(500, { error: error.message });
      return json(200, { ok: true });
    }
    default:
      return json(404, { error: "unknown action" });
  }
}
