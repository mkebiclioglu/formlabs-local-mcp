"use client";

import { useActionState } from "react";
import type { AuthState } from "@/app/auth-actions";

export function AuthForm({ action, submit, next }: { action: (prev: AuthState, fd: FormData) => Promise<AuthState>; submit: string; next?: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-4">
      {next && <input type="hidden" name="next" value={next} />}
      <div>
        <label className="label" htmlFor="email">Email</label>
        <input id="email" name="email" type="email" className="input" autoComplete="email" required />
      </div>
      <div>
        <label className="label" htmlFor="password">Password</label>
        <input id="password" name="password" type="password" className="input" autoComplete="current-password" minLength={8} required />
      </div>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.notice && <p className="text-sm text-warn">{state.notice}</p>}
      <button className="btn-primary w-full justify-center" disabled={pending}>{pending ? "…" : submit}</button>
    </form>
  );
}
