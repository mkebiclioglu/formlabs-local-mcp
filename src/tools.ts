/**
 * The MCP tool surface. Each tool wraps one PreFormServer endpoint (Local API
 * 0.9.x). Long-running endpoints are called with `?async=true` and polled, so
 * every tool call is synchronous from the model's point of view and reports
 * progress while it waits.
 *
 * Conventions:
 * - `scene_id` defaults to "default" so simple flows never track IDs.
 * - Every file path is validated by ./paths.ts before it is forwarded.
 * - Tools are plain objects here (not bound to the SDK) so they can be unit
 *   tested without a transport; ./server.ts registers them.
 */

import { existsSync } from "node:fs";
import * as z from "zod";
import type { AppContext } from "./app.js";
import { isRecord, PreFormError, type Json } from "./client.js";
import { DOWNLOAD_PAGE, isLoopback, managedInstallDir } from "./config.js";
import { installPreformServer, installedVersion } from "./installer.js";
import { FORM, FPS, IMAGE, MODEL, inputPath, outputPath } from "./paths.js";
import { withUnlistedPrinterTypes } from "./printers.js";

export interface ToolCtx {
  progress(fraction: number, message: string): Promise<void>;
  signal: AbortSignal;
}

export interface Annotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint?: boolean;
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  annotations: Annotations;
  input: S;
  handler(app: AppContext, args: z.infer<S>, ctx: ToolCtx): Promise<unknown>;
}

const READ_ONLY: Annotations = { readOnlyHint: true, destructiveHint: false };
const MUTATING: Annotations = { readOnlyHint: false, destructiveHint: false };
const DESTRUCTIVE: Annotations = { readOnlyHint: false, destructiveHint: true };

export const tools: ToolDef[] = [];

function tool<S extends z.ZodObject>(def: ToolDef<S>): void {
  tools.push(def as unknown as ToolDef);
}

export function toolByName(name: string): ToolDef {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Unknown tool ${name}`);
  return t;
}

/** Validate args with the tool's schema and run it. Used by the server and by tests. */
export async function callTool(app: AppContext, name: string, args: unknown, ctx: ToolCtx): Promise<unknown> {
  const t = toolByName(name);
  const parsed = t.input.safeParse(args ?? {});
  if (!parsed.success) throw new Error(`Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return t.handler(app, parsed.data, ctx);
}

// ---------------------------------------------------------------------------
// Shared schemas and helpers
// ---------------------------------------------------------------------------

const sceneId = z.string().default("default").describe("Scene id; omit for the default scene");
const models = z.union([z.literal("ALL"), z.array(z.string())]).default("ALL").describe('"ALL" or a list of model ids');
const xyz = z.object({ x: z.number(), y: z.number(), z: z.number() });
const orientation = z.record(z.string(), z.unknown()).describe("Euler degrees {x,y,z}, or {z_direction:[..], x_direction:[..]} unit vectors");
const layer = z.union([z.number(), z.literal("ADAPTIVE")]);

