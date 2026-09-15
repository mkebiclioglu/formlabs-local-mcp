/**
 * Pure simulation logic: scenes, print estimates, printer state machine.
 * Nothing here touches the database; ./store.ts loads rows, calls these
 * functions, and writes back. Time is virtual: an environment's `sim_speed`
 * is how many simulated seconds pass per real second, so a 4-hour print
 * finishes in 4 minutes at 60x.
 */
import { createHash } from "node:crypto";
import { isSLS, material, printerType, type PrinterType } from "./catalog";
import type { PartGeometry } from "./parts";

// ---------------------------------------------------------------------------
// Scenes and models
// ---------------------------------------------------------------------------

export interface SimModel {
  id: string;
  name: string;
  file: string;
  geometry: PartGeometry;
  position: { x: number; y: number; z: number };
  orientation: { x: number; y: number; z: number };
  scale: number;
  lock: string;
  oriented: boolean;
  supports?: { touchpoints: number; volume_ml: number; raft_type: string; density: number };
  hollowed?: { wall_thickness_mm: number; saved_ml: number };
  drain_holes?: number;
  labels?: string[];
  laid_out: boolean;
  caged?: boolean;
}

export interface SimScene {
  scene_key: string;
  machine_type: string;
  material_code: string;
  layer_thickness_mm: number | "ADAPTIVE";
  print_setting: string;
  models: SimModel[];
}

export function newModelId(): string {
  return crypto.randomUUID();
}

export function effectiveSize(m: SimModel): { x: number; y: number; z: number } {
  const s = m.geometry.size_mm;
  const k = m.scale;
  // A tilted part gets taller; auto-orient typically tilts 15-40 degrees.
  const tilt = m.oriented ? 1.18 : 1;
  const raft = m.supports ? 3 + 5 : 0; // raft + height above raft, mm
  return { x: round(s.x * k * (m.oriented ? 1.08 : 1)), y: round(s.y * k * (m.oriented ? 1.08 : 1)), z: round(s.z * k * tilt + raft) };
}

export function modelVolumeMl(m: SimModel): number {
  const base = m.geometry.volume_ml * m.scale ** 3;
  const hollowSaved = m.hollowed?.saved_ml ?? 0;
  return round(Math.max(0.1, base - hollowSaved));
}

export function boundingBox(m: SimModel): { min_corner: { x: number; y: number; z: number }; max_corner: { x: number; y: number; z: number } } {
  const s = effectiveSize(m);
  return {
    min_corner: { x: round(m.position.x - s.x / 2), y: round(m.position.y - s.y / 2), z: 0 },
    max_corner: { x: round(m.position.x + s.x / 2), y: round(m.position.y + s.y / 2), z: s.z },
  };
}

export function modelPayload(m: SimModel): Record<string, unknown> {
  const size = effectiveSize(m);
  return {
    id: m.id,
    name: m.name,
    file: m.file,
    position: m.position,
    orientation: m.orientation,
    scale: m.scale,
    lock: m.lock,
    bounding_box: boundingBox(m),
    size_mm: size,
    volume_ml: modelVolumeMl(m),
    triangle_count: m.geometry.triangles ?? Math.round(2000 + m.geometry.volume_ml * 400),
    supports: m.supports ? { generated: true, ...m.supports } : { generated: false },
    hollowed: m.hollowed ?? null,
    drain_holes: m.drain_holes ?? 0,
    labels: m.labels ?? [],
    oriented: m.oriented,
    laid_out: m.laid_out,
    source: m.geometry.source,
  };
}

export function scenePayload(scene: SimScene): Record<string, unknown> {
  const printer = printerType(scene.machine_type);
  const usage = materialUsage(scene);
  return {
    id: scene.scene_key,
    machine_type: scene.machine_type,
    material_code: scene.material_code,
    material_name: material(scene.material_code)?.name ?? scene.material_code,
    layer_thickness_mm: scene.layer_thickness_mm,
    print_setting: scene.print_setting,
    technology: printer?.technology ?? (isSLS(scene.machine_type) ? "SLS" : "SLA"),
    build_volume_mm: printer?.build_volume_mm ?? null,
    models: scene.models.map(modelPayload),
    model_count: scene.models.length,
    material_usage: usage,
    build_height_mm: buildHeight(scene),
  };
}

