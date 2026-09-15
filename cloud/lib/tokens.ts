import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EnvRow } from "./sim/store";

export type TokenKind = "mcp" | "connector";

export function generateToken(kind: TokenKind): { token: string; hash: string; prefix: string } {
  const body = randomBytes(24).toString("base64url");
  const token = `${kind === "mcp" ? "fb_mcp" : "fb_conn"}_${body}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, 14) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface ResolvedToken {
  id: string;
  user_id: string;
  environment_id: string;
  kind: TokenKind;
  name: string;
  env: EnvRow;
}

export function bearerFrom(request: Request): string | undefined {
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m) return m[1]!.trim();
  const alt = request.headers.get("x-api-key");
  return alt?.trim() || undefined;
}

/** Look up a live token and its environment. Bumps last_used_at at most once a minute. */
export async function resolveToken(db: SupabaseClient, token: string, kind: TokenKind): Promise<ResolvedToken | undefined> {
  if (!token || token.length < 20) return undefined;
  const { data, error } = await db
    .from("api_tokens")
    .select("id, user_id, environment_id, kind, name, last_used_at, revoked_at, environments(*)")
    .eq("token_hash", hashToken(token))
    .maybeSingle();
  if (error) throw error;
  if (!data || data["revoked_at"] || data["kind"] !== kind) return undefined;
  const env = data["environments"] as unknown as EnvRow | null;
  if (!env) return undefined;
  const last = data["last_used_at"] ? new Date(String(data["last_used_at"])).getTime() : 0;
  if (Date.now() - last > 60_000) void db.from("api_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data["id"]).then(() => {});
  return { id: String(data["id"]), user_id: String(data["user_id"]), environment_id: String(data["environment_id"]), kind, name: String(data["name"]), env };
}
