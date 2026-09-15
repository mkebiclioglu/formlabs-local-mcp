import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "./audit";
import { seedDemoFarm, type EnvRow } from "./sim/store";

/** Every user gets a simulated demo farm the first time we see them. */
export async function ensureDemoEnvironment(db: SupabaseClient, userId: string): Promise<EnvRow | undefined> {
  const { data: existing, error } = await db.from("environments").select("id").eq("user_id", userId).limit(1);
  if (error) throw error;
  if (existing && existing.length > 0) return undefined;
  const { data: env, error: e2 } = await db.from("environments").insert({ user_id: userId, name: "Demo print farm", kind: "simulated", sim_speed: 30 }).select("*").single();
  if (e2) throw e2;
  const row = env as unknown as EnvRow;
  await seedDemoFarm(db, row);
  await logAudit(db, { user_id: userId, environment_id: row.id, actor: "system", action: "environment.created", target: row.name, details: { kind: "simulated", seeded: true } });
  return row;
}