export function materialUsage(scene: SimScene): Record<string, unknown> {
  const parts = round(scene.models.reduce((a, m) => a + modelVolumeMl(m), 0));
  const supports = round(scene.models.reduce((a, m) => a + (m.supports?.volume_ml ?? 0), 0));
  const sls = isSLS(scene.machine_type);
  const mat = material(scene.material_code);
  if (sls) {
    const density = mat?.density ?? 1;
    const chamberHeight = buildHeight(scene);
    const printer = printerType(scene.machine_type);
    const bedMl = printer ? (printer.build_volume_mm.x * printer.build_volume_mm.y * chamberHeight) / 1000 : parts * 8;
    return { parts_ml: parts, powder_bed_ml: round(bedMl), part_mass_g: round(parts * density), powder_used_kg: round((bedMl * density * 0.3) / 1000, 3), packing_density: bedMl > 0 ? round(parts / bedMl, 3) : 0 };
  }
  return { parts_ml: parts, supports_ml: supports, total_ml: round(parts + supports), cost_usd: mat?.price_usd_per_l ? round(((parts + supports) / 1000) * mat.price_usd_per_l, 2) : null };
}

export function buildHeight(scene: SimScene): number {
  if (scene.models.length === 0) return 0;
  if (isSLS(scene.machine_type)) {
    // Packed volume: stack parts, packing efficiency ~ 12%.
    const printer = printerType(scene.machine_type);
    const parts = scene.models.reduce((a, m) => a + modelVolumeMl(m), 0);
    const area = printer ? printer.build_volume_mm.x * printer.build_volume_mm.y : 165 * 165;
    const packed = scene.models.some((m) => m.laid_out);
    const tallest = Math.max(...scene.models.map((m) => effectiveSize(m).z));
    if (!packed) return round(scene.models.reduce((a, m) => a + effectiveSize(m).z, 0) + 10);
    return round(Math.max(tallest + 10, (parts * 1000) / (area * 0.12)));
  }
  return round(Math.max(...scene.models.map((m) => effectiveSize(m).z)));
}

export function layerCount(scene: SimScene): number {
  const h = buildHeight(scene);
  const lt = scene.layer_thickness_mm === "ADAPTIVE" ? 0.08 : scene.layer_thickness_mm;
  return Math.ceil(h / lt);
}

export interface Estimate {
  print_time_seconds: number;
  print_time_ms: number;
  layer_count: number;
  build_height_mm: number;
  phases?: { preheat_seconds: number; print_seconds: number; cooldown_seconds: number };
  material_usage: Record<string, unknown>;
}

export function estimate(scene: SimScene): Estimate {
  const printer = printerType(scene.machine_type);
  const layers = layerCount(scene);
  const lt = String(scene.layer_thickness_mm);
  const perLayer = printer?.per_layer_seconds[lt] ?? printer?.per_layer_seconds["ADAPTIVE"] ?? 10;
  const usage = materialUsage(scene);
  const ml = Number(usage["total_ml"] ?? usage["parts_ml"] ?? 0);
  const printSeconds = Math.round(layers * perLayer + ml * (printer?.seconds_per_ml ?? 45));
  if (printer?.technology === "SLS") {
    const preheat = printer.preheat_seconds ?? 3600;
    const cool = Math.round(printSeconds * (printer.cooldown_fraction ?? 0.5));
    const total = preheat + printSeconds + cool;
    return { print_time_seconds: total, print_time_ms: total * 1000, layer_count: layers, build_height_mm: buildHeight(scene), phases: { preheat_seconds: preheat, print_seconds: printSeconds, cooldown_seconds: cool }, material_usage: usage };
  }
  return { print_time_seconds: printSeconds, print_time_ms: printSeconds * 1000, layer_count: layers, build_height_mm: buildHeight(scene), material_usage: usage };
}

// ---------------------------------------------------------------------------
// Prep operations (mutate a scene copy)
// ---------------------------------------------------------------------------

export function selectModels(scene: SimScene, models: "ALL" | string[]): SimModel[] {
  if (models === "ALL") return scene.models;
  const wanted = new Set(models.map(bareId));
  const found = scene.models.filter((m) => wanted.has(bareId(m.id)));
  if (found.length !== wanted.size) {
    const missing = [...wanted].filter((id) => !found.some((m) => bareId(m.id) === id));
    throw new SimError("MODEL_NOT_FOUND", `No model with id ${missing.join(", ")} in scene ${scene.scene_key}`);
  }
  return found;
}

