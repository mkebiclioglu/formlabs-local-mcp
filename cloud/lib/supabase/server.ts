/**
 * Supabase client bound to the signed-in user's cookies (Next.js server
 * components, server actions and route handlers). Row level security applies.
 */
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseAnonKey, supabaseUrl } from "./env";

export async function createUserClient() {
  const cookieStore = await cookies();
  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          /* called from a server component: middleware refreshes the session instead */
        }
      },
    },
  });
}

export async function currentUser() {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getUser();
  return data.user;
}
