import { ActionButton, TokenCreator } from "@/components/client";
import { Badge, Card, Empty } from "@/components/ui";
import { fmtDate, timeAgo } from "@/lib/format";
import { createUserClient } from "@/lib/supabase/server";
import { createToken, revokeToken } from "../actions";

export default async function TokensPage() {
  const db = await createUserClient();
  const [{ data: tokens }, { data: envs }] = await Promise.all([
    db.from("api_tokens").select("*").order("created_at", { ascending: false }),
    db.from("environments").select("id, name, kind").order("created_at"),
  ]);
  const envList = (envs ?? []).map((e) => ({ id: String(e["id"]), name: String(e["name"]), kind: String(e["kind"]) }));
  const envName = (id: string) => envList.find((e) => e.id === id)?.name ?? "";
  const createMcp = async (fd: FormData) => {
    "use server";
    fd.set("kind", "mcp");
    return createToken(fd);
  };
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">API tokens</h1>
        <p className="text-sm text-muted mt-1">An MCP token gives a client access to exactly one environment. Connector tokens are created from a connected environment's Connect tab. Tokens are stored hashed and can be revoked at any time.</p>
      </div>
      <Card title="Create an MCP token">
        <TokenCreator create={createMcp} kind="mcp" environments={envList} defaultEnv={envList[0]?.id} />
      </Card>
      <Card title="Existing tokens">
        {!tokens || tokens.length === 0 ? <Empty>No tokens yet.</Empty> : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead><tr><th>Name</th><th>Kind</th><th>Environment</th><th>Prefix</th><th>Last used</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={String(t["id"])} className={t["revoked_at"] ? "opacity-50" : ""}>
                    <td className="font-medium">{String(t["name"])}</td>
                    <td><Badge tone={t["kind"] === "mcp" ? "info" : "accent"}>{String(t["kind"])}</Badge></td>
                    <td className="text-muted">{envName(String(t["environment_id"]))}</td>
                    <td className="mono text-muted">{String(t["token_prefix"])}…</td>
                    <td className="text-muted">{timeAgo(t["last_used_at"] as string | null)}</td>
                    <td className="text-muted whitespace-nowrap">{fmtDate(String(t["created_at"]))}</td>
                    <td className="text-right">{t["revoked_at"] ? <span className="text-xs text-muted">revoked</span> : <ActionButton action={revokeToken.bind(null, String(t["id"]))} className="btn-danger text-xs" confirm="Revoke this token? Clients using it will stop working.">Revoke</ActionButton>}</td>
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
