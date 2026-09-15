"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logAudit } from "@/lib/audit";
import { toolByName } from "@/lib/mcp/catalog";
import { executeApproval } from "@/lib/mcp/execute";
import type { PolicyMode } from "@/lib/policy";
import { cancelQueuedJob, printerAction, resetDemoFarm, seedDemoFarm, startQueuedJob, type EnvRow, type PrinterAction } from "@/lib/sim/store";
import { createUserClient } from "@/lib/supabase/server";
import { appUrl } from "@/lib/supabase/env";
import { generateToken } from "@/lib/tokens";

async function ctx() {
  const db = await createUserClient();
  const { data } = await db.auth.getUser();
  if (!data.user) redirect("/login");
  return { db, user: data.user };
}

async function ownedEnv(db: Awaited<ReturnType<typeof createUserClient>>, id: string): Promise<EnvRow> {
  const { data, error } = await db.from("environments").select("*").eq("id", id).single();
  if (error || !data) throw new Error("Environment not found");
  return data as unknown as EnvRow;
}

const CONNECTOR_PACKAGE = "github:mkebiclioglu/formlabs-local-mcp#cloud";

export async function connectorCommand(token: string): Promise<string> {
  return `npx -y ${CONNECTOR_PACKAGE} connect --url ${appUrl()} --token ${token}`;
}

export async function claudeCommand(token: string): Promise<string> {
  return `claude mcp add --transport http formbridge ${appUrl()}/api/mcp --header "Authorization: Bearer ${token}"`;
}

export async function createToken(fd: FormData): Promise<{ token: string; name: string; command?: string }> {
  const { db, user } = await ctx();
  const kind = fd.get("kind") === "connector" ? "connector" : "mcp";
  const name = String(fd.get("name") ?? "").trim().slice(0, 80) || (kind === "mcp" ? "MCP client" : "Connector");
  const environmentId = String(fd.get("environment_id") ?? "");
  const env = await ownedEnv(db, environmentId);
  if (kind === "connector" && env.kind !== "connected") throw new Error("Connector tokens belong to connected environments");
  const t = generateToken(kind);
  const { error } = await db.from("api_tokens").insert({ user_id: user.id, environment_id: env.id, kind, name, token_hash: t.hash, token_prefix: t.prefix });
  if (error) throw new Error(error.message);
  await logAudit(db, { user_id: user.id, environment_id: env.id, actor: "user", action: "token.created", target: name, details: { kind, prefix: t.prefix } });
  revalidatePath("/app", "layout");
  return { token: t.token, name, command: kind === "mcp" ? await claudeCommand(t.token) : await connectorCommand(t.token) };
}

export async function revokeToken(id: string): Promise<void> {
  const { db, user } = await ctx();
  const { data } = await db.from("api_tokens").update({ revoked_at: new Date().toISOString() }).eq("id", id).is("revoked_at", null).select("name, environment_id, token_prefix").maybeSingle();
  if (data) await logAudit(db, { user_id: user.id, environment_id: String(data["environment_id"]), actor: "user", action: "token.revoked", target: String(data["name"]), details: { prefix: data["token_prefix"] } });
  revalidatePath("/app", "layout");
}

export async function createEnvironment(fd: FormData): Promise<void> {
  const { db, user } = await ctx();
  const kind = fd.get("kind") === "simulated" ? "simulated" : "connected";
  const name = String(fd.get("name") ?? "").trim().slice(0, 80) || (kind === "simulated" ? "Simulated farm" : "My PreForm machine");
  const { data, error } = await db.from("environments").insert({ user_id: user.id, name, kind, sim_speed: 30 }).select("*").single();
  if (error) throw new Error(error.message);
  const env = data as unknown as EnvRow;
  if (kind === "simulated") await seedDemoFarm(db, env);
  await logAudit(db, { user_id: user.id, environment_id: env.id, actor: "user", action: "environment.created", target: name, details: { kind } });
  revalidatePath("/app", "layout");
  redirect(`/app/environments/${env.id}${kind === "connected" ? "?tab=connect" : ""}`);
}

