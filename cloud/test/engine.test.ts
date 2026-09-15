import { describe, expect, it } from "vitest";
import { listMaterialsPayload, validSceneSettings } from "../lib/sim/catalog";
import * as E from "../lib/sim/engine";
import { measureStl, resolvePart } from "../lib/sim/parts";
import { TOOLS } from "../lib/mcp/catalog";
import { tools as localTools } from "../../src/tools";

async function sceneWith(files: string[], machine = "FORM-4-0", material = "FLGPGR05", lt: number | "ADAPTIVE" = 0.1): Promise<E.SimScene> {
  const scene: E.SimScene = { scene_key: "default", machine_type: machine, material_code: material, layer_thickness_mm: lt, print_setting: "DEFAULT", models: [] };
  for (const f of files) {
    const geometry = await resolvePart(f);
    scene.models.push({ id: E.newModelId(), name: geometry.name, file: f, geometry, position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0 }, scale: 1, lock: "FREE", oriented: false, laid_out: false });
  }
  return scene;
}

describe("tool surface parity", () => {
  it("exposes every local tool under the same name", () => {
    const cloud = new Set(TOOLS.map((t) => t.name));
    for (const t of localTools) expect(cloud.has(t.name), t.name).toBe(true);
  });
  it("keeps print_to_printer gated by default", () => {
    expect(TOOLS.find((t) => t.name === "print_to_printer")?.defaultPolicy).toBe("approve");
    expect(TOOLS.find((t) => t.name === "list_devices")?.defaultPolicy).toBe("allow");
  });
});

describe("catalog", () => {
  it("validates scene settings like PreForm", () => {
    expect(validSceneSettings("FORM-4-0", "FLGPGR05", 0.1).ok).toBe(true);
    expect(validSceneSettings("FORM-4-0", "FLGPGR05", 0.2).ok).toBe(false);
    expect(validSceneSettings("FORM-4-0", "FLP12B01", 0.11).ok).toBe(false);
    expect(validSceneSettings("FS30-1-0", "FLP12B01", 0.11).ok).toBe(true);
    expect(validSceneSettings("form-4-0", "flgpbk05", 0.05).ok).toBe(true);
  });
  it("lists materials with scene_settings", () => {
    const p = listMaterialsPayload().printer_types as { supported_machine_type_ids: string[]; materials: { material_settings: { scene_settings: { machine_type: string } }[] }[] }[];
    expect(p.length).toBeGreaterThan(4);
    expect(p[0]!.materials[0]!.material_settings[0]!.scene_settings.machine_type).toBe("FORM-4-0");
  });
});

describe("parts", () => {
  it("resolves sample parts, derived parts, and measures STL", async () => {
    expect((await resolvePart("sample:bracket")).source).toBe("sample");
    expect((await resolvePart("/Users/me/parts/my_bracket_v3.stl")).source).toBe("sample");
    const d = await resolvePart("/tmp/unknown_thing.stl");
    expect(d.source).toBe("derived");
    expect(d.volume_ml).toBeGreaterThan(0);
    // 10 mm cube, binary STL
    const tris: number[][] = [];
    const q = (a: number[], b: number[], c: number[], d: number[]) => { tris.push([...a, ...b, ...c], [...a, ...c, ...d]); };
    const v = (x: number, y: number, z: number) => [x, y, z];
    q(v(0,0,0), v(0,10,0), v(10,10,0), v(10,0,0));
    q(v(0,0,10), v(10,0,10), v(10,10,10), v(0,10,10));
    q(v(0,0,0), v(10,0,0), v(10,0,10), v(0,0,10));
    q(v(0,10,0), v(0,10,10), v(10,10,10), v(10,10,0));
    q(v(0,0,0), v(0,0,10), v(0,10,10), v(0,10,0));
    q(v(10,0,0), v(10,10,0), v(10,10,10), v(10,0,10));
    const buf = Buffer.alloc(84 + tris.length * 50);
    buf.writeUInt32LE(tris.length, 80);
    tris.forEach((t, i) => { const o = 84 + i * 50 + 12; t.forEach((n, k) => buf.writeFloatLE(n, o + k * 4)); });
    const m = measureStl(buf);
    expect(m.size_mm).toEqual({ x: 10, y: 10, z: 10 });
    expect(m.volume_ml).toBeCloseTo(1, 1);
    expect(m.triangles).toBe(12);
  });
});

describe("prep pipeline", () => {
  it("orients, supports, lays out, validates and estimates", async () => {
    const s = await sceneWith(["sample:manifold", "sample:bracket"]);
    expect((E.validation(s) as { printable: boolean }).printable).toBe(false);
    expect((E.interferences(s) as { count: number }).count).toBe(1);
    E.autoOrient(s, "ALL");
    E.autoSupport(s, "ALL", {});
    E.autoLayout(s, "ALL");
    expect((E.interferences(s) as { count: number }).count).toBe(0);
    const v = E.validation(s) as { printable: boolean; per_model_results: Record<string, { cups: number }> };
    const cups = Object.values(v.per_model_results).reduce((a, r) => a + r.cups, 0);
    expect(cups).toBeGreaterThan(0); // manifold still traps resin
    const est = E.estimate(s);
    expect(est.print_time_seconds).toBeGreaterThan(3600);
    expect(est.layer_count).toBeGreaterThan(100);
    expect(Number(est.material_usage["total_ml"])).toBeGreaterThan(Number(est.material_usage["parts_ml"]));
  });
  it("refuses models that do not fit", async () => {
    const s = await sceneWith(["sample:vase"], "FORM-3-0", "FLGPGR04", 0.1);
    s.models[0]!.scale = 3;
    expect(() => E.autoLayout(s, "ALL")).toThrow(/build volume/);
  });
  it("routes SLS through auto_pack with preheat and cooldown", async () => {
    const s = await sceneWith(["sample:gear", "sample:knob"], "FS30-1-0", "FLP12B01", 0.11);
    expect(() => E.autoLayout(s, "ALL")).toThrow(/auto_pack/);
    E.autoPack(s, {});
    const est = E.estimate(s);
    expect(est.phases?.preheat_seconds).toBe(3600);
    expect(est.print_time_seconds).toBeGreaterThan(est.phases!.print_seconds);
  });
});