function body(fields: Record<string, unknown>): Json {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

function progressFor(ctx: ToolCtx, label: string) {
  return async (fraction: number) => ctx.progress(fraction, label);
}

/** PreFormServer keys per-model results by "{uuid}" while scene models use "uuid". */
function bareId(id: string): string {
  return id.replace(/^\{|\}$/g, "");
}

// ---------------------------------------------------------------------------
// Health, status, install
// ---------------------------------------------------------------------------

tool({
  name: "health_check",
  description: "Return the PreFormServer version. Call this first to confirm the server is reachable; it starts PreFormServer if needed.",
  annotations: READ_ONLY,
  input: z.object({}),
  handler: (app) => app.client.get("/"),
});

tool({
  name: "preform_status",
  description:
    "Report how this MCP server is set up without touching PreFormServer: whether PreFormServer is installed and where, its version, local or remote mode, allowed directories, and how file paths are rewritten for a Wine-hosted PreFormServer (path_style, path_map). Use it to diagnose setup problems before health_check.",
  annotations: READ_ONLY,
  input: z.object({}),
  async handler(app) {
    const cfg = app.config;
    const exe = cfg.preformServerPath;
    const installed = !!exe && existsSync(exe);
    return {
      mode: app.backend.mode,
      installed,
      executable: exe ?? null,
      version: installed ? ((await installedVersion(exe, cfg)) ?? null) : null,
      managed_install_dir: managedInstallDir(cfg.platform, cfg.home, cfg.env),
      base_url: cfg.baseUrl,
      spawn: cfg.spawn,
      launcher: cfg.launcher,
      path_style: cfg.pathStyle,
      path_map: cfg.pathMap.map((m) => ({ local: m.local, remote: m.remote })),
      remote: cfg.remote ? { host: cfg.remote.host, port: cfg.remote.port, spawn: cfg.remote.spawn } : null,
      allowed_paths: cfg.allowedPaths,
      credentials_configured: !!cfg.credentials,
      platform: cfg.platform,
      download_page: DOWNLOAD_PAGE,
      hint: installed ? "Call health_check next." : "PreFormServer is not installed. With the user's permission call install_preform_server.",
    };
  },
});

tool({
  name: "install_preform_server",
  description:
    "Download the latest PreFormServer from Formlabs (about 170 MB), verify Formlabs' code signature, and install it into a user-owned folder. Ask the user before calling this. Safe to call again: it is a no-op when the installed version is already the latest.",
  annotations: DESTRUCTIVE,
  input: z.object({ force: z.boolean().default(false).describe("Reinstall even if the latest version is already installed") }),
  async handler(app, { force }, ctx) {
    const result = await installPreformServer(app.config, { force, log: app.log, progress: (f, m) => ctx.progress(f, m) });
    if (!app.config.preformServerPath || !app.config.spawn) {
      app.config.preformServerPath = result.executable;
      app.config.spawn = !app.config.remote && !app.config.env["PREFORM_SERVER_URL"];
    }
    return { ...result, next: "Call health_check to start it." };
  },
});

tool({
  name: "get_user",
  description: "Return the Formlabs account currently logged in (after `login`).",
  annotations: READ_ONLY,
  input: z.object({}),
  handler: (app) => app.client.get("/user/"),
});

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

tool({
  name: "create_scene",
  description:
    "Create a new scene for a printer and material. Returns the scene including its `id`. Provide EITHER machine_type + material_code + layer_thickness_mm OR the absolute path of a .fps print-settings file. Get valid codes from list_printer_types and list_materials; never guess them.",
  annotations: MUTATING,
  input: z.object({
    machine_type: z.string().optional().describe("e.g. FORM-4-0, FS30-1-0"),
    material_code: z.string().optional().describe("e.g. FLGPBK05"),
    layer_thickness_mm: layer.optional().describe('e.g. 0.1, 0.05, 0.025 or "ADAPTIVE"'),
    print_setting: z.string().default("DEFAULT"),
    fps_file: z.string().optional().describe("Absolute path to a .fps file"),
  }),
  async handler(app, a) {
    let payload: Json;
    if (a.fps_file) {
      const local = inputPath(a.fps_file, app.config, FPS);
      payload = { fps_file: await app.backend.stageInput(local) };
    } else {
      if (!(a.machine_type && a.material_code && a.layer_thickness_mm !== undefined)) {
        throw new Error("Provide either fps_file or all of machine_type, material_code and layer_thickness_mm.");
      }
      payload = { machine_type: a.machine_type, material_code: a.material_code, layer_thickness_mm: a.layer_thickness_mm, print_setting: a.print_setting };
    }
    try {
      return await app.client.post("/scene/", payload);
    } catch (err) {
      if (err instanceof PreFormError && err.code === "INPUT_ERROR" && !a.fps_file) {
        throw new PreFormError(
          err.status,
          err.code,
          `${err.detail}. The combination machine_type=${a.machine_type} material_code=${a.material_code} layer_thickness_mm=${a.layer_thickness_mm} is not offered by PreForm. Call list_materials(machine_type=...) and use one of the listed scene_settings exactly.`,
          err.body,
        );
      }
      throw err;
    }
  },
});

tool({
  name: "list_scenes",
  description: "List every scene PreFormServer currently holds in memory.",
  annotations: READ_ONLY,
  input: z.object({}),
  handler: (app) => app.client.get("/scenes/"),
});

tool({
  name: "get_scene",
  description: "Get a scene: its models (ids, bounding boxes, supports), print settings, material usage and build volume.",
  annotations: READ_ONLY,
  input: z.object({ scene_id: sceneId }),
  handler: (app, { scene_id }) => app.client.get(`/scene/${scene_id}/`),
});

tool({
  name: "update_scene",
  description: "Change a scene's printer, material, layer thickness or print setting while keeping its models.",
  annotations: MUTATING,
  input: z.object({ scene_id: sceneId, machine_type: z.string().optional(), material_code: z.string().optional(), layer_thickness_mm: layer.optional(), print_setting: z.string().optional() }),
  handler(app, { scene_id, ...rest }) {
    const payload = body(rest);
    if (Object.keys(payload).length === 0) throw new Error("Nothing to update.");
    return app.client.put(`/scene/${scene_id}/`, payload);
  },
});

tool({
  name: "delete_scene",
  description: 'Delete a scene and its models. Deleting "default" resets it to empty.',
  annotations: DESTRUCTIVE,
  input: z.object({ scene_id: z.string() }),
  async handler(app, { scene_id }) {
    return (await app.client.delete(`/scene/${scene_id}/`)) ?? { status: "deleted", scene_id };
  },
});

tool({
  name: "load_form",
  description: "Open an existing .form file as a new scene. `file` must be an absolute path. Returns the scene.",
  annotations: MUTATING,
  input: z.object({ file: z.string() }),
  async handler(app, { file }, ctx) {
    const local = inputPath(file, app.config, FORM);
    return app.client.postAsync("/load-form/", { file: await app.backend.stageInput(local) }, progressFor(ctx, "loading .form"));
  },
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

tool({
  name: "import_model",
  description:
    "Import a model file (STL, OBJ, 3MF, STEP) into a scene. `file` must be an absolute path. Returns the model with its `id`. Defaults differ from the raw API: repair_behavior=REPAIR (the API default ERROR fails on slightly broken meshes most CAD tools export) and units=MILLIMETERS (use INCHES for inch files, DETECTED to let PreForm guess). After importing, the scene is re-read and the call fails with IMPORT_PRODUCED_EMPTY_SCENE if no model was added: the file is malformed, do not retry.",
  annotations: MUTATING,
  input: z.object({
    file: z.string(),
    scene_id: sceneId,
    name: z.string().optional(),
    scale: z.number().default(1),
    units: z.enum(["MILLIMETERS", "INCHES", "DETECTED"]).default("MILLIMETERS"),
    repair_behavior: z.enum(["REPAIR", "ERROR", "IGNORE"]).default("REPAIR"),
    position: xyz.optional(),
    orientation: orientation.optional(),
    split_multi_model_file: z.boolean().optional(),
  }),
  async handler(app, a, ctx) {
    const local = inputPath(a.file, app.config, MODEL);
    const remote = await app.backend.stageInput(local);
    const payload = body({ file: remote, scale: a.scale, units: a.units, repair_behavior: a.repair_behavior, name: a.name, position: a.position, orientation: a.orientation, split_multi_model_file: a.split_multi_model_file });

    let beforeIds = new Set<string>();
    try {
      const before = (await app.client.get(`/scene/${a.scene_id}/`)) as Json;
      beforeIds = new Set(modelsOf(before).map((m) => String(m["id"])));
    } catch (err) {
      if (!(err instanceof PreFormError)) throw err;
    }

    const result = await app.client.postAsync(`/scene/${a.scene_id}/import-model/`, payload, progressFor(ctx, "importing model"));

    const after = (await app.client.get(`/scene/${a.scene_id}/`)) as Json;
    const added = modelsOf(after).filter((m) => !beforeIds.has(String(m["id"])));
    if (added.length === 0) {
      throw new PreFormError(
        500,
        "IMPORT_PRODUCED_EMPTY_SCENE",
        `PreFormServer accepted ${local} but no model appeared in the scene. The file probably failed to parse. Open it in PreForm to diagnose; do not retry.`,
        { scene_id: a.scene_id, import_result: result },
      );
    }
    if (isRecord(result) && result["id"]) return result;
    return added.length === 1 ? added[0] : { models: added };
  },
});

function modelsOf(scene: unknown): Json[] {
  const list = isRecord(scene) ? scene["models"] : undefined;
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

tool({
  name: "get_model",
  description: "Get one model's properties: transform, bounding box, supports, lock state.",
  annotations: READ_ONLY,
  input: z.object({ model_id: z.string(), scene_id: sceneId }),
  handler: (app, { model_id, scene_id }) => app.client.get(`/scene/${scene_id}/models/${model_id}/`),
});

tool({
  name: "update_model",
  description:
    "Move, rotate, rescale, rename or lock a model. `position` is {x,y,z} mm; `orientation` is Euler degrees {x,y,z}. `lock` (FREE, LOCKED_XY_ROTATION_FREE_TRANSLATION, LOCKED_ROTATION_FREE_TRANSLATION, FULLY_LOCKED) controls what auto_layout / auto_pack may change.",
  annotations: MUTATING,
  input: z.object({ model_id: z.string(), scene_id: sceneId, name: z.string().optional(), position: xyz.optional(), orientation: orientation.optional(), scale: z.number().optional(), lock: z.string().optional() }),
  handler(app, { model_id, scene_id, ...rest }) {
    const payload = body(rest);
    if (Object.keys(payload).length === 0) throw new Error("Nothing to update.");
    return app.client.post(`/scene/${scene_id}/models/${model_id}/`, payload);
  },
});

tool({
  name: "duplicate_model",
  description: "Make `count` copies of a model. Returns the scene. Run auto_layout or auto_pack afterwards.",
  annotations: MUTATING,
  input: z.object({ model_id: z.string(), count: z.number().int().min(1).default(1), scene_id: sceneId }),
  handler: (app, { model_id, count, scene_id }) => app.client.post(`/scene/${scene_id}/models/${model_id}/duplicate/`, { count }),
});

tool({
  name: "replace_model",
  description: "Swap a model's mesh for a new file while keeping its placement and supports. Useful when the user re-exports a revised part. `file` must be an absolute path.",
  annotations: MUTATING,
  input: z.object({ model_id: z.string(), file: z.string(), scene_id: sceneId, repair_behavior: z.enum(["REPAIR", "ERROR", "IGNORE"]).default("REPAIR") }),
  async handler(app, { model_id, file, scene_id, repair_behavior }) {
    const local = inputPath(file, app.config, MODEL);
    return app.client.post(`/scene/${scene_id}/models/${model_id}/replace/`, { file: await app.backend.stageInput(local), repair_behavior });
  },
});

tool({
  name: "delete_model",
  description: "Remove a model from the scene.",
  annotations: DESTRUCTIVE,
  input: z.object({ model_id: z.string(), scene_id: sceneId }),
  async handler(app, { model_id, scene_id }) {
    return (await app.client.delete(`/scene/${scene_id}/models/${model_id}/`)) ?? { status: "deleted", model_id };
  },
});

// ---------------------------------------------------------------------------
// Preparation (long-running)
// ---------------------------------------------------------------------------

tool({
  name: "auto_orient",
  description: 'Rotate models to the orientation PreForm judges best for printing. `mode="DENTAL"` uses the Dental Workspace algorithm; `tilt` (degrees) applies only in DENTAL mode.',
  annotations: MUTATING,
  input: z.object({ scene_id: sceneId, models, mode: z.literal("DENTAL").optional(), tilt: z.number().int().optional() }),
  handler: (app, { scene_id, ...rest }, ctx) => app.client.postAsync(`/scene/${scene_id}/auto-orient/`, body(rest), progressFor(ctx, "orienting")),
});

tool({
  name: "auto_support",
  description: "Generate support structures. Leave parameters unset for PreForm's defaults. `density` and `slope_multiplier` are unitless factors around 1.0; `raft_type` is FULL_RAFT, MINI_RAFT or MINI_RAFTS_ON_BP.",
  annotations: MUTATING,
  input: z.object({
    scene_id: sceneId,
    models,
    density: z.number().optional(),
    slope_multiplier: z.number().optional(),
    only_minima: z.boolean().optional(),
    raft_type: z.enum(["FULL_RAFT", "MINI_RAFT", "MINI_RAFTS_ON_BP"]).optional(),
    raft_label_enabled: z.boolean().optional(),
    breakaway_structure_enabled: z.boolean().optional(),
    touchpoint_size_mm: z.number().optional(),
    internal_supports_enabled: z.boolean().optional(),
    raft_thickness_mm: z.number().optional(),
    height_above_raft_mm: z.number().optional(),
  }),
  handler: (app, { scene_id, ...rest }, ctx) => app.client.postAsync(`/scene/${scene_id}/auto-support/`, body(rest), progressFor(ctx, "generating supports")),
});

tool({
  name: "auto_layout",
  description: 'Arrange models on the build platform. SLA printers only (machine types starting with FORM- or FRM). For SLS printers (Fuse) use auto_pack. `mode="DENTAL"` uses the Dental Workspace layout.',
  annotations: MUTATING,
  input: z.object({ scene_id: sceneId, models, model_spacing_mm: z.number().optional(), placement_margin_mm: z.number().optional(), lock_rotation: z.boolean().optional(), allow_overlapping_supports: z.boolean().optional(), mode: z.literal("DENTAL").optional() }),
  handler: (app, { scene_id, ...rest }, ctx) => app.client.postAsync(`/scene/${scene_id}/auto-layout/`, body(rest), progressFor(ctx, "laying out")),
});

tool({
  name: "fill_build_platform",
  description: "Duplicate the given models as many times as fit and lay the copies out. SLA only; returns `new_model_ids`. For SLS printers use fill_build_chamber.",
  annotations: MUTATING,
  input: z.object({ scene_id: sceneId, models, model_spacing_mm: z.number().optional(), placement_margin_mm: z.number().optional() }),
  handler(app, { scene_id, models: m, model_spacing_mm, placement_margin_mm }, ctx) {
    const layout = body({ model_spacing_mm, placement_margin_mm });
    return app.client.postAsync(`/scene/${scene_id}/fill-build-platform/`, body({ models: m, layout_options: Object.keys(layout).length ? layout : undefined }), progressFor(ctx, "filling platform"));
  },
});

tool({
  name: "auto_pack",
  description: "Pack all models into the 3D build chamber. SLS printers only (machine types starting with FS or PILK). For SLA printers use auto_layout. `packing_mode` is PACK_HEIGHT (minimize build height, faster print) or PACK_VOLUME (tightest packing).",
  annotations: MUTATING,
  input: z.object({ scene_id: sceneId, model_spacing_mm: z.number().optional(), distance_from_wall_mm: z.number().optional(), packing_mode: z.enum(["PACK_HEIGHT", "PACK_VOLUME"]).optional(), seed: z.number().int().optional() }),
  handler: (app, { scene_id, ...rest }, ctx) => app.client.postAsync(`/scene/${scene_id}/auto-pack/`, body(rest), progressFor(ctx, "packing")),
});

tool({
  name: "fill_build_chamber",
  description: "Duplicate the given models until the SLS build chamber is full and pack them. SLS only; returns `new_model_ids`. Set `fill_to_height_mm` to fill only part of the chamber.",
  annotations: MUTATING,
  input: z.object({ scene_id: sceneId, models, fill_to_height_mm: z.number().optional(), model_spacing_mm: z.number().optional(), distance_from_wall_mm: z.number().optional() }),
  handler(app, { scene_id, models: m, fill_to_height_mm, model_spacing_mm, distance_from_wall_mm }, ctx) {
    const packing = body({ model_spacing_mm, distance_from_wall_mm });
    return app.client.postAsync(`/scene/${scene_id}/fill-build-chamber/`, body({ models: m, fill_to_height_mm, packing_options: Object.keys(packing).length ? packing : undefined }), progressFor(ctx, "filling chamber"));
  },
});

tool({
  name: "pack_and_cage",
  description: "Pack models and build a printed cage around them so they stay together after SLS printing. SLS only; acts on the most recently created scene. `packing_type` is PACK_VOLUME (default), PACK_HEIGHT, PACK_NORMAL or PACK_NONE. Returns the scene.",
  annotations: MUTATING,
  input: z.object({ models, cage_label: z.string().optional(), packing_type: z.enum(["PACK_VOLUME", "PACK_HEIGHT", "PACK_NORMAL", "PACK_NONE"]).optional(), model_spacing_mm: z.number().optional() }),
  handler: (app, { models: m, cage_label, packing_type, model_spacing_mm }) =>
    app.client.post("/scene/pack-and-cage/", body({ models: m, cage_label, model_spacing_mm, packing_type: packing_type ? { packing_type } : undefined })),
});

tool({
  name: "hollow_model",
  description: "Hollow models to save resin. Follow up with auto_add_drain_holes so resin can escape.",
  annotations: MUTATING,
  input: z.object({ scene_id: sceneId, models, wall_thickness_mm: z.number().optional(), feature_size_mm: z.number().optional() }),
  handler: (app, { scene_id, ...rest }, ctx) => app.client.postAsync(`/scene/${scene_id}/hollow/`, body(rest), progressFor(ctx, "hollowing")),
});

tool({
  name: "label_model",
  description: "Emboss or engrave text onto a model's surface. `position` is the label centre {x,y,z} in scene mm; `orientation` (Euler degrees) sets the text direction with +x along the text and +z as the surface normal.",
  annotations: MUTATING,
  input: z.object({ model_id: z.string(), label: z.string(), position: xyz, font_size_mm: z.number(), depth_mm: z.number(), scene_id: sceneId, orientation: orientation.optional(), application_mode: z.enum(["EMBOSS", "ENGRAVE"]).default("EMBOSS") }),
  handler: (app, { scene_id, orientation: o, ...rest }, ctx) => app.client.postAsync(`/scene/${scene_id}/label/`, body({ ...rest, orientation: o ?? { x: 0, y: 0, z: 0 } }), progressFor(ctx, "labelling")),
});

// ---------------------------------------------------------------------------
// Drain holes
// ---------------------------------------------------------------------------

tool({
  name: "add_drain_holes",
  description:
    'Add hand-placed drain holes to one model. Each entry needs `position` {x,y,z}, `orientation`, `diameter_mm`, `depth_mm` (number or "AUTO") and `create_plug`; `max_search_distance` (mm) lets PreForm snap the hole onto the nearest surface. Prefer auto_add_drain_holes unless the user gives coordinates.',
  annotations: MUTATING,
  input: z.object({ model_id: z.string(), drain_holes: z.array(z.record(z.string(), z.unknown())), scene_id: sceneId }),
  handler: (app, { model_id, drain_holes, scene_id }) => app.client.post(`/scene/${scene_id}/add-drain-holes/`, { model_id, drain_holes }),
});

function sampleBottomPositions(min: Json, max: Json, n: number, marginBelow = 1): { x: number; y: number; z: number }[] {
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const [x0, x1, y0, y1] = [num(min["x"]), num(max["x"]), num(min["y"]), num(max["y"])];
  const zed = num(min["z"]) - marginBelow;
  if (n <= 1) return [{ x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: zed }];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const out: { x: number; y: number; z: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols && out.length < n; c++) {
      out.push({ x: x0 + ((c + 0.5) * (x1 - x0)) / cols, y: y0 + ((r + 0.5) * (y1 - y0)) / rows, z: zed });
    }
  }
  return out;
}

tool({
  name: "auto_add_drain_holes",
  description:
    'Place drain holes automatically on every model that cup detection flags. Runs detect_cups, then for each cupped model samples points under its bounding box and lets PreForm project them onto the surface (depth AUTO). Models without cups are skipped. A "no surface found" warning means the cups are on a side face: offer add_drain_holes instead.',
  annotations: MUTATING,
  input: z.object({ scene_id: sceneId, models, diameter_mm: z.number().default(1.5), max_holes_per_model: z.number().int().min(1).default(4) }),
  async handler(app, { scene_id, models: m, diameter_mm, max_holes_per_model }, ctx) {
    const scene = (await app.client.get(`/scene/${scene_id}/`)) as Json;
    const detection = (await app.client.getAsync(`/scene/${scene_id}/cup-detection/`, progressFor(ctx, "detecting cups"))) as Json;
    const perModelRaw = isRecord(detection["per_model_results"]) ? detection["per_model_results"] : {};
    const perModel = new Map(Object.entries(perModelRaw).map(([k, v]) => [bareId(k), v]));
    const sceneModels = new Map(modelsOf(scene).map((x) => [bareId(String(x["id"])), x]));
    const targets = m === "ALL" ? [...sceneModels.keys()] : m.map(bareId);

    const results: Json[] = [];
    for (const id of targets) {
      const r = perModel.get(id);
      const cups = isRecord(r) ? Number(r["cup_count"] ?? 0) : 0;
      if (cups <= 0) {
        results.push({ model_id: id, status: "skipped", reason: "no cups" });
        continue;
      }
      const bbox = sceneModels.get(id)?.["bounding_box"];
      const min = isRecord(bbox) && isRecord(bbox["min_corner"]) ? bbox["min_corner"] : undefined;
      const max = isRecord(bbox) && isRecord(bbox["max_corner"]) ? bbox["max_corner"] : undefined;
      if (!min || !max) {
        results.push({ model_id: id, status: "skipped", reason: "no bounding box" });
        continue;
      }
      const height = Number(max["z"] ?? 0) - Number(min["z"] ?? 0);
      const holes = sampleBottomPositions(min, max, Math.min(cups, max_holes_per_model)).map((p) => ({
        position: p,
        orientation: { z_direction: [0, 0, 1], x_direction: [1, 0, 0] },
        diameter_mm,
        depth_mm: "AUTO",
        max_search_distance: Math.max(height + 2, 2),
        create_plug: false,
      }));
      try {
        const resp = (await app.client.post(`/scene/${scene_id}/add-drain-holes/`, { model_id: id, drain_holes: holes })) as Json | null;
        results.push({ model_id: id, status: "added", cups_detected: cups, holes_requested: holes.length, warnings: resp?.["warnings"] ?? [], infos: resp?.["infos"] ?? [] });
      } catch (err) {
        if (!(err instanceof PreFormError)) throw err;
        results.push({ model_id: id, status: "error", cups_detected: cups, error_code: err.code, error_message: err.detail });
      }
    }
    return { results };
  },
});

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const analysis = (name: string, endpoint: string, label: string, description: string) =>
  tool({
    name,
    description,
    annotations: READ_ONLY,
    input: z.object({ scene_id: sceneId }),
    handler: (app, { scene_id }, ctx) => app.client.getAsync(`/scene/${scene_id}/${endpoint}/`, progressFor(ctx, label)),
  });

analysis("get_print_validation", "print-validation", "validating", "Full printability check per model: cups, unsupported_minima, undersupported, has_seamline.");
analysis("detect_cups", "cup-detection", "detecting cups", "Count resin cups (trapped-resin pockets) per model. Faster than full validation.");
analysis("detect_minima", "minima-detection", "detecting minima", "Count unsupported local minima per model (points that would print in mid-air).");
analysis("detect_supportedness", "supportedness-detection", "checking supports", "Percentage of each model's surface that is unsupported (PreForm's red shading).");

tool({
  name: "detect_thin_walls",
  description: "Find wall regions thinner than `threshold_mm` per model, with volumes and bounding boxes.",
  annotations: READ_ONLY,
  input: z.object({ threshold_mm: z.number().positive(), scene_id: sceneId, models }),
  handler: (app, { threshold_mm, scene_id, models: m }, ctx) => app.client.postAsync(`/scene/${scene_id}/thin-wall-detection/`, { models: m, threshold_mm }, progressFor(ctx, "detecting thin walls")),
});

tool({
  name: "get_interferences",
  description: "List pairs of model ids that overlap or sit closer than `collision_offset_mm`.",
  annotations: READ_ONLY,
  input: z.object({ scene_id: sceneId, collision_offset_mm: z.number().optional() }),
  handler: (app, { scene_id, collision_offset_mm }) => app.client.post(`/scene/${scene_id}/interferences/`, body({ collision_offset_mm })),
});

tool({
  name: "estimate_print_time",
  description: "Estimate print time in seconds for the scene. Read material usage from get_scene.",
  annotations: READ_ONLY,
  input: z.object({ scene_id: sceneId }),
  handler: (app, { scene_id }, ctx) => app.client.postAsync(`/scene/${scene_id}/estimate-print-time/`, {}, progressFor(ctx, "estimating")),
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

tool({
  name: "save_form",
  description: "Save the scene as a .form file at an absolute path. Overwrites silently, so confirm with the user first if the file already exists.",
  annotations: DESTRUCTIVE,
  input: z.object({ file: z.string(), scene_id: sceneId }),
  async handler(app, { file, scene_id }, ctx) {
    const local = outputPath(file, app.config, FORM);
    const target = await app.backend.outputPath(local);
    await app.client.postAsync(`/scene/${scene_id}/save-form/`, { file: target }, progressFor(ctx, "saving"));
    await app.backend.collectOutput(local);
    return { status: "saved", file: local };
  },
});

tool({
  name: "save_screenshot",
  description: "Render the scene to a .png or .webp at an absolute path. `view_type` is ZOOM_ON_MODELS, FULL_BUILD_VOLUME or FULL_PLATFORM_WIDTH.",
  annotations: DESTRUCTIVE,
  input: z.object({ file: z.string(), scene_id: sceneId, image_size_px: z.number().int().default(1024), view_type: z.enum(["ZOOM_ON_MODELS", "FULL_BUILD_VOLUME", "FULL_PLATFORM_WIDTH"]).default("ZOOM_ON_MODELS"), yaw: z.number().optional(), pitch: z.number().optional() }),
  async handler(app, { file, scene_id, ...rest }, ctx) {
    const local = outputPath(file, app.config, IMAGE);
    const target = await app.backend.outputPath(local);
    await app.client.postAsync(`/scene/${scene_id}/save-screenshot/`, body({ file: target, ...rest }), progressFor(ctx, "rendering"));
    await app.backend.collectOutput(local);
    return { status: "saved", file: local };
  },
});

tool({
  name: "save_fps_file",
  description: "Export the scene's print settings to a .fps file for reuse with create_scene.",
  annotations: DESTRUCTIVE,
  input: z.object({ file: z.string(), scene_id: sceneId }),
  async handler(app, { file, scene_id }) {
    const local = outputPath(file, app.config, FPS);
    const target = await app.backend.outputPath(local);
    await app.client.post(`/scene/${scene_id}/save-fps-file/`, { file: target });
    await app.backend.collectOutput(local);
    return { status: "saved", file: local };
  },
});

// ---------------------------------------------------------------------------
// Printers
// ---------------------------------------------------------------------------

tool({
  name: "list_devices",
  description: 'List printers PreFormServer knows: discovered LAN printers (run discover_devices to refresh), Fleet Control queues and Dashboard printers after login, and its built-in virtual printers (connection_type VIRTUAL, one per model such as "Form 4"), which accept print_to_printer as a hardware-free dry run of the whole upload path.',
  annotations: READ_ONLY,
  input: z.object({ can_print: z.boolean().optional() }),
  handler: (app, { can_print }) => app.client.get("/devices/", can_print === undefined ? undefined : { can_print: String(can_print) }),
});

tool({
  name: "get_device",
  description: "Status of one printer: connection, tank and cartridge material, time remaining.",
  annotations: READ_ONLY,
  input: z.object({ device_id: z.string() }),
  handler: (app, { device_id }) => app.client.get(`/devices/${device_id}/`),
});

tool({
  name: "discover_devices",
  description: "Scan the local network for Formlabs printers. Pass `ip_address` to probe one host.",
  annotations: READ_ONLY,
  input: z.object({ timeout_seconds: z.number().int().default(10), ip_address: z.string().optional() }),
  handler: (app, args, ctx) => app.client.postAsync("/discover-devices/", body(args), progressFor(ctx, "discovering printers")),
});

tool({
  name: "print_to_printer",
  description:
    'Upload the scene to a printer and queue it, or start it. Confirm with the user first. `printer` is a printer serial name (e.g. "Fuse-Loud-Otter"), a local IP address, a Fleet Control queue id (requires login), or a built-in virtual printer id such as "Form 4" for a dry run without hardware. `print_now=true` starts immediately if the printer is ready; otherwise the job waits in the queue. Returns `job_id`.',
  annotations: DESTRUCTIVE,
  input: z.object({ printer: z.string(), job_name: z.string(), scene_id: sceneId, print_now: z.boolean().optional(), find_printer_timeout_seconds: z.number().int().default(30) }),
  handler: (app, { scene_id, ...rest }, ctx) => app.client.postAsync(`/scene/${scene_id}/print/`, body(rest), progressFor(ctx, "uploading job")),
});

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

tool({
  name: "list_materials",
  description: "List printers with their materials and print settings. Each material setting's `scene_settings` holds the exact machine_type, material_code, print_setting and layer_thickness_mm for create_scene. Pass `machine_type` to keep only one printer family; the full list is large.",
  annotations: READ_ONLY,
  input: z.object({ machine_type: z.string().optional() }),
  async handler(app, { machine_type }) {
    const data = (await app.client.get("/list-materials/")) as Json;
    const all = withUnlistedPrinterTypes(data);
    if (!machine_type) return { ...data, printer_types: all };
    const wanted = machine_type.toUpperCase();
    const printers = all.filter((p) => {
      const ids = Array.isArray(p["supported_machine_type_ids"]) ? p["supported_machine_type_ids"] : [];
      return ids.map((x) => String(x).toUpperCase()).includes(wanted);
    });
    return { printer_types: printers };
  },
});

tool({
  name: "list_printer_types",
  description: 'Short list of printer families with machine_type codes and build volumes. Use it to map a printer name ("Form 4", "Fuse 1+", "Fuse X1") to a machine_type before create_scene. FORM-/FRM codes are SLA (auto_layout); FS/PILK/FUSX codes are SLS (auto_pack). Families PreFormServer accepts but does not list yet (the Fuse X1 in 3.63.0) carry an `unlisted` note.',
  annotations: READ_ONLY,
  input: z.object({}),
  async handler(app) {
    const data = (await app.client.get("/list-materials/")) as Json;
    return withUnlistedPrinterTypes(data).map((p) => ({
      label: p["label"],
      machine_types: p["supported_machine_type_ids"] ?? [],
      product_names: p["supported_product_names"] ?? [],
      build_volume_dimensions_mm: p["build_volume_dimensions_mm"],
      material_count: Array.isArray(p["materials"]) ? p["materials"].length : 0,
      ...(p["unlisted"] ? { unlisted: p["unlisted"] } : {}),
    }));
  },
});

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

tool({
  name: "login",
  description:
    "Log in to Formlabs Web Services for remote printing, Fleet Control and Dashboard printers. Credentials never pass through the conversation: set FORMLABS_USERNAME and FORMLABS_PASSWORD (or FORMLABS_ACCESS_TOKEN) in the MCP server's environment and call this tool with no arguments.",
  annotations: MUTATING,
  input: z.object({}),
  async handler(app) {
    const cfg = app.config;
    if (!isLoopback(cfg.baseUrl) && !cfg.allowRemoteLogin) {
      throw new Error(`Refusing to send credentials to a non-local PreFormServer (${cfg.baseUrl}) over plain HTTP. Set FORMLABS_ALLOW_REMOTE_LOGIN=1 only on a trusted network.`);
    }
    const creds = cfg.credentials;
    if (!creds) {
      throw new Error("No Formlabs credentials configured. Set FORMLABS_USERNAME and FORMLABS_PASSWORD (or FORMLABS_ACCESS_TOKEN) in the MCP server environment, then retry. Do not ask the user to paste a password into the chat.");
    }
    const payload = "accessToken" in creds ? { access_token: creds.accessToken } : { username: creds.username, password: creds.password };
    await app.client.post("/login/", payload); // returned tokens are deliberately dropped
    const user = (await app.client.get("/user/")) as Json;
    return { status: "logged_in", username: user["username"], email: user["email"] };
  },
});

tool({
  name: "logout",
  description: "Log out of Formlabs Web Services.",
  annotations: MUTATING,
  input: z.object({}),
  async handler(app) {
    return (await app.client.post("/logout/", {})) ?? { status: "logged_out" };
  },
});
