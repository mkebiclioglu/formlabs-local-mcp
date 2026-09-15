import type { SupabaseClient } from "@supabase/supabase-js";

export type Actor = "user" | "agent" | "connector" | "system";

export async function logAudit(db: SupabaseClient, e: { user_id: string; environment_id?: string | null; actor: Actor; action: string; target?: string | null; details?: Record<string, unknown> | null }): Promise<void> {
  const { error } = await db.from("audit_log").insert({ user_id: e.user_id, environment_id: e.environment_id ?? null, actor: e.actor, action: e.action, target: e.target ?? null, details: e.details ?? null });
  if (error) console.error("audit_log insert failed", error.message);
}

/** Keep logged arguments small and free of anything that looks like a secret. */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k.startsWith("__")) continue;
    if (/password|secret|token/i.test(k)) { out[k] = "[redacted]"; continue; }
    const s = JSON.stringify(v);
    out[k] = s && s.length > 400 ? `${s.slice(0, 400)}…` : v;
  }
  return out;
}

export function summarizeResult(result: unknown): string {
  if (result === null || result === undefined) return "ok";
  if (typeof result !== "object") return String(result).slice(0, 200);
  const r = result as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of ["status", "id", "job_id", "approval_id", "model_count", "count", "print_time_seconds", "printable", "version"]) {
    if (r[k] !== undefined && r[k] !== null && typeof r[k] !== "object") parts.push(`${k}=${String(r[k])}`);
  }
  if (Array.isArray(r["devices"])) parts.push(`devices=${r["devices"].length}`);
  if (Array.isArray(r["models"])) parts.push(`models=${r["models"].length}`);
  return parts.join(" ").slice(0, 200) || "ok";
}