export function bareId(id: string): string {
  return id.replace(/^\{|\}$/g, "");
}

export class SimError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SimError";
  }
}

export function autoOrient(scene: SimScene, models: "ALL" | string[], mode?: "DENTAL"): Record<string, unknown> {
  const targets = selectModels(scene, models);
  for (const m of targets) {
    const tilt = mode === "DENTAL" ? 0 : m.geometry.overhang === "high" ? 35 : m.geometry.overhang === "medium" ? 25 : 15;
    m.orientation = { x: tilt, y: Math.round(tilt * 0.6), z: 0 };
    m.oriented = true;
    m.laid_out = false;
    if (m.supports) m.supports = undefined; // orientation invalidates supports, like PreForm
  }
  return { status: "oriented", models: targets.map((m) => ({ id: m.id, orientation: m.orientation })) };
}

export function autoSupport(scene: SimScene, models: "ALL" | string[], opts: { density?: number; raft_type?: string; touchpoint_size_mm?: number; only_minima?: boolean }): Record<string, unknown> {
  if (isSLS(scene.machine_type)) throw new SimError("INPUT_ERROR", "SLS scenes do not use supports; parts are held by the powder bed. Use auto_pack.");
  const targets = selectModels(scene, models);
  const density = opts.density ?? 1;
  for (const m of targets) {
    const overhang = m.geometry.overhang === "high" ? 0.22 : m.geometry.overhang === "medium" ? 0.14 : 0.08;
    const base = m.oriented ? overhang : overhang * 1.5;
    const vol = round(modelVolumeMl(m) * base * density + 0.6);
    const touchpoints = Math.max(3, Math.round((vol / (opts.touchpoint_size_mm ?? 0.5)) * 6 * (opts.only_minima ? 0.4 : 1)));
    m.supports = { touchpoints, volume_ml: vol, raft_type: opts.raft_type ?? "FULL_RAFT", density };
  }
  return { status: "supported", models: targets.map((m) => ({ id: m.id, supports: m.supports })) };
}

export function autoLayout(scene: SimScene, models: "ALL" | string[], spacing = 5, margin = 5): Record<string, unknown> {
  if (isSLS(scene.machine_type)) throw new SimError("INPUT_ERROR", "auto_layout is for SLA printers. This scene targets an SLS printer; use auto_pack.");
  const printer = printerType(scene.machine_type);
  if (!printer) throw new SimError("INPUT_ERROR", `Unknown machine type ${scene.machine_type}`);
  const targets = selectModels(scene, models);
  const bv = printer.build_volume_mm;
  for (const m of targets) {
    const s = effectiveSize(m);
    if (s.x > bv.x - 2 * margin || s.y > bv.y - 2 * margin || s.z > bv.z) {
      throw new SimError("MODEL_DOES_NOT_FIT", `${m.name} (${s.x}x${s.y}x${s.z} mm) exceeds the ${printer.product_name} build volume ${bv.x}x${bv.y}x${bv.z} mm`);
    }
  }
  // Shelf packing: rows across x, new row when full.
  const sorted = [...targets].sort((a, b) => effectiveSize(b).y - effectiveSize(a).y);
  let cx = -bv.x / 2 + margin, cy = -bv.y / 2 + margin, rowH = 0;
  for (const m of sorted) {
    const s = effectiveSize(m);
    if (cx + s.x > bv.x / 2 - margin) {
      cx = -bv.x / 2 + margin;
      cy += rowH + spacing;
      rowH = 0;
    }
    if (cy + s.y > bv.y / 2 - margin) throw new SimError("LAYOUT_FAILED", `Not all ${targets.length} models fit on the ${printer.product_name} build platform. Remove models or print in batches.`);
    m.position = { x: round(cx + s.x / 2), y: round(cy + s.y / 2), z: 0 };
    m.laid_out = true;
    cx += s.x + spacing;
    rowH = Math.max(rowH, s.y);
  }
  return { status: "laid_out", models: targets.map((m) => ({ id: m.id, position: m.position })) };
}

