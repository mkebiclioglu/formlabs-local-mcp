/**
 * Database access for the simulator. Every read of printers first advances
 * them to "now" (see engine.ts) and persists whatever changed, so the
 * dashboard and the MCP endpoint always agree without a background worker.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { material, printerType, validSceneSettings } from "./catalog";
import { advancePrinter, estimate, printabilityProblems, rollFailure, round, startJob, type EnvSettings, type PrintJob, type SimPrinter, type SimScene, SimError } from "./engine";
import { findSamplePart } from "./parts";

export interface EnvRow extends EnvSettings {
  id: string;
  user_id: string;
  name: string;
  kind: "simulated" | "connected";
  connector_last_seen_at: string | null;
  connector_info: Record<string, unknown> | null;
  devices_snapshot: unknown[] | null;
  created_at: string;
}

export function envSettings(env: EnvRow): EnvSettings {
  return { sim_speed: Number(env.sim_speed), auto_start_queued: env.auto_start_queued, failure_rate: Number(env.failure_rate) };
}

// ---------------------------------------------------------------------------
// Printers and jobs
// ---------------------------------------------------------------------------

function toPrinter(row: Record<string, unknown>): SimPrinter {
  return { ...(row as unknown as SimPrinter), print_hours: Number(row["print_hours"] ?? 0) };
}

function toJob(row: Record<string, unknown>): PrintJob {
  return {
    ...(row as unknown as PrintJob),
    progress: Number(row["progress"] ?? 0),
    volume_ml: row["volume_ml"] === null ? null : Number(row["volume_ml"]),
    fail_at_fraction: row["fail_at_fraction"] === null ? null : Number(row["fail_at_fraction"]),
    height_mm: row["height_mm"] === null ? null : Number(row["height_mm"]),
  };
}

export interface FarmState {
  printers: SimPrinter[];
  jobs: PrintJob[];
  events: { kind: string; job_id?: string; message: string; at: string }[];
}

/** Load printers + active jobs, advance the simulation, persist and return. */
export async function loadFarm(db: SupabaseClient, env: EnvRow, now = new Date()): Promise<FarmState> {
  const [{ data: printerRows, error: e1 }, { data: jobRows, error: e2 }] = await Promise.all([
    db.from("sim_printers").select("*").eq("environment_id", env.id).order("created_at"),
    db.from("print_jobs").select("*").eq("environment_id", env.id).in("status", ["queued", "printing", "paused"]),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  const settings = envSettings(env);
  const printers: SimPrinter[] = [];
  const changedJobs: PrintJob[] = [];
  const events: FarmState["events"] = [];
  const jobs = (jobRows ?? []).map(toJob);
  for (const row of printerRows ?? []) {
    const before = toPrinter(row);
    const res = advancePrinter(before, jobs, settings, now);
    printers.push(res.printer);
    changedJobs.push(...res.jobs);
    events.push(...res.events);
    if (JSON.stringify(res.printer) !== JSON.stringify(before)) {
      const { id, environment_id: _e, ...rest } = res.printer;
      void _e;
      const { error } = await db.from("sim_printers").update(rest).eq("id", id);
      if (error) throw error;
    }
  }
  for (const j of changedJobs) {
    const { id, ...rest } = j;
    const { error } = await db.from("print_jobs").update({ status: rest.status, progress: rest.progress, started_at: rest.started_at, finished_at: rest.finished_at }).eq("id", id);
    if (error) throw error;
  }
  const merged = jobs.map((j) => changedJobs.find((c) => c.id === j.id) ?? j);
  return { printers, jobs: merged, events };
}

export async function listJobs(db: SupabaseClient, envId: string, limit = 50): Promise<PrintJob[]> {
  const { data, error } = await db.from("print_jobs").select("*").eq("environment_id", envId).order("queued_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []).map(toJob);
}

export async function getJob(db: SupabaseClient, envId: string, jobId: string): Promise<PrintJob | undefined> {
  const { data, error } = await db.from("print_jobs").select("*").eq("environment_id", envId).eq("id", jobId).maybeSingle();
  if (error) throw error;
  return data ? toJob(data) : undefined;
}

export function findPrinter(printers: SimPrinter[], ref: string): SimPrinter | undefined {
  const r = ref.trim().toLowerCase();
  return printers.find((p) => p.serial.toLowerCase() === r || p.alias?.toLowerCase() === r || p.ip_address === r || p.id === r);
}

/** Queue or start a job for a scene on a simulated printer. */
export async function submitPrint(db: SupabaseClient, env: EnvRow, scene: SimScene, printerRef: string, jobName: string, printNow: boolean, opts: { tokenId?: string | null; source?: string } = {}): Promise<Record<string, unknown>> {
  if (scene.models.length === 0) throw new SimError("EMPTY_SCENE", `Scene ${scene.scene_key} has no models. Import a model first.`);
  const farm = await loadFarm(db, env);
  const printer = findPrinter(farm.printers, printerRef);
  if (!printer) throw new SimError("PRINTER_NOT_FOUND", `No printer named ${printerRef}. Known printers: ${farm.printers.map((p) => p.serial).join(", ")}`);
  const problems = printabilityProblems(printer, scene, printNow);
  if (problems.length) throw new SimError("PRINTER_NOT_READY", problems.join(" "));
  if (printer.technology === "SLA" && !scene.models.every((m) => m.supports)) {
    throw new SimError("VALIDATION_FAILED", "Not every model has supports. Run auto_support (and get_print_validation) before printing.");
  }
  const est = estimate(scene);
  const usage = est.material_usage;
  const volume = Number(usage["total_ml"] ?? usage["parts_ml"] ?? 0);
  const jobId = crypto.randomUUID();
  const failure = rollFailure(jobId, Number(env.failure_rate), printer.technology);
  const now = new Date();
  let job: PrintJob = {
    id: jobId,
    environment_id: env.id,
    printer_id: printer.id,
    printer_serial: printer.serial,
    name: jobName,
    status: "queued",
    source: opts.source ?? "mcp",
    machine_type: scene.machine_type,
    material_code: scene.material_code,
    layer_thickness_mm: String(scene.layer_thickness_mm),
    model_count: scene.models.length,
    volume_ml: round(volume),
    layer_count: est.layer_count,
    height_mm: est.build_height_mm,
    estimated_seconds: est.print_time_seconds,
    scene_snapshot: { scene_id: scene.scene_key, models: scene.models.map((m) => ({ id: m.id, name: m.name, volume_ml: m.geometry.volume_ml })), phases: est.phases ?? null, material_usage: usage },
    fail_at_fraction: failure?.fail_at_fraction ?? null,
    failure: failure?.failure ?? null,
    progress: 0,
    queued_at: now.toISOString(),
    started_at: null,
    finished_at: null,
  };
  const p = { ...printer };
  const startNow = printNow || (env.auto_start_queued && p.status === "IDLE");
  if (startNow) job = startJob(p, job, now);
  const { error } = await db.from("print_jobs").insert({ ...job, token_id: opts.tokenId ?? null });
  if (error) throw error;
  if (startNow) {
    const { id, environment_id: _e, ...rest } = p;
    void _e;
    const { error: e2 } = await db.from("sim_printers").update(rest).eq("id", id);
    if (e2) throw e2;
  }
  return {
    job_id: job.id,
    status: job.status,
    printer: printer.serial,
    job_name: jobName,
    started: startNow,
    estimated_print_time_s: est.print_time_seconds,
    estimated_finish_at: startNow ? new Date(now.getTime() + (est.print_time_seconds / Number(env.sim_speed)) * 1000).toISOString() : null,
    layer_count: est.layer_count,
    material_usage: usage,
    note: startNow ? `Printing on ${printer.serial}. Track progress with get_print_job or get_device.` : `Queued on ${printer.serial}; it starts when the printer is idle.`,
  };
}

// ---------------------------------------------------------------------------
// Dashboard operations on simulated printers
// ---------------------------------------------------------------------------

export type PrinterAction = "clear_error" | "replace_cartridge" | "remove_part" | "toggle_offline" | "refill_powder" | "replace_tank" | "pause" | "resume" | "abort";

export async function printerAction(db: SupabaseClient, env: EnvRow, printerId: string, action: PrinterAction): Promise<string> {
  const farm = await loadFarm(db, env);
  const p = farm.printers.find((x) => x.id === printerId);
  if (!p) throw new Error("Printer not found");
  const job = farm.jobs.find((j) => j.id === p.current_job_id);
  const now = new Date().toISOString();
  const patch: Partial<SimPrinter> = {};
  let message = "";
  switch (action) {
    case "clear_error":
      patch.error = null;
      patch.status = p.current_job_id && job?.status === "paused" ? "PAUSED" : "IDLE";
      if (patch.status === "IDLE") patch.current_job_id = null;
      patch.state_changed_at = now;
      message = "Error cleared";
      break;
    case "replace_cartridge": {
      const code = p.cartridge?.material_code ?? p.tank?.material_code ?? "FLGPGR05";
      patch.cartridge = { material_code: code, remaining_ml: material(code)?.cartridge_ml ?? 1000, capacity_ml: material(code)?.cartridge_ml ?? 1000 };
      message = "Cartridge replaced";
      if (p.status === "PAUSED" && p.error?.code === "CARTRIDGE_EMPTY") {
        patch.error = null;
        patch.status = "PRINTING";
        patch.state_changed_at = now;
        if (job) await resumeJob(db, job, now);
        message = "Cartridge replaced, print resumed";
      }
      break;
    }
    case "replace_tank":
      patch.tank = { material_code: p.tank?.material_code ?? "FLGPGR05", installed_at: now, ml_printed: 0, max_ml: p.tank?.max_ml ?? 3000 };
      if (p.status === "ERROR" && p.error?.code === "TANK_FILM_DAMAGED") {
        patch.error = null;
        patch.status = "IDLE";
        patch.state_changed_at = now;
      }
      message = "Tank replaced";
      break;
    case "refill_powder":
      patch.powder = { material_code: p.powder?.material_code ?? "FLP12B01", hopper_kg: p.powder?.capacity_kg ?? 8, capacity_kg: p.powder?.capacity_kg ?? 8 };
      message = "Powder hopper refilled";
      break;
    case "remove_part":
      if (p.status !== "FINISHED") throw new Error("Nothing to remove: the printer has not finished a print");
      patch.status = "IDLE";
      patch.current_job_id = null;
      patch.state_changed_at = now;
      message = "Part removed, platform cleared";
      break;
    case "toggle_offline":
      patch.online = !p.online;
      patch.status = p.online ? "OFFLINE" : "IDLE";
      if (p.online && job && job.status === "printing") {
        // power loss mid-print: job fails
        await db.from("print_jobs").update({ status: "failed", finished_at: now, failure: { code: "POWER_LOSS", message: "Printer went offline during the print." } }).eq("id", job.id);
        patch.current_job_id = null;
      }
      patch.state_changed_at = now;
      message = p.online ? "Printer taken offline" : "Printer back online";
      break;
    case "pause":
      if (!job || job.status !== "printing") throw new Error("No running print to pause");
      patch.status = "PAUSED";
      patch.state_changed_at = now;
      await db.from("print_jobs").update({ status: "paused" }).eq("id", job.id);
      message = "Print paused";
      break;
    case "resume":
      if (!job || job.status !== "paused") throw new Error("No paused print to resume");
      patch.status = "PRINTING";
      patch.error = null;
      patch.state_changed_at = now;
      await resumeJob(db, job, now);
      message = "Print resumed";
      break;
    case "abort":
      if (!job || !["printing", "paused"].includes(job.status)) throw new Error("No running print to abort");
      patch.status = "IDLE";
      patch.current_job_id = null;
      patch.error = null;
      patch.state_changed_at = now;
      await db.from("print_jobs").update({ status: "aborted", finished_at: now }).eq("id", job.id);
      message = "Print aborted";
      break;
  }
  const { error } = await db.from("sim_printers").update(patch).eq("id", p.id);
  if (error) throw error;
  return message;
}

/** Resume a paused job by shifting its start so progress stays where it stopped. */
async function resumeJob(db: SupabaseClient, job: PrintJob, nowIso: string): Promise<void> {
  const nowMs = new Date(nowIso).getTime();
  const { data: envRow } = await db.from("environments").select("sim_speed").eq("id", job.environment_id).single();
  const speed = Number(envRow?.["sim_speed"] ?? 30);
  const elapsedReal = ((job.progress * (job.estimated_seconds ?? 0)) / speed) * 1000;
  const newStart = new Date(nowMs - elapsedReal).toISOString();
  const { error } = await db.from("print_jobs").update({ status: "printing", started_at: newStart }).eq("id", job.id);
  if (error) throw error;
}

export async function startQueuedJob(db: SupabaseClient, env: EnvRow, jobId: string): Promise<void> {
  const farm = await loadFarm(db, env);
  const job = farm.jobs.find((j) => j.id === jobId);
  if (!job || job.status !== "queued") throw new Error("Job is not queued");
  const p = farm.printers.find((x) => x.id === job.printer_id);
  if (!p) throw new Error("Printer no longer exists");
  if (p.status !== "IDLE") throw new Error(`${p.serial} is ${p.status}`);
  const started = startJob({ ...p }, job, new Date());
  const patched: SimPrinter = { ...p, status: p.technology === "SLS" ? "PREHEATING" : "PRINTING", current_job_id: job.id, state_changed_at: started.started_at!, error: null };
  const { id, environment_id: _e, ...rest } = patched;
  void _e;
  await db.from("sim_printers").update(rest).eq("id", id);
  await db.from("print_jobs").update({ status: "printing", started_at: started.started_at, progress: 0 }).eq("id", job.id);
}

export async function cancelQueuedJob(db: SupabaseClient, env: EnvRow, jobId: string): Promise<void> {
  const { error } = await db.from("print_jobs").update({ status: "aborted", finished_at: new Date().toISOString() }).eq("id", jobId).eq("environment_id", env.id).eq("status", "queued");
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

function toScene(row: Record<string, unknown>): SimScene {
  const lt = String(row["layer_thickness_mm"]);
  return {
    scene_key: String(row["scene_key"]),
    machine_type: String(row["machine_type"]),
    material_code: String(row["material_code"]),
    layer_thickness_mm: lt === "ADAPTIVE" ? "ADAPTIVE" : Number(lt),
    print_setting: String(row["print_setting"] ?? "DEFAULT"),
    models: (row["models"] as SimScene["models"]) ?? [],
  };
}

export const DEFAULT_SCENE = { machine_type: "FORM-4-0", material_code: "FLGPGR05", layer_thickness_mm: 0.1 as number | "ADAPTIVE", print_setting: "DEFAULT" };

export async function loadScene(db: SupabaseClient, envId: string, key: string): Promise<SimScene> {
  const { data, error } = await db.from("sim_scenes").select("*").eq("environment_id", envId).eq("scene_key", key).maybeSingle();
  if (error) throw error;
  if (data) return toScene(data);
  if (key === "default") return createScene(db, envId, { ...DEFAULT_SCENE, scene_key: "default" });
  throw new SimError("SCENE_NOT_FOUND", `No scene with id ${key}. Call list_scenes or create_scene.`);
}

export async function createScene(db: SupabaseClient, envId: string, s: { scene_key?: string; machine_type: string; material_code: string; layer_thickness_mm: number | "ADAPTIVE"; print_setting?: string }): Promise<SimScene> {
  const check = validSceneSettings(s.machine_type, s.material_code, s.layer_thickness_mm);
  if (!check.ok) throw new SimError("INPUT_ERROR", `${check.reason}. Call list_materials(machine_type=...) and use one of the listed scene_settings exactly.`);
  const scene: SimScene = { scene_key: s.scene_key ?? crypto.randomUUID(), machine_type: check.printer.machine_type, material_code: check.material.code, layer_thickness_mm: s.layer_thickness_mm, print_setting: s.print_setting ?? "DEFAULT", models: [] };
  const { error } = await db.from("sim_scenes").upsert({ environment_id: envId, scene_key: scene.scene_key, machine_type: scene.machine_type, material_code: scene.material_code, layer_thickness_mm: String(scene.layer_thickness_mm), print_setting: scene.print_setting, models: [] }, { onConflict: "environment_id,scene_key" });
  if (error) throw error;
  return scene;
}

export async function saveScene(db: SupabaseClient, envId: string, scene: SimScene): Promise<void> {
  const { error } = await db
    .from("sim_scenes")
    .update({ machine_type: scene.machine_type, material_code: scene.material_code, layer_thickness_mm: String(scene.layer_thickness_mm), print_setting: scene.print_setting, models: scene.models, updated_at: new Date().toISOString() })
    .eq("environment_id", envId)
    .eq("scene_key", scene.scene_key);
  if (error) throw error;
}

export async function listScenes(db: SupabaseClient, envId: string): Promise<SimScene[]> {
  const { data, error } = await db.from("sim_scenes").select("*").eq("environment_id", envId).order("created_at");
  if (error) throw error;
  return (data ?? []).map(toScene);
}

export async function deleteScene(db: SupabaseClient, envId: string, key: string): Promise<void> {
  if (key === "default") {
    await db.from("sim_scenes").update({ models: [] }).eq("environment_id", envId).eq("scene_key", key);
    return;
  }
  const { error } = await db.from("sim_scenes").delete().eq("environment_id", envId).eq("scene_key", key);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Seeding a demo farm
// ---------------------------------------------------------------------------

const ADJ = ["Bright", "Quiet", "Steady", "Rapid", "Sandy", "Tall", "Calm", "Sunny", "Lucky", "Brave"];
const ANIMAL = ["Otter", "Falcon", "Moose", "Heron", "Badger", "Owl", "Lynx", "Finch", "Panda", "Yak"];

function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length]!;
}

export async function seedDemoFarm(db: SupabaseClient, env: EnvRow): Promise<void> {
  const seed = Array.from(env.id).reduce((a, c) => a + c.charCodeAt(0), 0);
  const name = (prefix: string, i: number) => `${prefix}-${pick(ADJ, seed + i)}${pick(ANIMAL, seed * 3 + i)}`;
  const ago = (hours: number) => new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const sla = (mat: string, remaining: number, tankMl: number) => ({
    tank: { material_code: mat, installed_at: ago(24 * 20), ml_printed: tankMl, max_ml: 3000 },
    cartridge: { material_code: mat, remaining_ml: remaining, capacity_ml: 1000 },
    powder: null,
  });
  const printers = [
    { serial: name("Form4", 0), alias: "Bench A", machine_type: "FORM-4-0", product_name: "Form 4", technology: "SLA", ip_address: "192.168.1.41", firmware_version: "2.7.1", status: "IDLE", online: true, ...sla("FLGPGR05", 680, 1210), print_count: 143, print_hours: 812.5 },
    { serial: name("Form4", 1), alias: "Bench B", machine_type: "FORM-4-0", product_name: "Form 4", technology: "SLA", ip_address: "192.168.1.42", firmware_version: "2.7.1", status: "IDLE", online: true, ...sla("FLGPBK05", 430, 2650), print_count: 98, print_hours: 540.2 },
    { serial: name("Form4L", 2), alias: "Large format", machine_type: "FORM-4L-0", product_name: "Form 4L", technology: "SLA", ip_address: "192.168.1.43", firmware_version: "2.7.1", status: "IDLE", online: true, ...sla("FLGPCL05", 910, 400), print_count: 31, print_hours: 402 },
    { serial: name("Form3", 3), alias: "Legacy Form 3+", machine_type: "FORM-3-0", product_name: "Form 3+", technology: "SLA", ip_address: "192.168.1.44", firmware_version: "1.19.8", status: "IDLE", online: true, ...sla("FLGPGR04", 85, 2900), print_count: 402, print_hours: 3120 },
    { serial: name("Form4", 4), alias: "Tough 2000 station", machine_type: "FORM-4-0", product_name: "Form 4", technology: "SLA", ip_address: "192.168.1.45", firmware_version: "2.6.4", status: "OFFLINE", online: false, ...sla("FLTO2001", 520, 900), print_count: 57, print_hours: 310 },
    { serial: name("Fuse1", 5), alias: "SLS cell", machine_type: "FS30-1-0", product_name: "Fuse 1+ 30W", technology: "SLS", ip_address: "192.168.1.60", firmware_version: "3.1.0", status: "IDLE", online: true, tank: null, cartridge: null, powder: { material_code: "FLP12B01", hopper_kg: 6.4, capacity_kg: 8 }, print_count: 22, print_hours: 610 },
  ];
  const { data: inserted, error } = await db.from("sim_printers").insert(printers.map((p) => ({ ...p, environment_id: env.id }))).select("id, serial, machine_type, material:cartridge");
  if (error) throw error;
  const bySerial = new Map((inserted ?? []).map((r) => [String(r["serial"]), String(r["id"])]));

  // History
  const history = [
    { p: 0, name: "bracket-v7 x4", mat: "FLGPGR05", hoursAgo: 96, est: 4.1, vol: 61, status: "finished" },
    { p: 1, name: "phone-stand", mat: "FLGPBK05", hoursAgo: 80, est: 6.2, vol: 38, status: "finished" },
    { p: 2, name: "enclosure-lid batch", mat: "FLGPCL05", hoursAgo: 70, est: 9.5, vol: 140, status: "finished" },
    { p: 3, name: "gear set", mat: "FLGPGR04", hoursAgo: 60, est: 5.4, vol: 30, status: "finished" },
    { p: 0, name: "manifold rev2", mat: "FLGPGR05", hoursAgo: 48, est: 7.3, vol: 25, status: "failed", failure: { code: "PART_DETACHED", message: "Print failed: a part detached from the build platform." } },
    { p: 5, name: "nylon clips x40", mat: "FLP12B01", hoursAgo: 40, est: 14.2, vol: 210, status: "finished" },
    { p: 1, name: "knob x6", mat: "FLGPBK05", hoursAgo: 26, est: 3.1, vol: 34, status: "finished" },
    { p: 0, name: "impeller test", mat: "FLGPGR05", hoursAgo: 12, est: 4.8, vol: 15, status: "finished" },
  ];
  const jobs: Record<string, unknown>[] = history.map((h) => {
    const printer = printers[h.p]!;
    const started = ago(h.hoursAgo);
    const finished = new Date(new Date(started).getTime() + h.est * 3600 * 1000 * (h.status === "failed" ? 0.42 : 1)).toISOString();
    return {
      environment_id: env.id,
      printer_id: bySerial.get(printer.serial) ?? null,
      printer_serial: printer.serial,
      name: h.name,
      status: h.status,
      source: "seed",
      machine_type: printer.machine_type,
      material_code: h.mat,
      layer_thickness_mm: printer.technology === "SLS" ? "0.11" : "0.1",
      model_count: 1,
      volume_ml: h.vol,
      layer_count: Math.round((h.est * 3600) / 9),
      height_mm: Math.round(((h.est * 3600) / 9) * 0.1),
      estimated_seconds: Math.round(h.est * 3600),
      progress: h.status === "failed" ? 0.42 : 1,
      failure: h.failure ?? null,
      queued_at: new Date(new Date(started).getTime() - 5 * 60 * 1000).toISOString(),
      started_at: started,
      finished_at: finished as string | null,
    };
  });
  // One print in progress on Bench B (Black V5): a 3h job that is ~35% done.
  const runningPrinter = printers[1]!;
  const runningEst = 3 * 3600;
  const runningStarted = new Date(Date.now() - ((0.35 * runningEst) / Number(env.sim_speed)) * 1000).toISOString();
  const runningId = crypto.randomUUID();
  jobs.push({
    environment_id: env.id,
    printer_id: bySerial.get(runningPrinter.serial) ?? null,
    printer_serial: runningPrinter.serial,
    name: "housing-rev3 x2",
    status: "printing",
    source: "seed",
    machine_type: runningPrinter.machine_type,
    material_code: "FLGPBK05",
    layer_thickness_mm: "0.1",
    model_count: 2,
    volume_ml: 92,
    layer_count: 1200,
    height_mm: 120,
    estimated_seconds: runningEst,
    progress: 0.35,
    failure: null,
    queued_at: runningStarted,
    started_at: runningStarted,
    finished_at: null as string | null,
  });
  const rows = jobs.map((j, i) => ({ ...j, id: i === jobs.length - 1 ? runningId : crypto.randomUUID() }));
  const { error: e2 } = await db.from("print_jobs").insert(rows);
  if (e2) throw e2;
  await db.from("sim_printers").update({ status: "PRINTING", current_job_id: runningId, state_changed_at: runningStarted }).eq("id", bySerial.get(runningPrinter.serial)!);

  // A default scene so the first get_scene call is not empty-handed.
  await createScene(db, env.id, { ...DEFAULT_SCENE, scene_key: "default" });
  void findSamplePart;
  void printerType;
}

export async function resetDemoFarm(db: SupabaseClient, env: EnvRow): Promise<void> {
  await db.from("print_jobs").delete().eq("environment_id", env.id);
  await db.from("sim_printers").delete().eq("environment_id", env.id);
  await db.from("sim_scenes").delete().eq("environment_id", env.id);
  await db.from("sim_artifacts").delete().eq("environment_id", env.id);
  await seedDemoFarm(db, env);
}

export type PrintJobRow = PrintJob;
