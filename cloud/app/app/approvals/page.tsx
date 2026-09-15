import { ActionButton, AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, statusTone } from "@/components/ui";
import { fmtDate, timeAgo } from "@/lib/format";
import { createUserClient } from "@/lib/supabase/server";
import { decideApproval } from "../actions";

export default async function ApprovalsPage() {
  const db = await createUserClient();
  const [{ data: rows }, { data: envs }] = await Promise.all([
    db.from("approvals").select("*").order("requested_at", { ascending: false }).limit(100),
    db.from("environments").select("id, name"),
  ]);
  const envName = (id: string) => envs?.find((e) => e["id"] === id)?.["name"] ?? "";
  const pending = (rows ?? []).filter((r) => r["status"] === "pending");
  const past = (rows ?? []).filter((r) => r["status"] !== "pending");
  return (
    <div className="space-y-6">
      <AutoRefresh seconds={5} />
      <div>
        <h1 className="text-xl font-semibold">Approvals</h1>
        <p className="text-sm text-muted mt-1">Sensitive tool calls wait here until you decide. The agent polls for your answer and continues once you approve.</p>
      </div>
      <Card title={`Waiting for you (${pending.length})`}>
        {pending.length === 0 ? <Empty>Nothing pending. Tools marked "approve" in an environment's policy will show up here when an agent calls them.</Empty> : (
          <ul className="divide-y divide-line">
            {pending.map((a) => (
              <li key={String(a["id"])} className="py-3 flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="font-medium">{String(a["summary"])}</div>
                  <div className="text-xs text-muted">{envName(String(a["environment_id"]))} · <span className="mono">{String(a["tool"])}</span> · requested {timeAgo(String(a["requested_at"]))} · expires {fmtDate(String(a["expires_at"]))}</div>
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted">Arguments</summary>
                    <pre className="mt-1 rounded bg-bg p-2 overflow-x-auto">{JSON.stringify(a["args"], null, 2)}</pre>
                  </details>
                </div>
                <div className="flex gap-2">
                  <ActionButton action={decideApproval.bind(null, String(a["id"]), "deny")} className="btn-danger">Deny</ActionButton>
                  <ActionButton action={decideApproval.bind(null, String(a["id"]), "approve")} className="btn-primary">Approve and run</ActionButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="History">
        {past.length === 0 ? <Empty>No decisions yet.</Empty> : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead><tr><th>Action</th><th>Environment</th><th>Status</th><th>Requested</th><th>Decided</th><th>Outcome</th></tr></thead>
              <tbody>
                {past.map((a) => (
                  <tr key={String(a["id"])}>
                    <td className="font-medium">{String(a["summary"])}</td>
                    <td className="text-muted">{envName(String(a["environment_id"]))}</td>
                    <td><Badge tone={statusTone(String(a["status"]))}>{String(a["status"])}</Badge></td>
                    <td className="text-muted whitespace-nowrap">{fmtDate(String(a["requested_at"]))}</td>
                    <td className="text-muted whitespace-nowrap">{fmtDate(a["decided_at"] as string | null)}</td>
                    <td className="text-xs text-muted max-w-xs truncate">{a["error"] ? String(a["error"]) : a["result"] ? JSON.stringify(a["result"]).slice(0, 120) : ""}</td>
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
