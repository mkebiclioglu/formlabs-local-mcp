import { GENERATED_ENV } from "../runtime-env.generated";

/** Read configuration from the process environment, then the generated fallback. */
export function envVar(name: string): string | undefined {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  const g = GENERATED_ENV[name];
  return g !== undefined && g !== "" ? g : undefined;
}

export function supabaseUrl(): string {
  const v = envVar("NEXT_PUBLIC_SUPABASE_URL");
  if (!v) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  return v;
}

export function supabaseAnonKey(): string {
  const v = envVar("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!v) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set");
  return v;
}

export function appUrl(): string {
  const explicit = envVar("NEXT_PUBLIC_APP_URL");
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = envVar("VERCEL_PROJECT_PRODUCTION_URL") ?? envVar("VERCEL_URL");
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}
