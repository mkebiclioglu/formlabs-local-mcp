import Link from "next/link";
import { AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, Stat, statusTone } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import { connectorOnline } from "@/lib/relay";
import { loadFarm, type EnvRow } from "@/lib/sim/store";
import { createUserClient } from "@/lib/supabase/server";
import { createEnvironment } from "./actions";

export default async function Overview({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const { welcome } = await searchParams;
  const db = await createUserClient();
  const { data: envRows } = await db.from("environments").select("*").order("created_at");
  const envs = (envRows ?? []) as unknown as EnvRow[];
  const farms = await Promise.all(envs.map(async (e) => (e.kind === "simulated" ? loadFarm(db, e) : null)));
  const [{ data: tokens }, { data: pending }, { data: activity }] = await Promise.all([
    db.from("api_tokens").select("id, kind").is("revoked_at", null),
    db.from("approvals").select("id, tool, summary, requested_at, environment_id").eq("status", "pending").order("requested_at", { ascending: false }).limit(5),
    db.from("mcp_activity").select("id, tool, status, created_at, environment_id, duration_ms").order("created_at", { ascending: false }).limit(8),
  ]);
  const printers = farms.flatMap((f) => f?.printers ?? []);
  const printing = printers.filter((p) => ["PRINTING", "PREHEATING", "COOLING"].includes(p.status)).length;
  const attention = printers.filter((p) => ["ERROR", "PAUSED"].includes(p.status)).length;
  const mcpTokens = (tokens ?? []).filter((t) => t["kind"] === "mcp").length;
  const envName = (id: string) => envs.find((e) => e.id === id)?.name ?? "";

  return (
    <div className="space-y-6">
      <AutoRefresh seconds={8} />
      {welcome && (
        <div className="rounded-xl border border-accent/40 bg-accent/5 p-4 text-sm">
          <strong>Welcome.</strong> A simulated print farm was created for you with six printers and some print history. Next: <Link href="/app/connect" className="text-accent underline">connect Claude Code or another MCP client</Link>, then ask it to list your printers and print something.
        </div>
      )}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Overview</h1>
        {mcpTokens === 0 && <Link href="/app/connect" className="btn-primary">Connect an MCP client</Link>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Environments" value={envs.length} hint={`${envs.filter((e) => e.kind === "simulated").length} simulated · ${envs.filter((e) => e.kind === "connected").length} connected`} />
        <Stat label="Printers printing" value={printing} hint={`${printers.length} simulated printers`} />
        <Stat label="Need attention" value={attention} hint="paused or errored" />
        <Stat label="Pending approvals" value={pending?.length ?? 0} hint={<Link href="/app/approvals" className="underline">review</Link>} />
      </div>

      <Card title="Environments" action={<CreateEnvForm />}>
        <div className="grid gap-3 md:grid-cols-2">
          {envs.map((e, i) => {
            const farm = farms[i];
            const online = e.kind === "connected" ? connectorOnline(e.connector_last_seen_at) : true;
            return (
              <Link key={e.id} href={`/app/environments/${e.id}`} className="rounded-lg border border-line bg-panel-2 p-4 hover:border-muted/60">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{e.name}</span>
                  <Badge tone={e.kind === "simulated" ? "info" : online ? "ok" : "muted"}>{e.kind === "simulated" ? `simulated · ${Number(e.sim_speed)}x` : online ? "connector online" : "connector offline"}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
                  {farm?.printers.map((p) => (
                    <span key={p.id} className="rounded-md bg-bg px-2 py-1"><span className="text-muted">{p.product_name}</span> <Badge tone={statusTone(p.status)}>{p.status.toLowerCase()}</Badge></span>
                  ))}
                  {e.kind === "connected" && (
                    <span className="text-muted">{Array.isArray(e.devices_snapshot) ? `${e.devices_snapshot.length} printers reported by PreForm` : "no printers reported yet"}{e.connector_last_seen_at ? ` · seen ${timeAgo(e.connector_last_seen_at)}` : ""}</span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Pending approvals" action={<Link href="/app/approvals" className="text-xs text-accent">All approvals</Link>}>
          {pending && pending.length > 0 ? (
            <ul className="space-y-2 text-sm">
              {pending.map((a) => (
                <li key={String(a["id"])} className="flex items-center justify-between gap-3">
                  <span><span className="font-medium">{String(a["summary"])}</span> <span className="text-muted">· {envName(String(a["environment_id"]))} · {timeAgo(String(a["requested_at"]))}</span></span>
                  <Link href="/app/approvals" className="btn-primary text-xs">Review</Link>
                </li>
              ))}
            </ul>
          ) : <Empty>No gated actions waiting.</Empty>}
        </Card>
        <Card title="Recent MCP activity" action={<Link href="/app/activity" className="text-xs text-accent">All activity</Link>}>
          {activity && activity.length > 0 ? (
            <ul className="space-y-1.5 text-sm">
              {activity.map((a) => (
                <li key={String(a["id"])} className="flex items-center justify-between gap-2">
                  <span className="mono truncate">{String(a["tool"])}</span>
                  <span className="flex items-center gap-2 text-xs text-muted"><Badge tone={statusTone(String(a["status"]))}>{String(a["status"]).replace("_", " ")}</Badge>{timeAgo(String(a["created_at"]))}</span>
                </li>
              ))}
            </ul>
          ) : <Empty>No tool calls yet. Connect a client to get started.</Empty>}
        </Card>
      </div>
    </div>
  );
}

function CreateEnvForm() {
  return (
    <form action={createEnvironment} className="flex items-center gap-2">
      <input name="name" className="input py-1 text-xs w-40" placeholder="Name" />
      <select name="kind" className="input py-1 text-xs w-36">
        <option value="connected">Connected (real PreForm)</option>
        <option value="simulated">Simulated</option>
      </select>
      <button className="btn-ghost text-xs">Add environment</button>
    </form>
  );
}
