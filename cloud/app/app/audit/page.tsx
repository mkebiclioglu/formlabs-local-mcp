import { Badge, Card, Empty } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { createUserClient } from "@/lib/supabase/server";

export default async function AuditPage() {
  const db = await createUserClient();
  const [{ data: rows }, { data: envs }] = await Promise.all([
    db.from("audit_log").select("*").order("created_at", { ascending: false }).limit(300),
    db.from("environments").select("id, name"),
  ]);
  const envName = (id: string | null) => (id ? envs?.find((e) => e["id"] === id)?.["name"] ?? "" : "");
  const tone = (actor: string) => (actor === "agent" ? "info" : actor === "connector" ? "accent" : actor === "system" ? "muted" : "ok");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Audit log</h1>
        <p className="text-sm text-muted mt-1">Sign-ins, tokens, policy changes, approvals, connector sessions and manual printer actions.</p>
      </div>
      <Card>
        {!rows || rows.length === 0 ? <Empty>Nothing recorded yet.</Empty> : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Environment</th><th>Details</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r["id"])}>
                    <td className="text-muted whitespace-nowrap">{fmtDate(String(r["created_at"]))}</td>
                    <td><Badge tone={tone(String(r["actor"]))}>{String(r["actor"])}</Badge></td>
                    <td className="mono">{String(r["action"])}</td>
                    <td className="text-muted max-w-xs truncate">{String(r["target"] ?? "")}</td>
                    <td className="text-muted">{envName(r["environment_id"] as string | null)}</td>
                    <td className="text-xs text-muted max-w-md truncate">{r["details"] ? JSON.stringify(r["details"]) : ""}</td>
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