function printer(over: Partial<E.SimPrinter> = {}): E.SimPrinter {
  return { id: "p1", environment_id: "e", serial: "Form4-Test", alias: null, machine_type: "FORM-4-0", product_name: "Form 4", technology: "SLA", status: "IDLE", online: true, ip_address: null, firmware_version: null, tank: { material_code: "FLGPGR05", installed_at: "2026-01-01", ml_printed: 0, max_ml: 3000 }, cartridge: { material_code: "FLGPGR05", remaining_ml: 500, capacity_ml: 1000 }, powder: null, current_job_id: null, error: null, quirks: {}, print_count: 0, print_hours: 0, state_changed_at: "2026-09-14T00:00:00.000Z", ...over };
}
function job(over: Partial<E.PrintJob> = {}): E.PrintJob {
  return { id: "j1", environment_id: "e", printer_id: "p1", printer_serial: "Form4-Test", name: "test", status: "queued", source: "mcp", machine_type: "FORM-4-0", material_code: "FLGPGR05", layer_thickness_mm: "0.1", model_count: 1, volume_ml: 100, layer_count: 1000, height_mm: 100, estimated_seconds: 3600, scene_snapshot: null, fail_at_fraction: null, failure: null, progress: 0, queued_at: "2026-09-14T00:00:00.000Z", started_at: null, finished_at: null, ...over };
}
const env: E.EnvSettings = { sim_speed: 60, auto_start_queued: true, failure_rate: 0 };
const T0 = new Date("2026-09-14T00:00:00.000Z").getTime();

describe("printer state machine", () => {
  it("starts a queued job, progresses, finishes, consumes resin, clears", () => {
    let r = E.advancePrinter(printer(), [job()], env, new Date(T0 + 1000));
    expect(r.printer.status).toBe("PRINTING");
    expect(r.jobs[0]!.status).toBe("printing");
    const started = r.jobs[0]!;
    r = E.advancePrinter(r.printer, [started], env, new Date(T0 + 31_000)); // 30 s real = 1800 sim s = 50%
    expect(r.jobs[0]!.progress).toBeCloseTo(0.5, 1);
    r = E.advancePrinter(r.printer, [started], env, new Date(T0 + 61_000));
    expect(r.printer.status).toBe("FINISHED");
    expect(r.jobs[0]!.status).toBe("finished");
    expect(r.printer.cartridge!.remaining_ml).toBe(400);
    expect(r.printer.print_count).toBe(1);
    const done = r.jobs[0]!;
    r = E.advancePrinter(r.printer, [done], env, new Date(T0 + 61_000 + 21 * 1000)); // 20 sim min = 20 real s at 60x
    expect(r.printer.status).toBe("IDLE");
  });
  it("fails at the rolled fraction", () => {
    const j = job({ status: "printing", started_at: new Date(T0).toISOString(), fail_at_fraction: 0.3, failure: { code: "PART_DETACHED", message: "detached" } });
    const r = E.advancePrinter(printer({ status: "PRINTING", current_job_id: "j1" }), [j], env, new Date(T0 + 40_000));
    expect(r.printer.status).toBe("ERROR");
    expect(r.printer.error?.code).toBe("PART_DETACHED");
    expect(r.jobs[0]!.status).toBe("failed");
    expect(r.jobs[0]!.progress).toBe(0.3);
    expect(r.printer.cartridge!.remaining_ml).toBe(470);
  });
  it("pauses when the cartridge runs dry", () => {
    const j = job({ status: "printing", started_at: new Date(T0).toISOString(), volume_ml: 800 });
    const r = E.advancePrinter(printer({ status: "PRINTING", current_job_id: "j1" }), [j], env, new Date(T0 + 59_000));
    expect(r.printer.status).toBe("PAUSED");
    expect(r.printer.error?.code).toBe("CARTRIDGE_EMPTY");
    expect(r.jobs[0]!.status).toBe("paused");
  });
  it("does nothing while offline and respects auto-start off", () => {
    expect(E.advancePrinter(printer({ online: false, status: "OFFLINE" }), [job()], env, new Date(T0 + 1000)).jobs).toHaveLength(0);
    expect(E.advancePrinter(printer(), [job()], { ...env, auto_start_queued: false }, new Date(T0 + 1000)).printer.status).toBe("IDLE");
  });
  it("rolls failures deterministically", () => {
    expect(E.rollFailure("a", 0, "SLA")).toBeNull();
    const f = E.rollFailure("seed-1", 1, "SLA");
    expect(f?.fail_at_fraction).toBeGreaterThan(0.05);
    expect(E.rollFailure("seed-1", 1, "SLA")).toEqual(f);
  });
  it("reports printability problems", async () => {
    const s = await sceneWith(["sample:gear"], "FORM-4-0", "FLGPBK05", 0.1);
    const problems = E.printabilityProblems(printer(), s, true);
    expect(problems.join(" ")).toMatch(/Tank/);
  });
});
