/**
 * Forward a tool call to the local connector of a connected environment.
 * The connector long-polls /api/connector/poll, claims the request, runs it
 * against its PreFormServer and posts the result back.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const CONNECTOR_ONLINE_WINDOW_MS = 90_000;

export function connectorOnline(lastSeen: string | null | undefined): boolean {
  return !!lastSeen && Date.now() - new Date(lastSeen).getTime() < CONNECTOR_ONLINE_WINDOW_MS;
}

export class RelayError extends Error {
  constructor(public readonly code: string, message: string, public readonly operationId?: string) {
    super(message);
    this.name = "RelayError";
  }
}

export async function relayTool(db: SupabaseClient, env: { id: string; connector_last_seen_at: string | null }, tool: string, args: Record<string, unknown>, opts: { timeoutMs: number; onProgress?: (fraction: number, message: string) => Promise<void> }): Promise<unknown> {
  if (!connectorOnline(env.connector_last_seen_at)) {
    throw new RelayError("CONNECTOR_OFFLINE", "The local connector for this environment is not running. Start it on the machine with PreForm: see the environment's Connect tab in the dashboard.");
  }
  const { data, error } = await db.from("relay_requests").insert({ environment_id: env.id, tool, args }).select("id").single();
  if (error) throw error;
  const id = String(data["id"]);
  const deadline = Date.now() + opts.timeoutMs;
  let lastProgress = -1;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const { data: row, error: e2 } = await db.from("relay_requests").select("status, result, error, progress, progress_message").eq("id", id).single();
    if (e2) throw e2;
    if (row["status"] === "done") return row["result"];
    if (row["status"] === "failed") {
      // The connector reports PreForm errors as "CODE: message"; keep the code.
      const text = String(row["error"] ?? "connector reported an error");
      const m = /^([A-Z_]{3,40}): ([\s\S]*)$/.exec(text);
      throw new RelayError(m ? m[1]! : "CONNECTOR_ERROR", m ? m[2]! : text);
    }
    const p = row["progress"] === null ? -1 : Number(row["progress"]);
    if (opts.onProgress && p > lastProgress) {
      lastProgress = p;
      await opts.onProgress(p, String(row["progress_message"] ?? "")).catch(() => {});
    }
  }
  throw new RelayError("OPERATION_RUNNING", `The connector is still working on ${tool}. Call get_operation with operation_id=${id} to fetch the result.`, id);
}

export async function getOperation(db: SupabaseClient, envId: string, id: string): Promise<Record<string, unknown>> {
  const { data, error } = await db.from("relay_requests").select("*").eq("environment_id", envId).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new RelayError("NOT_FOUND", `No operation ${id}`);
  return { operation_id: id, tool: data["tool"], status: data["status"], progress: data["progress"], progress_message: data["progress_message"], result: data["result"], error: data["error"], created_at: data["created_at"], finished_at: data["finished_at"] };
}
