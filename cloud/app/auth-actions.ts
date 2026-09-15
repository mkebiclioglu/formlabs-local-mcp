"use server";

import { redirect } from "next/navigation";
import { logAudit } from "@/lib/audit";
import { ensureDemoEnvironment } from "@/lib/onboarding";
import { createUserClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";

export type AuthState = { error?: string; notice?: string };

function safeNext(v: FormDataEntryValue | null): string {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/app") ? s : "/app";
}

export async function signIn(_prev: AuthState, fd: FormData): Promise<AuthState> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  const supabase = await createUserClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) return { error: error?.message ?? "Sign-in failed" };
  await ensureDemoEnvironment(supabase, data.user.id);
  await logAudit(supabase, { user_id: data.user.id, actor: "user", action: "auth.sign_in", details: { email } });
  redirect(safeNext(fd.get("next")));
}

export async function signUp(_prev: AuthState, fd: FormData): Promise<AuthState> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  if (password.length < 8) return { error: "Use at least 8 characters for the password." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Enter a valid email address." };
  // Accounts are created through a service-only database function so that no
  // confirmation email is involved (the project's SMTP is rate limited).
  let svc;
  try {
    svc = await serviceClient();
  } catch (err) {
    console.error("service client", err);
    return { error: "Sign-up is temporarily unavailable." };
  }
  const { data: uid, error } = await svc.rpc("create_user_account", { p_email: email, p_password: password });
  if (error) {
    const msg = error.message.includes("email_exists") ? "An account with this email already exists. Sign in instead." : error.message.includes("invalid_email") ? "Enter a valid email address." : error.message.includes("weak_password") ? "Use at least 8 characters for the password." : `Sign-up failed: ${error.message}`;
    return { error: msg };
  }
  const supabase = await createUserClient();
  const { data, error: e3 } = await supabase.auth.signInWithPassword({ email, password });
  if (e3 || !data.user) return { error: e3?.message ?? "Sign-in after sign-up failed" };
  await ensureDemoEnvironment(supabase, data.user.id);
  await logAudit(supabase, { user_id: data.user.id, actor: "user", action: "auth.sign_up", details: { email, uid } });
  redirect("/app?welcome=1");
}

export async function signOut(): Promise<void> {
  const supabase = await createUserClient();
  await supabase.auth.signOut();
  redirect("/login");
}
