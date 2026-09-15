import { AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, statusTone } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { createUserClient } from "@/lib/supabase/server";

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ env?: string }> }) {
  const { env } = await searchParams;
  const db = await createUserClient();
  let q = db.from("mcp_activity").select("*, api_tokens(name)").order("created_at", { ascending: false }).limit(200);
  if (env) q = q.eq("environment_id", env);
  const [{ data: rows }, { data: envs }] = await Promise.all([q, db.from("environments").select("id, name")]);
  const envName = (id: string) => envs?.find((e) => e["id"] === id)?.["name"] ?? "";
  return (
    <div className="space-y-6">
      <AutoRefresh seconds={6} />
      <div>
        <h1 className="text-xl font-semibold">MCP activity</h1>
        <p className="text-sm text-muted mt-1">Every tool call made through the hosted endpoint, with the token that made it and how it ended.</p>
      </div>
      <Card>
        {!rows || rows.length === 0 ? <Empty>No calls yet.</Empty> : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead><tr><th>Time</th><th>Tool</th><th>Status</th><th>Environment</th><th>Token</th><th>Client</th><th>Duration</th><th>Details</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r["id"])}>
                    <td className="text-muted whitespace-nowrap">{fmtDate(String(r["created_at"]))}</td>
                    <td className="mono">{String(r["tool"])}</td>
                    <td><Badge tone={statusTone(String(r["status"]))}>{String(r["status"]).replace("_", " ")}</Badge></td>
                    <td className="text-muted">{envName(String(r["environment_id"]))}</td>
                    <td className="text-muted">{String((r["api_tokens"] as { name?: string } | null)?.name ?? "")}</td>
                    <td className="text-muted">{String(r["client_name"] ?? "")}</td>
                    <td className="text-muted">{r["duration_ms"] !== null ? `${Number(r["duration_ms"])} ms` : ""}</td>
                    <td className="text-xs max-w-md">
                      <details>
                        <summary className="cursor-pointer text-muted truncate">{r["error"] ? String(r["error"]).slice(0, 80) : String(r["result_summary"] ?? "")}</summary>
                        <pre className="mt-1 rounded bg-bg p-2 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(r["args"], null, 2)}{r["error"] ? `\n\n${String(r["error"])}` : ""}</pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
