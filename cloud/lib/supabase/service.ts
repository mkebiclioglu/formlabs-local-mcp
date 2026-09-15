/**
 * Privileged Supabase client for server-side paths that act on behalf of
 * any user (the MCP endpoint, the connector API, approvals execution).
 *
 * This deployment has no service-role key, so privilege comes from a
 * dedicated auth user listed in public.service_accounts; every RLS policy
 * grants that user full access through public.is_service(). The session is
 * cached per process and refreshed before it expires.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseAnonKey, supabaseUrl } from "./env";

let cached: { client: SupabaseClient; expiresAt: number } | undefined;
let pending: Promise<SupabaseClient> | undefined;

async function signIn(): Promise<SupabaseClient> {
  const email = process.env["FORMBRIDGE_SERVICE_EMAIL"];
  const password = process.env["FORMBRIDGE_SERVICE_PASSWORD"];
  if (!email || !password) throw new Error("FORMBRIDGE_SERVICE_EMAIL / FORMBRIDGE_SERVICE_PASSWORD are not set");
  const client = createClient(supabaseUrl(), supabaseAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`service account sign-in failed: ${error?.message ?? "no session"}`);
  const expiresAt = (data.session.expires_at ?? Math.floor(Date.now() / 1000) + 3600) * 1000;
  cached = { client, expiresAt };
  return client;
}

export async function serviceClient(): Promise<SupabaseClient> {
  if (cached && cached.expiresAt - Date.now() > 120_000) return cached.client;
  if (!pending) {
    pending = signIn().finally(() => {
      pending = undefined;
    });
  }
  return pending;
}