export async function updateEnvironment(id: string, fd: FormData): Promise<void> {
  const { db, user } = await ctx();
  const env = await ownedEnv(db, id);
  const patch: Record<string, unknown> = {};
  const name = fd.get("name");
  if (typeof name === "string" && name.trim()) patch["name"] = name.trim().slice(0, 80);
  const speed = fd.get("sim_speed");
  if (typeof speed === "string" && Number(speed) > 0) patch["sim_speed"] = Math.min(3600, Number(speed));
  const fr = fd.get("failure_rate");
  if (typeof fr === "string") patch["failure_rate"] = Math.max(0, Math.min(1, Number(fr)));
  patch["auto_start_queued"] = fd.get("auto_start_queued") === "on";
  const { error } = await db.from("environments").update(patch).eq("id", env.id);
  if (error) throw new Error(error.message);
  await logAudit(db, { user_id: user.id, environment_id: env.id, actor: "user", action: "environment.updated", target: env.name, details: patch });
  revalidatePath(`/app/environments/${id}`);
}

export async function deleteEnvironment(id: string): Promise<void> {
  const { db, user } = await ctx();
  const env = await ownedEnv(db, id);
  const { error } = await db.from("environments").delete().eq("id", env.id);
  if (error) throw new Error(error.message);
  await logAudit(db, { user_id: user.id, actor: "user", action: "environment.deleted", target: env.name, details: { id: env.id, kind: env.kind } });
  revalidatePath("/app", "layout");
  redirect("/app");
}

export async function setPolicy(envId: string, tool: string, mode: PolicyMode | "default"): Promise<void> {
  const { db, user } = await ctx();
  const env = await ownedEnv(db, envId);
  if (!toolByName(tool)) throw new Error("Unknown tool");
  if (mode === "default") await db.from("tool_policies").delete().eq("environment_id", env.id).eq("tool", tool);
  else {
    const { error } = await db.from("tool_policies").upsert({ environment_id: env.id, tool, mode, updated_at: new Date().toISOString() }, { onConflict: "environment_id,tool" });
    if (error) throw new Error(error.message);
  }
  await logAudit(db, { user_id: user.id, environment_id: env.id, actor: "user", action: "policy.changed", target: tool, details: { mode } });
  revalidatePath(`/app/environments/${envId}`);
}

export async function decideApproval(id: string, decision: "approve" | "deny"): Promise<void> {
  const { db, user } = await ctx();
  const { data, error } = await db.from("approvals").select("id, environment_id, tool, summary, status, expires_at").eq("id", id).single();
  if (error || !data) throw new Error("Approval not found");
  if (data["status"] !== "pending") return;
  const expired = new Date(String(data["expires_at"])).getTime() < Date.now();
  const status = expired ? "expired" : decision === "approve" ? "approved" : "denied";
  const { error: e2 } = await db.from("approvals").update({ status, decided_at: new Date().toISOString(), decided_by: user.id }).eq("id", id).eq("status", "pending");
  if (e2) throw new Error(e2.message);
  await logAudit(db, { user_id: user.id, environment_id: String(data["environment_id"]), actor: "user", action: `approval.${status}`, target: id, details: { tool: data["tool"], summary: data["summary"] } });
  if (status === "approved") await executeApproval(db, id, user.id);
  revalidatePath("/app", "layout");
}

export async function runPrinterAction(envId: string, printerId: string, action: PrinterAction): Promise<void> {
  const { db, user } = await ctx();
  const env = await ownedEnv(db, envId);
  const message = await printerAction(db, env, printerId, action);
  await logAudit(db, { user_id: user.id, environment_id: env.id, actor: "user", action: `printer.${action}`, target: printerId, details: { message } });
  revalidatePath(`/app/environments/${envId}`);
}

export async function startJob(envId: string, jobId: string): Promise<void> {
  const { db, user } = await ctx();
  const env = await ownedEnv(db, envId);
  await startQueuedJob(db, env, jobId);
  await logAudit(db, { user_id: user.id, environment_id: env.id, actor: "user", action: "job.started", target: jobId });
  revalidatePath(`/app/environments/${envId}`);
}

export async function cancelJob(envId: string, jobId: string): Promise<void> {
  const { db, user } = await ctx();
  const env = await ownedEnv(db, envId);
  await cancelQueuedJob(db, env, jobId);
  await logAudit(db, { user_id: user.id, environment_id: env.id, actor: "user", action: "job.cancelled", target: jobId });
  revalidatePath(`/app/environments/${envId}`);
}

export async function resetDemo(envId: string): Promise<void> {
  const { db, user } = await ctx();
  const env = await ownedEnv(db, envId);
  if (env.kind !== "simulated") throw new Error("Only simulated environments can be reset");
  await resetDemoFarm(db, env);
  await logAudit(db, { user_id: user.id, environment_id: env.id, actor: "user", action: "environment.reset", target: env.name });
  revalidatePath(`/app/environments/${envId}`);
}
