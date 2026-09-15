import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton, AutoRefresh, CodeBlock, TokenCreator } from "@/components/client";
import { PolicyRow } from "@/components/policy-row";
import { Badge, Card, Empty, Progress, Stat, Tabs, statusTone } from "@/components/ui";
import { duration, fmtDate, timeAgo } from "@/lib/format";
import { loadPolicies, policyTable } from "@/lib/policy";
import { connectorOnline } from "@/lib/relay";
import { material } from "@/lib/sim/catalog";
import type { PrintJob, SimPrinter } from "@/lib/sim/engine";
import { listJobs, loadFarm, type EnvRow } from "@/lib/sim/store";
import { appUrl } from "@/lib/supabase/env";
import { createUserClient } from "@/lib/supabase/server";
import { cancelJob, connectorCommand, createToken, deleteEnvironment, resetDemo, revokeToken, runPrinterAction, startJob, updateEnvironment } from "../../actions";

export default async function EnvironmentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = await params;
  const { tab: rawTab } = await searchParams;
  const db = await createUserClient();
  const { data: envRow } = await db.from("environments").select("*").eq("id", id).maybeSingle();
  if (!envRow) notFound();
  const env = envRow as unknown as EnvRow;
  const simulated = env.kind === "simulated";
  const tab = rawTab ?? (simulated ? "printers" : "printers");
  const [farm, jobs, policies, { data: tokens }, { data: artifacts }, { data: pendingApprovals }] = await Promise.all([
    simulated ? loadFarm(db, env) : Promise.resolve(null),
    listJobs(db, env.id, 100),
    loadPolicies(db, env.id),
    db.from("api_tokens").select("*").eq("environment_id", env.id).order("created_at", { ascending: false }),
    simulated ? db.from("sim_artifacts").select("*").eq("environment_id", env.id).order("created_at", { ascending: false }).limit(50) : Promise.resolve({ data: [] }),
    db.from("approvals").select("id").eq("environment_id", env.id).eq("status", "pending"),
  ]);
  const base = `/app/environments/${env.id}`;
  const online = connectorOnline(env.connector_last_seen_at);
  const createConnector = async (fd: FormData) => {
    "use server";
    fd.set("kind", "connector");
    return createToken(fd);
  };
  const createMcp = async (fd: FormData) => {
    "use server";
    fd.set("kind", "mcp");
    return createToken(fd);
  };
  const envList = [{ id: env.id, name: env.name, kind: env.kind }];
  const activeJobs = jobs.filter((j) => ["queued", "printing", "paused"].includes(j.status));

  return (
    <div className="space-y-5">
      <AutoRefresh seconds={simulated ? 4 : 10} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{env.name}</h1>
            {simulated ? <Badge tone="info">simulated · {Number(env.sim_speed)}x time</Badge> : <Badge tone={online ? "ok" : "muted"}>{online ? "connector online" : "connector offline"}</Badge>}
          </div>
          <p className="text-sm text-muted mt-1">
            {simulated ? "Virtual printers that behave like a Formlabs farm: queues, progress, resin use, pauses and failures. Agents cannot tell it apart from a connected environment." : `Tool calls are relayed to the connector running next to PreFormServer${env.connector_info?.["hostname"] ? ` on ${String(env.connector_info["hostname"])}` : ""}.`}
          </p>
        </div>
        {(pendingApprovals?.length ?? 0) > 0 && <Link href="/app/approvals" className="btn-primary">{pendingApprovals!.length} approval{pendingApprovals!.length > 1 ? "s" : ""} waiting</Link>}
      </div>

      <Tabs base={base} current={tab} tabs={[
        { key: "printers", label: "Printers" },
        { key: "jobs", label: "Print jobs", count: activeJobs.length },
        { key: "policies", label: "Permissions" },
        { key: "tokens", label: "Tokens", count: (tokens ?? []).filter((t) => !t["revoked_at"]).length },
        { key: "connect", label: simulated ? "Connect agent" : "Connect" },
        ...(simulated ? [{ key: "files", label: "Files", count: artifacts?.length ?? 0 }] : []),
        { key: "settings", label: "Settings" },
      ]} />

      {tab === "printers" && (simulated && farm ? <SimPrinters env={env} printers={farm.printers} jobs={farm.jobs} /> : <RealPrinters env={env} online={online} />)}
      {tab === "jobs" && <Jobs env={env} jobs={jobs} />}
      {tab === "policies" && (
        <Card title="Tool permissions">
          <p className="text-sm text-muted mb-4">Choose what an agent may do here. <strong>Approve</strong> parks the call until you decide in Approvals; <strong>Deny</strong> hides the tool from the client entirely.</p>
          <div className="overflow-x-auto">
            <table className="data">
              <thead><tr><th>Tool</th><th>Category</th><th>Mode</th></tr></thead>
              <tbody>{policyTable(policies).map((p) => <PolicyRow key={p.tool} envId={env.id} row={p} />)}</tbody>
            </table>
          </div>
        </Card>
      )}
      {tab === "tokens" && (
        <div className="space-y-4">
          <Card title="Create an MCP token for this environment"><TokenCreator create={createMcp} kind="mcp" environments={envList} defaultEnv={env.id} /></Card>
          <Card title="Tokens">
            {!tokens || tokens.length === 0 ? <Empty>No tokens for this environment yet.</Empty> : (
              <table className="data">
                <thead><tr><th>Name</th><th>Kind</th><th>Prefix</th><th>Last used</th><th></th></tr></thead>
                <tbody>
                  {tokens.map((t) => (
                    <tr key={String(t["id"])} className={t["revoked_at"] ? "opacity-50" : ""}>
                      <td>{String(t["name"])}</td>
                      <td><Badge tone={t["kind"] === "mcp" ? "info" : "accent"}>{String(t["kind"])}</Badge></td>
                      <td className="mono text-muted">{String(t["token_prefix"])}…</td>
                      <td className="text-muted">{timeAgo(t["last_used_at"] as string | null)}</td>
                      <td className="text-right">{t["revoked_at"] ? <span className="text-xs text-muted">revoked</span> : <ActionButton action={revokeToken.bind(null, String(t["id"]))} className="btn-danger text-xs" confirm="Revoke this token?">Revoke</ActionButton>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      )}
      {tab === "connect" && (
        <div className="space-y-4">
          {!simulated && (
            <Card title="1. Run the connector next to PreForm">
              <p className="text-sm text-muted mb-3">Create a connector token, then run the command on the Mac or Windows machine that runs PreFormServer (or where you want it installed). It keeps a single outbound connection to Formbridge and executes tool calls locally; nothing on your network is exposed.</p>
              <TokenCreator create={createConnector} kind="connector" environments={envList} defaultEnv={env.id} />
              <div className="mt-4 text-xs text-muted space-y-2">
                <p>The command looks like:</p>
                <CodeBlock code={await connectorCommand("<CONNECTOR_TOKEN>")} />
                <p>Once published to npm this becomes <code>npx -y formlabs-local-mcp connect …</code>. Needs Node.js 20+. If PreFormServer is missing, ask the agent to run <code>install_preform_server</code> (requires your approval) or run <code>npx -y formlabs-local-mcp install-preform</code> yourself.</p>
                <p>Status: {online ? <span className="text-ok">online, last seen {timeAgo(env.connector_last_seen_at)}</span> : env.connector_last_seen_at ? `last seen ${timeAgo(env.connector_last_seen_at)}` : "never connected"}{env.connector_info?.["version"] ? ` · connector ${String(env.connector_info["version"])} on ${String(env.connector_info["platform"] ?? "?")}` : ""}</p>
              </div>
            </Card>
          )}
          <Card title={simulated ? "Point an MCP client at this environment" : "2. Point an MCP client at this environment"}>
            <TokenCreator create={createMcp} kind="mcp" environments={envList} defaultEnv={env.id} />
            <div className="mt-4 text-xs text-muted">
              <p className="mb-1">Endpoint <code className="text-ink">{appUrl()}/api/mcp</code> with <code className="text-ink">Authorization: Bearer &lt;token&gt;</code>. Setup snippets for Claude Code, Codex and Cursor are on the <Link href="/app/connect" className="text-accent underline">Connect a client</Link> page.</p>
            </div>
          </Card>
        </div>
      )}
      {tab === "files" && (
        <Card title="Virtual files">
          <p className="text-sm text-muted mb-3">Files an agent saved with save_form, save_screenshot or save_fps_file. In a simulated environment nothing is written to disk; the scene is stored here instead, and load_form can restore a .form.</p>
          {!artifacts || artifacts.length === 0 ? <Empty>No files saved yet.</Empty> : (
            <table className="data">
              <thead><tr><th>Path</th><th>Kind</th><th>Models</th><th>Saved</th></tr></thead>
              <tbody>
                {artifacts.map((a) => (
                  <tr key={String(a["id"])}>
                    <td className="mono">{String(a["path"])}</td>
                    <td><Badge>{String(a["kind"])}</Badge></td>
                    <td className="text-muted">{Array.isArray((a["scene_snapshot"] as { models?: unknown[] } | null)?.models) ? ((a["scene_snapshot"] as { models: unknown[] }).models.length) : 0}</td>
                    <td className="text-muted">{fmtDate(String(a["created_at"]))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
      {tab === "settings" && <Settings env={env} />}
    </div>
  );
}

function SimPrinters({ env, printers, jobs }: { env: EnvRow; printers: SimPrinter[]; jobs: PrintJob[] }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Printing" value={printers.filter((p) => ["PRINTING", "PREHEATING", "COOLING"].includes(p.status)).length} />
        <Stat label="Idle" value={printers.filter((p) => p.status === "IDLE").length} />
        <Stat label="Need attention" value={printers.filter((p) => ["ERROR", "PAUSED"].includes(p.status)).length} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {printers.map((p) => {
          const job = jobs.find((j) => j.id === p.current_job_id);
          const queued = jobs.filter((j) => j.printer_id === p.id && j.status === "queued").length;
          const act = (action: Parameters<typeof runPrinterAction>[2]) => runPrinterAction.bind(null, env.id, p.id, action);
          const remaining = job && job.estimated_seconds ? ((1 - job.progress) * job.estimated_seconds) / Number(env.sim_speed) : null;
          return (
            <div key={p.id} className={`card p-4 space-y-3 ${!p.online ? "opacity-70" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{p.serial}</div>
                  <div className="text-xs text-muted">{p.product_name} · {p.alias} · {p.ip_address} · fw {p.firmware_version}</div>
                </div>
                <Badge tone={statusTone(p.status)}>{p.status.toLowerCase()}</Badge>
              </div>
              {job && (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs"><span className="truncate">{job.name}</span><span className="text-muted">{Math.round(job.progress * 100)}%{remaining !== null ? ` · ${duration(remaining)} left (${duration((1 - job.progress) * (job.estimated_seconds ?? 0))} sim)` : ""}</span></div>
                  <Progress value={job.progress} />
                  <div className="text-xs text-muted">layer {Math.round((job.layer_count ?? 0) * job.progress)} / {job.layer_count} · {job.volume_ml} mL {material(job.material_code ?? "")?.name ?? job.material_code}</div>
                </div>
              )}
              {p.error && <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs"><strong>{p.error.code}</strong> · {p.error.message}</div>}
              <div className="grid grid-cols-2 gap-2 text-xs">
                {p.tank && <div className="rounded-md bg-panel-2 p-2"><div className="text-muted">Tank</div><div>{material(p.tank.material_code)?.name ?? p.tank.material_code}</div><div className="text-muted">{Math.max(0, Math.round((1 - p.tank.ml_printed / p.tank.max_ml) * 100))}% life left</div></div>}
                {p.cartridge && <div className="rounded-md bg-panel-2 p-2"><div className="text-muted">Cartridge</div><div>{material(p.cartridge.material_code)?.name ?? p.cartridge.material_code}</div><div className={p.cartridge.remaining_ml < 100 ? "text-warn" : "text-muted"}>{p.cartridge.remaining_ml} / {p.cartridge.capacity_ml} mL{p.cartridge.remaining_ml < 100 ? " · low" : ""}</div></div>}
                {p.powder && <div className="rounded-md bg-panel-2 p-2 col-span-2"><div className="text-muted">Powder hopper</div><div>{material(p.powder.material_code)?.name ?? p.powder.material_code} · {p.powder.hopper_kg} / {p.powder.capacity_kg} kg</div></div>}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                <span>{p.print_count} prints · {p.print_hours} h{queued ? ` · ${queued} queued` : ""}</span>
                <span className="grow" />
                {p.status === "FINISHED" && <ActionButton action={act("remove_part")} className="btn-primary text-xs">Remove part</ActionButton>}
                {p.status === "ERROR" && p.error?.code !== "TANK_FILM_DAMAGED" && <ActionButton action={act("clear_error")} className="btn-primary text-xs">Clear error</ActionButton>}
                {p.error?.code === "TANK_FILM_DAMAGED" && <ActionButton action={act("replace_tank")} className="btn-primary text-xs">Replace tank</ActionButton>}
                {p.error?.code === "CARTRIDGE_EMPTY" && <ActionButton action={act("replace_cartridge")} className="btn-primary text-xs">Replace cartridge</ActionButton>}
                {p.status === "PRINTING" && <ActionButton action={act("pause")} className="btn-ghost text-xs">Pause</ActionButton>}
                {p.status === "PAUSED" && p.error?.code !== "CARTRIDGE_EMPTY" && <ActionButton action={act("resume")} className="btn-ghost text-xs">Resume</ActionButton>}
                {["PRINTING", "PAUSED", "PREHEATING", "COOLING"].includes(p.status) && <ActionButton action={act("abort")} className="btn-danger text-xs" confirm="Abort the running print?">Abort</ActionButton>}
                <details className="relative">
                  <summary className="btn-ghost text-xs cursor-pointer list-none">More</summary>
                  <div className="absolute right-0 z-10 mt-1 w-44 card p-1 flex flex-col">
                    {p.cartridge && <ActionButton action={act("replace_cartridge")} className="btn text-xs justify-start hover:bg-panel-2">Replace cartridge</ActionButton>}
                    {p.tank && <ActionButton action={act("replace_tank")} className="btn text-xs justify-start hover:bg-panel-2">Replace tank</ActionButton>}
                    {p.powder && <ActionButton action={act("refill_powder")} className="btn text-xs justify-start hover:bg-panel-2">Refill powder</ActionButton>}
                    <ActionButton action={act("toggle_offline")} className="btn text-xs justify-start hover:bg-panel-2">{p.online ? "Take offline" : "Bring online"}</ActionButton>
                  </div>
                </details>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RealPrinters({ env, online }: { env: EnvRow; online: boolean }) {
  const devices = Array.isArray(env.devices_snapshot) ? (env.devices_snapshot as Record<string, unknown>[]) : [];
  return (
    <Card title="Printers reported by PreForm" action={<span className="text-xs text-muted">{env.connector_last_seen_at ? `updated ${timeAgo(env.connector_last_seen_at)}` : ""}</span>}>
      {!online && <p className="text-sm text-warn mb-3">The connector is offline. Start it to refresh printers and accept tool calls; see the Connect tab.</p>}
      {devices.length === 0 ? <Empty>No printers reported yet. The connector sends PreForm's device list every 30 seconds while it runs; ask the agent to call discover_devices to scan the network.</Empty> : (
        <div className="grid gap-3 md:grid-cols-2">
          {devices.map((d, i) => {
            const st = (d["printer_status"] as Record<string, unknown> | undefined) ?? {};
            const status = String(st["status"] ?? d["status"] ?? "unknown");
            return (
              <div key={i} className="card p-4 space-y-1">
                <div className="flex items-center justify-between"><span className="font-medium">{String(d["id"] ?? d["name"] ?? "printer")}</span><Badge tone={statusTone(status)}>{status.toLowerCase()}</Badge></div>
                <div className="text-xs text-muted">{String(d["product_name"] ?? d["printer_type"] ?? "")} · {String(d["ip_address"] ?? d["connection_type"] ?? "")}</div>
                <details className="text-xs"><summary className="text-muted cursor-pointer">Raw</summary><pre className="mt-1 rounded bg-bg p-2 overflow-x-auto">{JSON.stringify(d, null, 2)}</pre></details>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function Jobs({ env, jobs }: { env: EnvRow; jobs: PrintJob[] }) {
  return (
    <Card title="Print jobs">
      {jobs.length === 0 ? <Empty>No print jobs yet.</Empty> : (
        <div className="overflow-x-auto">
          <table className="data">
            <thead><tr><th>Job</th><th>Printer</th><th>Status</th><th>Progress</th><th>Material</th><th>Est.</th><th>Queued</th><th>Finished</th><th></th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td><div className="font-medium">{j.name}</div><div className="text-xs text-muted">{j.model_count} model{j.model_count === 1 ? "" : "s"} · {j.source}{j.failure ? ` · ${j.failure.code}` : ""}</div></td>
                  <td className="text-muted whitespace-nowrap">{j.printer_serial}</td>
                  <td><Badge tone={statusTone(j.status)}>{j.status}</Badge></td>
                  <td className="w-32">{["printing", "paused", "finished", "failed"].includes(j.status) ? <><Progress value={j.progress} /><span className="text-xs text-muted">{Math.round(j.progress * 100)}%</span></> : ""}</td>
                  <td className="text-muted whitespace-nowrap">{material(j.material_code ?? "")?.name ?? j.material_code}{j.volume_ml ? ` · ${j.volume_ml} mL` : ""}</td>
                  <td className="text-muted whitespace-nowrap">{j.estimated_seconds ? duration(j.estimated_seconds) : ""}</td>
                  <td className="text-muted whitespace-nowrap">{fmtDate(j.queued_at)}</td>
                  <td className="text-muted whitespace-nowrap">{fmtDate(j.finished_at)}</td>
                  <td className="whitespace-nowrap text-right">
                    {j.status === "queued" && env.kind === "simulated" && <span className="flex gap-1 justify-end"><ActionButton action={startJob.bind(null, env.id, j.id)} className="btn-primary text-xs">Start</ActionButton><ActionButton action={cancelJob.bind(null, env.id, j.id)} className="btn-danger text-xs">Cancel</ActionButton></span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Settings({ env }: { env: EnvRow }) {
  const update = updateEnvironment.bind(null, env.id);
  return (
    <div className="space-y-4">
      <Card title="Environment settings">
        <form action={update} className="grid gap-4 max-w-lg">
          <div><label className="label">Name</label><input name="name" className="input" defaultValue={env.name} /></div>
          {env.kind === "simulated" && (
            <>
              <div>
                <label className="label">Simulation speed</label>
                <select name="sim_speed" className="input" defaultValue={String(Number(env.sim_speed))}>
                  {[1, 10, 30, 60, 300, 1800].map((s) => <option key={s} value={s}>{s}x {s === 1 ? "(real time)" : s === 30 ? "(a 3 h print takes 6 min)" : s === 300 ? "(a 3 h print takes 36 s)" : ""}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Random failure rate per job</label>
                <select name="failure_rate" className="input" defaultValue={String(Number(env.failure_rate))}>
                  {[0, 0.08, 0.25, 0.5, 1].map((r) => <option key={r} value={r}>{Math.round(r * 100)}%</option>)}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="auto_start_queued" defaultChecked={env.auto_start_queued} /> Idle printers start queued jobs automatically</label>
            </>
          )}
          {env.kind === "connected" && <input type="hidden" name="auto_start_queued" value={env.auto_start_queued ? "on" : ""} />}
          <div><button className="btn-primary">Save</button></div>
        </form>
      </Card>
      <Card title="Danger zone">
        <div className="flex flex-wrap gap-2">
          {env.kind === "simulated" && <ActionButton action={resetDemo.bind(null, env.id)} className="btn-ghost" confirm="Reset the demo farm? Printers, scenes and job history are recreated.">Reset demo farm</ActionButton>}
          <ActionButton action={deleteEnvironment.bind(null, env.id)} className="btn-danger" confirm="Delete this environment, its tokens, jobs and logs? This cannot be undone.">Delete environment</ActionButton>
        </div>
      </Card>
    </div>
  );
}
