import type { SupabaseClient } from "@supabase/supabase-js";
import { TOOLS, toolByName } from "./mcp/catalog";

export type PolicyMode = "allow" | "approve" | "deny";

export async function loadPolicies(db: SupabaseClient, envId: string): Promise<Map<string, PolicyMode>> {
  const { data, error } = await db.from("tool_policies").select("tool, mode").eq("environment_id", envId);
  if (error) throw error;
  return new Map((data ?? []).map((r) => [String(r["tool"]), r["mode"] as PolicyMode]));
}

export function effectivePolicy(policies: Map<string, PolicyMode>, tool: string): PolicyMode {
  return policies.get(tool) ?? toolByName(tool)?.defaultPolicy ?? "allow";
}

export function policyTable(policies: Map<string, PolicyMode>): { tool: string; category: string; mode: PolicyMode; isDefault: boolean; description: string }[] {
  return TOOLS.map((t) => ({ tool: t.name, category: t.category, mode: effectivePolicy(policies, t.name), isDefault: !policies.has(t.name), description: t.description }));
}
