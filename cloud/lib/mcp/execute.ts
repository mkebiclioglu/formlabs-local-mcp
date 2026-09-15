/**
 * Runs one tool call for an environment: policy check, approval gate,
 * dispatch to the simulator or the connector relay, activity logging.
 * Used by the MCP endpoint and by the dashboard when a human approves.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit, redactArgs, summarizeResult } from "../audit";
import { effectivePolicy, loadPolicies, policyTable } from "../policy";
import { connectorOnline, getOperation, RelayError, relayTool } from "../relay";
import { SimError } from "../sim/engine";
import * as S from "../sim/store";
import type { EnvRow } from "../sim/store";
import { runSimTool } from "../sim/tools";
import { summarizeCall, toolByName } from "./catalog";

export interface CallContext {
  db: SupabaseClient;
  env: EnvRow;
  tokenId: string | null;
  userId: string;
  clientName?: string;
  /** How long this HTTP request may still run. */
  budgetMs: number;
  progress?: (fraction: number, message: string) => Promise<void>;
}

export class ToolError extends Error {
  constructor(public readonly code: string, message: string, public readonly data?: unknown) {
    super(message);
    this.name = "ToolError";
  }
}

export function errorInfo(err: unknown): { code: string; message: string } {
  if (err instanceof ToolError) return { code: err.code, message: err.message };
  if (err instanceof SimError) return { code: err.code, message: err.message };
  if (err instanceof RelayError) return { code: err.code, message: err.message };
  const e = err as { code?: string; message?: string; details?: string; hint?: string };
  return { code: e?.code ?? "ERROR", message: e?.message ?? String(err) };
}

const APPROVAL_WAIT_MS = 50_000;

/** The unguarded execution path. */
export async function executeTool(ctx: CallContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  const { db, env } = ctx;
  switch (name) {
    case "get_environment": {
      const policies = await loadPolicies(db, env.id);
      return {
        id: env.id,
        name: env.name,
        kind: env.kind,
        simulated: env.kind === "simulated",
        simulation_speed: env.kind === "simulated" ? Number(env.sim_speed) : null,
        connector: env.kind === "connected" ? { online: connectorOnline(env.connector_last_seen_at), last_seen_at: env.connector_last_seen_at, info: env.connector_info } : null,
        tools_requiring_approval: policyTable(policies).filter((p) => p.mode === "approve").map((p) => p.tool),
        tools_denied: policyTable(policies).filter((p) => p.mode === "deny").map((p) => p.tool),
      };
    }
    case "list_print_jobs": {
      if (env.kind === "simulated") await S.loadFarm(db, env);
      let jobs = await S.listJobs(db, env.id, Number(args["limit"] ?? 25) + 50);
      if (typeof args["status"] === "string") jobs = jobs.filter((j) => j.status === args["status"]);
      return { jobs: jobs.slice(0, Number(args["limit"] ?? 25)).map(jobPayload), count: jobs.length };
    }
    case "get_print_job": {
      if (env.kind === "simulated") await S.loadFarm(db, env);
      const job = await S.getJob(db, env.id, String(args["job_id"]));
      if (!job) throw new ToolError("JOB_NOT_FOUND", `No print job ${args["job_id"]}`);
      return jobPayload(job);
    }
    case "get_approval": {
      const { data } = await db.from("approvals").select("*").eq("environment_id", env.id).eq("id", String(args["approval_id"])).maybeSingle();
      if (!data) throw new ToolError("APPROVAL_NOT_FOUND", `No approval ${args["approval_id"]}`);
      return approvalPayload(data);
    }
    case "get_operation":
      return getOperation(db, env.id, String(args["operation_id"]));
  }
  if (env.kind === "simulated") return runSimTool(db, env, name, { ...args, __token_id: ctx.tokenId });
  // Connected environment: relay to the connector. print_to_printer also gets recorded as a job.
  const result = await relayTool(db, env, name, args, { timeoutMs: Math.max(5_000, ctx.budgetMs - 5_000), onProgress: ctx.progress });
  if (name === "print_to_printer") {
    const r = (result ?? {}) as Record<string, unknown>;
    await db.from("print_jobs").insert({ environment_id: env.id, printer_serial: String(args["printer"]), name: String(args["job_name"]), status: "submitted", source: "mcp", token_id: ctx.tokenId, external_job_id: r["job_id"] ? String(r["job_id"]) : null, scene_snapshot: { scene_id: args["scene_id"] ?? "default", response: r } });
  }
  return result;
}