export function autoPack(scene: SimScene, opts: { packing_mode?: string; model_spacing_mm?: number }): Record<string, unknown> {
  if (!isSLS(scene.machine_type)) throw new SimError("INPUT_ERROR", "auto_pack is for SLS printers (Fuse). This scene targets an SLA printer; use auto_layout.");
  const printer = printerType(scene.machine_type)!;
  const bv = printer.build_volume_mm;
  let z = 5;
  for (const m of scene.models) {
    const s = effectiveSize(m);
    if (s.x > bv.x || s.y > bv.y || s.z > bv.z) throw new SimError("MODEL_DOES_NOT_FIT", `${m.name} exceeds the ${printer.product_name} build chamber`);
    m.position = { x: round((Math.random() - 0.5) * (bv.x - s.x) * 0.6), y: round((Math.random() - 0.5) * (bv.y - s.y) * 0.6), z: round(z) };
    m.laid_out = true;
    z += s.z * (opts.packing_mode === "PACK_HEIGHT" ? 0.55 : 0.8) + (opts.model_spacing_mm ?? 4);
  }
  const height = buildHeight(scene);
  if (height > bv.z) throw new SimError("PACKING_FAILED", `Packed height ${height} mm exceeds the chamber height ${bv.z} mm`);
  return { status: "packed", build_height_mm: height, packing_mode: opts.packing_mode ?? "PACK_VOLUME", models: scene.models.map((m) => ({ id: m.id, position: m.position })) };
}

export function countThatFit(scene: SimScene, models: SimModel[], spacing = 5): number {
  const printer = printerType(scene.machine_type);
  if (!printer) return 0;
  const bv = printer.build_volume_mm;
  const footprint = models.reduce((a, m) => {
    const s = effectiveSize(m);
    return a + (s.x + spacing) * (s.y + spacing);
  }, 0);
  const usable = (bv.x - 10) * (bv.y - 10);
  return Math.max(0, Math.floor((usable * (isSLS(scene.machine_type) ? 4 : 0.85)) / Math.max(footprint, 1)) - 1);
}

export function hollow(scene: SimScene, models: "ALL" | string[], wall = 2): Record<string, unknown> {
  const targets = selectModels(scene, models);
  for (const m of targets) {
    const s = m.geometry.size_mm;
    const minDim = Math.min(s.x, s.y, s.z);
    if (minDim < wall * 3) {
      m.hollowed = undefined;
      continue;
    }
    const inner = ((s.x - 2 * wall) * (s.y - 2 * wall) * (s.z - 2 * wall)) / (s.x * s.y * s.z);
    const saved = round(modelVolumeMl(m) * inner * 0.8);
    m.hollowed = { wall_thickness_mm: wall, saved_ml: saved };
    m.geometry = { ...m.geometry, cups: Math.max(m.geometry.cups, 1) };
  }
  return { status: "hollowed", models: targets.map((m) => ({ id: m.id, hollowed: m.hollowed ?? "skipped (too small for the wall thickness)" })) };
}

export function validation(scene: SimScene): Record<string, unknown> {
  const per: Record<string, unknown> = {};
  let printable = true;
  for (const m of scene.models) {
    const cups = m.oriented ? Math.max(0, m.geometry.cups - 1) : m.geometry.cups;
    const cupsLeft = Math.max(0, cups - (m.drain_holes ?? 0));
    const minima = m.supports ? 0 : m.oriented ? Math.max(0, m.geometry.minima - 1) : m.geometry.minima;
    const under = !!m.supports && m.supports.density < 0.7 && m.geometry.overhang === "high";
    const sls = isSLS(scene.machine_type);
    const ok = sls ? true : cupsLeft === 0 && minima === 0 && !under;
    if (!ok) printable = false;
    per[`{${m.id}}`] = sls
      ? { cups: 0, unsupported_minima: 0, undersupported: false, has_seamline: false, thin_walls: m.geometry.thin_walls, printable: true }
      : { cups: cupsLeft, unsupported_minima: minima, undersupported: under, has_seamline: false, thin_walls: m.geometry.thin_walls, printable: ok };
  }
  return { per_model_results: per, printable, model_count: scene.models.length };
}

export function cupDetection(scene: SimScene): Record<string, unknown> {
  const per: Record<string, unknown> = {};
  for (const m of scene.models) {
    const cups = Math.max(0, (m.oriented ? Math.max(0, m.geometry.cups - 1) : m.geometry.cups) - (m.drain_holes ?? 0));
    per[`{${m.id}}`] = { cup_count: cups };
  }
  return { per_model_results: per };
}