export interface GatedResult {
  result: unknown;
  status: "ok" | "pending_approval";
}

/** Policy-aware execution: allow, deny, or park the call as an approval. */
export async function gatedCall(ctx: CallContext, name: string, rawArgs: Record<string, unknown>): Promise<GatedResult> {
  const { db, env } = ctx;
  const def = toolByName(name);
  if (!def) throw new ToolError("UNKNOWN_TOOL", `Unknown tool ${name}`);
  const parsed = def.input.safeParse(rawArgs ?? {});
  if (!parsed.success) throw new ToolError("INVALID_ARGUMENTS", `Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const args = parsed.data as Record<string, unknown>;
  const started = Date.now();
  const policies = await loadPolicies(db, env.id);
  const mode = effectivePolicy(policies, name);
  const summary = summarizeCall(name, args);

  if (mode === "deny") {
    await logActivity(ctx, name, args, { status: "denied", error: "Denied by environment policy", started });
    throw new ToolError("DENIED_BY_POLICY", `${name} is disabled for this environment by its owner. Ask them to change the policy in the dashboard if needed.`);
  }

  if (mode === "approve") {
    const { data: approval, error } = await db.from("approvals").insert({ environment_id: env.id, token_id: ctx.tokenId, tool: name, args, summary }).select("*").single();
    if (error) throw error;
    const approvalId = String(approval["id"]);
    await logAudit(db, { user_id: ctx.userId, environment_id: env.id, actor: "agent", action: "approval.requested", target: approvalId, details: { tool: name, summary } });
    const activityId = await logActivity(ctx, name, args, { status: "pending_approval", started, approvalId });
    // Give the human a moment: many approvals happen while the agent waits.
    const waitUntil = Math.min(Date.now() + APPROVAL_WAIT_MS, started + Math.max(0, ctx.budgetMs - 10_000));
    while (Date.now() < waitUntil) {
      await new Promise((r) => setTimeout(r, 2000));
      const { data: row } = await db.from("approvals").select("status, result, error").eq("id", approvalId).single();
      if (!row || row["status"] === "pending") continue;
      if (row["status"] === "executed") {
        await patchActivity(db, activityId, { status: "ok", duration_ms: Date.now() - started, result_summary: summarizeResult(row["result"]) });
        return { result: { approval_id: approvalId, approved: true, ...(typeof row["result"] === "object" && row["result"] ? (row["result"] as object) : { result: row["result"] }) }, status: "ok" };
      }
      if (row["status"] === "denied") {
        await patchActivity(db, activityId, { status: "denied", duration_ms: Date.now() - started, error: "Denied by user" });
        throw new ToolError("DENIED_BY_USER", `The user denied "${summary}" in the dashboard. Do not retry without asking the user.`);
      }
      if (row["status"] === "failed") {
        await patchActivity(db, activityId, { status: "error", duration_ms: Date.now() - started, error: String(row["error"]) });
        throw new ToolError("EXECUTION_FAILED", String(row["error"] ?? "The approved action failed"));
      }
      if (row["status"] === "approved") continue; // being executed
    }
    return {
      status: "pending_approval",
      result: {
        status: "pending_approval",
        approval_id: approvalId,
        summary,
        message: `"${summary}" requires human approval. The owner sees it in the Formbridge dashboard under Approvals. Poll get_approval(approval_id="${approvalId}") every 10-30 seconds; when approved the result is returned there. Do not call ${name} again for the same job.`,
      },
    };
  }

  try {
    const result = await executeTool(ctx, name, args);
    await logActivity(ctx, name, args, { status: "ok", started, result });
    return { result, status: "ok" };
  } catch (err) {
    const info = errorInfo(err);
    if (err instanceof RelayError && err.code === "OPERATION_RUNNING") {
      await logActivity(ctx, name, args, { status: "running", started, error: info.message });
      return { status: "ok", result: { status: "running", operation_id: err.operationId, message: info.message } };
    }
    await logActivity(ctx, name, args, { status: "error", started, error: `${info.code}: ${info.message}` });
    throw err;
  }
}

/** Run an approved action (called from the dashboard). Stores result on the approval row. */
export async function executeApproval(db: SupabaseClient, approvalId: string, decidedBy: string): Promise<void> {
  const { data: approval, error } = await db.from("approvals").select("*, environments(*)").eq("id", approvalId).single();
  if (error) throw error;
  if (approval["status"] !== "approved") return;
  const env = approval["environments"] as unknown as EnvRow;
  const ctx: CallContext = { db, env, tokenId: (approval["token_id"] as string | null) ?? null, userId: env.user_id, budgetMs: 280_000, clientName: "approval" };
  try {
    const result = await executeTool(ctx, String(approval["tool"]), approval["args"] as Record<string, unknown>);
    await db.from("approvals").update({ status: "executed", result: (result ?? null) as never }).eq("id", approvalId);
    await logAudit(db, { user_id: decidedBy, environment_id: env.id, actor: "user", action: "approval.executed", target: approvalId, details: { tool: approval["tool"], summary: approval["summary"] } });
  } catch (err) {
    const info = errorInfo(err);
    await db.from("approvals").update({ status: "failed", error: `${info.code}: ${info.message}` }).eq("id", approvalId);
    await logAudit(db, { user_id: decidedBy, environment_id: env.id, actor: "system", action: "approval.failed", target: approvalId, details: { tool: approval["tool"], error: info.message } });
  }
}

async function logActivity(ctx: CallContext, tool: string, args: Record<string, unknown>, o: { status: "ok" | "error" | "denied" | "pending_approval" | "running"; started: number; result?: unknown; error?: string; approvalId?: string }): Promise<string> {
  const { data, error } = await ctx.db
    .from("mcp_activity")
    .insert({ environment_id: ctx.env.id, token_id: ctx.tokenId, tool, args: redactArgs(args), status: o.status, duration_ms: Date.now() - o.started, error: o.error ?? null, result_summary: o.result !== undefined ? summarizeResult(o.result) : null, client_name: ctx.clientName ?? null, approval_id: o.approvalId ?? null })
    .select("id")
    .single();
  if (error) {
    console.error("mcp_activity insert failed", error.message);
    return "";
  }
  return String(data["id"]);
}

async function patchActivity(db: SupabaseClient, id: string, patch: Record<string, unknown>): Promise<void> {
  if (!id) return;
  await db.from("mcp_activity").update(patch).eq("id", id);
}

export function jobPayload(j: S.PrintJobRow): Record<string, unknown> {
  return {
    job_id: j.id,
    name: j.name,
    printer: j.printer_serial,
    status: j.status,
    progress: j.progress,
    progress_pct: Math.round(j.progress * 100),
    machine_type: j.machine_type,
    material_code: j.material_code,
    layer_thickness_mm: j.layer_thickness_mm,
    model_count: j.model_count,
    volume_ml: j.volume_ml,
    layer_count: j.layer_count,
    estimated_seconds: j.estimated_seconds,
    queued_at: j.queued_at,
    started_at: j.started_at,
    finished_at: j.finished_at,
    failure: j.failure,
    source: j.source,
    external_job_id: (j as unknown as { external_job_id?: string | null }).external_job_id ?? null,
  };
}

export function approvalPayload(a: Record<string, unknown>): Record<string, unknown> {
  return { approval_id: a["id"], tool: a["tool"], summary: a["summary"], status: a["status"], requested_at: a["requested_at"], decided_at: a["decided_at"], expires_at: a["expires_at"], result: a["result"], error: a["error"], message: a["status"] === "pending" ? "Still waiting for a human decision in the dashboard." : a["status"] === "executed" ? "Approved and executed; see result." : a["status"] === "approved" ? "Approved, executing now." : `Decision: ${a["status"]}.` };
}