export function minimaDetection(scene: SimScene): Record<string, unknown> {
  const per: Record<string, unknown> = {};
  for (const m of scene.models) per[`{${m.id}}`] = { unsupported_minima_count: m.supports ? 0 : m.oriented ? Math.max(0, m.geometry.minima - 1) : m.geometry.minima };
  return { per_model_results: per };
}

export function supportedness(scene: SimScene): Record<string, unknown> {
  const per: Record<string, unknown> = {};
  for (const m of scene.models) {
    const base = m.geometry.overhang === "high" ? 18 : m.geometry.overhang === "medium" ? 9 : 3;
    per[`{${m.id}}`] = { unsupported_percentage: m.supports ? round(base * 0.05) : m.oriented ? round(base * 0.6) : base };
  }
  return { per_model_results: per };
}

export function thinWalls(scene: SimScene, models: "ALL" | string[], threshold: number): Record<string, unknown> {
  const per: Record<string, unknown> = {};
  for (const m of selectModels(scene, models)) {
    const hit = m.geometry.thin_walls && threshold >= 0.8;
    per[`{${m.id}}`] = hit
      ? { regions: [{ volume_mm3: round(modelVolumeMl(m) * 30), bounding_box: boundingBox(m), min_thickness_mm: round(threshold * 0.6) }] }
      : { regions: [] };
  }
  return { threshold_mm: threshold, per_model_results: per };
}

export function interferences(scene: SimScene, offset = 0): Record<string, unknown> {
  const pairs: [string, string][] = [];
  const ms = scene.models;
  for (let i = 0; i < ms.length; i++) {
    for (let j = i + 1; j < ms.length; j++) {
      const a = boundingBox(ms[i]!), b = boundingBox(ms[j]!);
      const overlap = a.min_corner.x - offset < b.max_corner.x && a.max_corner.x + offset > b.min_corner.x && a.min_corner.y - offset < b.max_corner.y && a.max_corner.y + offset > b.min_corner.y;
      const sameLayerZ = isSLS(scene.machine_type) ? Math.abs(ms[i]!.position.z - ms[j]!.position.z) < Math.min(effectiveSize(ms[i]!).z, effectiveSize(ms[j]!).z) : true;
      if (overlap && sameLayerZ) pairs.push([ms[i]!.id, ms[j]!.id]);
    }
  }
  return { interferences: pairs, count: pairs.length };
}

// ---------------------------------------------------------------------------
// Printers and jobs
// ---------------------------------------------------------------------------

export type PrinterStatus = "IDLE" | "PRINTING" | "PAUSED" | "FINISHED" | "ERROR" | "OFFLINE" | "PREHEATING" | "COOLING";

export interface SimPrinter {
  id: string;
  environment_id: string;
  serial: string;
  alias: string | null;
  machine_type: string;
  product_name: string;
  technology: "SLA" | "SLS";
  status: PrinterStatus;
  online: boolean;
  ip_address: string | null;
  firmware_version: string | null;
  tank: { material_code: string; installed_at: string; ml_printed: number; max_ml: number } | null;
  cartridge: { material_code: string; remaining_ml: number; capacity_ml: number } | null;
  powder: { material_code: string; hopper_kg: number; capacity_kg: number } | null;
  current_job_id: string | null;
  error: { code: string; message: string; since: string } | null;
  quirks: Record<string, unknown>;
  print_count: number;
  print_hours: number;
  state_changed_at: string;
}

export type JobStatus = "queued" | "printing" | "paused" | "finished" | "failed" | "aborted" | "submitted";

export interface PrintJob {
  id: string;
  environment_id: string;
  printer_id: string | null;
  printer_serial: string;
  name: string;
  status: JobStatus;
  source: string;
  machine_type: string | null;
  material_code: string | null;
  layer_thickness_mm: string | null;
  model_count: number;
  volume_ml: number | null;
  layer_count: number | null;
  height_mm: number | null;
  estimated_seconds: number | null;
  scene_snapshot: Record<string, unknown> | null;
  fail_at_fraction: number | null;
  failure: { code: string; message: string } | null;
  progress: number;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface EnvSettings {
  sim_speed: number;
  auto_start_queued: boolean;
  failure_rate: number;
}

const FINISHED_AUTO_CLEAR_SIM_SECONDS = 20 * 60;

export const FAILURE_MODES: { code: string; message: string; weight: number; tech: ("SLA" | "SLS")[] }[] = [
  { code: "PART_DETACHED", message: "Print failed: a part detached from the build platform.", weight: 4, tech: ["SLA"] },
  { code: "SUPPORT_FAILURE", message: "Print failed: supports broke away during printing.", weight: 3, tech: ["SLA"] },
  { code: "TANK_FILM_DAMAGED", message: "Resin tank film damaged. Replace the tank before printing again.", weight: 1, tech: ["SLA"] },
  { code: "LEVEL_SENSE_ERROR", message: "Level sensing failed: resin level could not be verified.", weight: 1, tech: ["SLA"] },
  { code: "PRINTER_TEMPERATURE_LOW", message: "Printer could not reach operating temperature.", weight: 1, tech: ["SLA"] },
  { code: "POWDER_SPREAD_ERROR", message: "Powder recoater could not spread a full layer.", weight: 3, tech: ["SLS"] },
  { code: "CHAMBER_TEMPERATURE_ERROR", message: "Build chamber temperature out of range.", weight: 2, tech: ["SLS"] },
];

/** Deterministic per-job failure roll so seeds and tests are reproducible. */
export function rollFailure(seed: string, failureRate: number, tech: "SLA" | "SLS"): { fail_at_fraction: number; failure: { code: string; message: string } } | null {
  const h = createHash("sha256").update(seed).digest();
  const roll = (h[0]! * 256 + h[1]!) / 65535;
  if (roll >= failureRate) return null;
  const at = 0.08 + ((h[2]! * 256 + h[3]!) / 65535) * 0.84;
  const modes = FAILURE_MODES.filter((f) => f.tech.includes(tech));
  const total = modes.reduce((a, f) => a + f.weight, 0);
  let pick = ((h[4]! * 256 + h[5]!) / 65535) * total;
  for (const f of modes) {
    pick -= f.weight;
    if (pick <= 0) return { fail_at_fraction: round(at, 3), failure: { code: f.code, message: f.message } };
  }
  const last = modes[modes.length - 1]!;
  return { fail_at_fraction: round(at, 3), failure: { code: last.code, message: last.message } };
}

export interface AdvanceResult {
  printer: SimPrinter;
  jobs: PrintJob[]; // jobs that changed
  events: { kind: string; job_id?: string; message: string; at: string }[];
}

/**
 * Bring a printer and its jobs up to `now`. Called lazily on every read so no
 * background worker is needed. Returns the changed rows.
 */
export function advancePrinter(printer: SimPrinter, jobs: PrintJob[], env: EnvSettings, now: Date): AdvanceResult {
  const p: SimPrinter = { ...printer };
  const changed = new Map<string, PrintJob>();
  const events: AdvanceResult["events"] = [];
  const speed = Math.max(0.01, env.sim_speed);
  const nowMs = now.getTime();
  if (!p.online || p.status === "OFFLINE") return { printer: p, jobs: [], events };

  for (let guard = 0; guard < 20; guard++) {
    const current = p.current_job_id ? (changed.get(p.current_job_id) ?? jobs.find((j) => j.id === p.current_job_id)) : undefined;

    if (current && (current.status === "printing" || current.status === "paused") && current.started_at && current.estimated_seconds) {
      if (current.status === "paused") break;
      const startMs = new Date(current.started_at).getTime();
      const simElapsed = ((nowMs - startMs) / 1000) * speed;
      const fraction = Math.min(1, simElapsed / current.estimated_seconds);
      // Fuse phases
      if (p.technology === "SLS") {
        const phases = (current.scene_snapshot?.["phases"] ?? null) as { preheat_seconds: number; print_seconds: number; cooldown_seconds: number } | null;
        if (phases) {
          const t = fraction * current.estimated_seconds;
          const phase: PrinterStatus = t < phases.preheat_seconds ? "PREHEATING" : t < phases.preheat_seconds + phases.print_seconds ? "PRINTING" : "COOLING";
          if (p.status !== phase && fraction < 1) {
            p.status = phase;
            p.state_changed_at = new Date(startMs + (t / speed) * 1000).toISOString();
          }
        }
      }
      // Cartridge runs dry -> pause (SLA only)
      if (p.technology === "SLA" && p.cartridge && current.volume_ml) {
        const needed = current.volume_ml * fraction;
        if (needed > p.cartridge.remaining_ml + 0.01) {
          const atFraction = p.cartridge.remaining_ml / current.volume_ml;
          const atMs = startMs + ((atFraction * current.estimated_seconds) / speed) * 1000;
          const at = new Date(atMs).toISOString();
          p.cartridge = { ...p.cartridge, remaining_ml: 0 };
          p.status = "PAUSED";
          p.error = { code: "CARTRIDGE_EMPTY", message: "Cartridge empty. Insert a new cartridge to resume.", since: at };
          p.state_changed_at = at;
          changed.set(current.id, { ...current, status: "paused", progress: round(atFraction, 4) });
          events.push({ kind: "paused", job_id: current.id, message: `${p.serial}: cartridge empty at ${Math.round(atFraction * 100)}%`, at });
          break;
        }
      }
      if (current.fail_at_fraction !== null && fraction >= current.fail_at_fraction && current.failure) {
        const atMs = startMs + ((current.fail_at_fraction * current.estimated_seconds) / speed) * 1000;
        const at = new Date(atMs).toISOString();
        consume(p, current, current.fail_at_fraction);
        p.status = "ERROR";
        p.error = { code: current.failure.code, message: current.failure.message, since: at };
        p.current_job_id = null;
        p.state_changed_at = at;
        p.print_hours = round(p.print_hours + (current.fail_at_fraction * current.estimated_seconds) / 3600, 2);
        changed.set(current.id, { ...current, status: "failed", progress: current.fail_at_fraction, finished_at: at });
        events.push({ kind: "failed", job_id: current.id, message: `${p.serial}: ${current.failure.message}`, at });
        break;
      }
      if (fraction >= 1) {
        const at = new Date(startMs + (current.estimated_seconds / speed) * 1000).toISOString();
        consume(p, current, 1);
        p.status = "FINISHED";
        p.state_changed_at = at;
        p.print_count += 1;
        p.print_hours = round(p.print_hours + current.estimated_seconds / 3600, 2);
        changed.set(current.id, { ...current, status: "finished", progress: 1, finished_at: at });
        events.push({ kind: "finished", job_id: current.id, message: `${p.serial}: finished ${current.name}`, at });
        continue;
      }
      // still printing
      changed.set(current.id, { ...current, progress: round(fraction, 4) });
      if (p.status !== "PRINTING" && p.technology === "SLA") p.status = "PRINTING";
      break;
    }

    if (p.status === "FINISHED") {
      const clearAt = new Date(p.state_changed_at).getTime() + (FINISHED_AUTO_CLEAR_SIM_SECONDS / speed) * 1000;
      if (nowMs >= clearAt) {
        p.status = "IDLE";
        p.current_job_id = null;
        p.state_changed_at = new Date(clearAt).toISOString();
        events.push({ kind: "cleared", message: `${p.serial}: build platform cleared`, at: p.state_changed_at });
        continue;
      }
      break;
    }

    if (p.status === "IDLE") {
      if (!env.auto_start_queued) break;
      const next = jobs
        .map((j) => changed.get(j.id) ?? j)
        .filter((j) => j.status === "queued" && j.printer_id === p.id)
        .sort((a, b) => a.queued_at.localeCompare(b.queued_at))[0];
      if (!next) break;
      const startMs = Math.max(new Date(p.state_changed_at).getTime(), new Date(next.queued_at).getTime());
      if (startMs > nowMs) break;
      const started = startJob(p, next, new Date(startMs));
      changed.set(next.id, started);
      events.push({ kind: "started", job_id: next.id, message: `${p.serial}: started ${next.name}`, at: started.started_at! });
      continue;
    }
    break;
  }
  return { printer: p, jobs: [...changed.values()], events };
}

export function startJob(p: SimPrinter, job: PrintJob, at: Date): PrintJob {
  p.current_job_id = job.id;
  p.status = p.technology === "SLS" ? "PREHEATING" : "PRINTING";
  p.state_changed_at = at.toISOString();
  p.error = null;
  return { ...job, status: "printing", started_at: at.toISOString(), progress: 0 };
}

function consume(p: SimPrinter, job: PrintJob, fraction: number): void {
  const ml = (job.volume_ml ?? 0) * fraction;
  if (p.technology === "SLA") {
    if (p.cartridge) p.cartridge = { ...p.cartridge, remaining_ml: round(Math.max(0, p.cartridge.remaining_ml - ml)) };
    if (p.tank) p.tank = { ...p.tank, ml_printed: round(p.tank.ml_printed + ml) };
  } else if (p.powder) {
    const density = material(p.powder.material_code)?.density ?? 1;
    const kg = (ml * density * 0.3 * 8) / 1000; // bed volume ~ 8x part volume, 30% fresh powder
    p.powder = { ...p.powder, hopper_kg: round(Math.max(0, p.powder.hopper_kg - kg), 2) };
  }
}

/** Can this printer accept `scene` right now? Mirrors PreForm's checks. */
export function printabilityProblems(p: SimPrinter, scene: SimScene, printNow: boolean): string[] {
  const problems: string[] = [];
  if (!p.online || p.status === "OFFLINE") problems.push(`${p.serial} is offline`);
  if (p.machine_type !== scene.machine_type.toUpperCase()) problems.push(`Scene is prepared for ${scene.machine_type} but ${p.serial} is a ${p.product_name} (${p.machine_type}). Call update_scene with machine_type=${p.machine_type} and re-run supports/layout.`);
  const mat = scene.material_code.toUpperCase();
  if (p.technology === "SLA") {
    if (p.tank && p.tank.material_code !== mat) problems.push(`Tank on ${p.serial} holds ${p.tank.material_code}, scene uses ${mat}. Change the tank or the scene material.`);
    if (p.cartridge && p.cartridge.material_code !== mat) problems.push(`Cartridge on ${p.serial} is ${p.cartridge.material_code}, scene uses ${mat}.`);
  } else if (p.powder && p.powder.material_code !== mat) problems.push(`Hopper on ${p.serial} holds ${p.powder.material_code}, scene uses ${mat}.`);
  if (p.status === "ERROR") problems.push(`${p.serial} has an unresolved error (${p.error?.code ?? "unknown"}). Clear it from the dashboard first.`);
  if (printNow && p.status !== "IDLE") problems.push(`${p.serial} is ${p.status}; print_now requires an idle printer. Queue the job instead (print_now=false).`);
  return problems;
}

/** The device object exposed by list_devices / get_device. */
export function devicePayload(p: SimPrinter, job: PrintJob | undefined, env: EnvSettings, queued: number): Record<string, unknown> {
  const remaining = job && job.status === "printing" && job.estimated_seconds ? Math.round(job.estimated_seconds * (1 - job.progress)) : null;
  const totalLayers = job?.layer_count ?? null;
  return {
    id: p.serial,
    alias: p.alias ?? p.serial,
    product_name: p.product_name,
    machine_type: p.machine_type,
    technology: p.technology,
    connection_type: "LOCAL_NETWORK",
    ip_address: p.ip_address,
    firmware_version: p.firmware_version,
    status: p.status,
    can_print: p.online && p.status === "IDLE",
    printer_status: {
      status: p.status,
      current_job: job
        ? {
            job_id: job.id,
            name: job.name,
            status: job.status,
            progress: job.progress,
            current_layer: totalLayers ? Math.round(totalLayers * job.progress) : null,
            total_layers: totalLayers,
            started_at: job.started_at,
            estimated_print_time_remaining_s: remaining,
            estimated_total_time_s: job.estimated_seconds,
            material_code: job.material_code,
          }
        : null,
      queued_jobs: queued,
      error: p.error,
      tank: p.tank ? { material_code: p.tank.material_code, material_name: material(p.tank.material_code)?.name ?? null, ml_printed: p.tank.ml_printed, lifetime_remaining_pct: Math.max(0, Math.round((1 - p.tank.ml_printed / p.tank.max_ml) * 100)) } : null,
      cartridge: p.cartridge ? { material_code: p.cartridge.material_code, material_name: material(p.cartridge.material_code)?.name ?? null, remaining_ml: p.cartridge.remaining_ml, capacity_ml: p.cartridge.capacity_ml, low: p.cartridge.remaining_ml < 100 } : null,
      powder: p.powder ? { material_code: p.powder.material_code, material_name: material(p.powder.material_code)?.name ?? null, hopper_kg: p.powder.hopper_kg, capacity_kg: p.powder.capacity_kg, low: p.powder.hopper_kg < 1 } : null,
      print_count: p.print_count,
      print_hours: p.print_hours,
    },
    simulated: true,
    simulation_speed: env.sim_speed,
  };
}

export function round(n: number, digits = 2): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

export type { PrinterType };

export function isSLSScene(scene: SimScene): boolean {
  return isSLS(scene.machine_type);
}
