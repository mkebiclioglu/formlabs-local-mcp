/**
 * The hosted tool surface. Names, arguments and annotations match
 * formlabs-local-mcp so an agent can drive a simulated farm and a real
 * PreForm setup with the same calls. A few cloud-only tools are appended
 * (print job tracking, approvals, long-running operations).
 */
import * as z from "zod";

export interface Annotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint?: boolean;
}

export type Category = "setup" | "scenes" | "models" | "prep" | "analysis" | "export" | "printers" | "materials" | "account" | "cloud";

export interface CloudToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  annotations: Annotations;
  input: S;
  category: Category;
  /** Default policy when the environment has no explicit row. */
  defaultPolicy: "allow" | "approve" | "deny";
  /** Human-readable summary of a call, shown in approvals and activity. */
  summarize?(args: Record<string, unknown>): string;
}

const READ_ONLY: Annotations = { readOnlyHint: true, destructiveHint: false };
const MUTATING: Annotations = { readOnlyHint: false, destructiveHint: false };
const DESTRUCTIVE: Annotations = { readOnlyHint: false, destructiveHint: true };

export const TOOLS: CloudToolDef[] = [];
function tool<S extends z.ZodObject>(def: CloudToolDef<S>): void {
  TOOLS.push(def as unknown as CloudToolDef);
}

export function toolByName(name: string): CloudToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

const sceneId = z.string().default("default").describe("Scene id; omit for the default scene");
const models = z.union([z.literal("ALL"), z.array(z.string())]).default("ALL").describe('"ALL" or a list of model ids');
const xyz = z.object({ x: z.number(), y: z.number(), z: z.number() });
const orientation = z.record(z.string(), z.unknown()).describe("Euler degrees {x,y,z}, or {z_direction:[..], x_direction:[..]} unit vectors");
const layer = z.union([z.number(), z.literal("ADAPTIVE")]);

const FILE_HINT = "In a connected environment this is an absolute path on the machine running the connector. In a simulated environment pass a sample part (sample:bracket, sample:gear, sample:enclosure, sample:manifold, sample:dental-arch, sample:ring, sample:phone-stand, sample:vase, sample:miniature, sample:knob, sample:impeller, sample:test-cube), an https URL to an STL file (it is downloaded and measured), or any file name (a plausible part is derived from it).";

// Setup ---------------------------------------------------------------------
tool({ name: "health_check", category: "setup", defaultPolicy: "allow", description: "Return the PreFormServer version (or the simulator version). Call this first to confirm the environment is reachable.", annotations: READ_ONLY, input: z.object({}) });
tool({ name: "preform_status", category: "setup", defaultPolicy: "allow", description: "Report how this environment is set up: simulated or connected, connector status, PreFormServer install state and version, allowed directories.", annotations: READ_ONLY, input: z.object({}) });
tool({ name: "install_preform_server", category: "setup", defaultPolicy: "approve", description: "Connected environments only: download the latest PreFormServer from Formlabs on the connector machine, verify its code signature and install it. Ask the user first; it requires approval in the dashboard.", annotations: DESTRUCTIVE, input: z.object({ force: z.boolean().default(false) }), summarize: () => "Install PreFormServer on the connector machine" });
tool({ name: "get_user", category: "account", defaultPolicy: "allow", description: "Return the Formlabs account currently logged in (after `login`).", annotations: READ_ONLY, input: z.object({}) });

// Scenes --------------------------------------------------------------------
tool({
  name: "create_scene", category: "scenes", defaultPolicy: "allow",
  description: "Create a new scene for a printer and material. Returns the scene including its `id`. Provide machine_type + material_code + layer_thickness_mm (or, in a connected environment, the absolute path of a .fps print-settings file). Get valid codes from list_printer_types and list_materials; never guess them.",
  annotations: MUTATING,
  input: z.object({ machine_type: z.string().optional().describe("e.g. FORM-4-0, FS30-1-0"), material_code: z.string().optional().describe("e.g. FLGPBK05"), layer_thickness_mm: layer.optional().describe('e.g. 0.1, 0.05, 0.025 or "ADAPTIVE"'), print_setting: z.string().default("DEFAULT"), fps_file: z.string().optional() }),
});
tool({ name: "list_scenes", category: "scenes", defaultPolicy: "allow", description: "List every scene currently held in memory.", annotations: READ_ONLY, input: z.object({}) });
tool({ name: "get_scene", category: "scenes", defaultPolicy: "allow", description: "Get a scene: its models (ids, bounding boxes, supports), print settings, material usage and build volume.", annotations: READ_ONLY, input: z.object({ scene_id: sceneId }) });
tool({ name: "update_scene", category: "scenes", defaultPolicy: "allow", description: "Change a scene's printer, material, layer thickness or print setting while keeping its models.", annotations: MUTATING, input: z.object({ scene_id: sceneId, machine_type: z.string().optional(), material_code: z.string().optional(), layer_thickness_mm: layer.optional(), print_setting: z.string().optional() }) });
tool({ name: "delete_scene", category: "scenes", defaultPolicy: "allow", description: 'Delete a scene and its models. Deleting "default" resets it to empty.', annotations: DESTRUCTIVE, input: z.object({ scene_id: z.string() }), summarize: (a) => `Delete scene ${a["scene_id"]}` });
tool({ name: "load_form", category: "scenes", defaultPolicy: "allow", description: "Open an existing .form file as a new scene (connected environments; in a simulated environment a saved virtual .form is restored). Returns the scene.", annotations: MUTATING, input: z.object({ file: z.string() }) });

// Models --------------------------------------------------------------------
tool({
  name: "import_model", category: "models", defaultPolicy: "allow",
  description: `Import a model file (STL, OBJ, 3MF, STEP) into a scene. Returns the model with its \`id\`. ${FILE_HINT} Defaults: repair_behavior=REPAIR, units=MILLIMETERS.`,
  annotations: MUTATING,
  input: z.object({ file: z.string(), scene_id: sceneId, name: z.string().optional(), scale: z.number().default(1), units: z.enum(["MILLIMETERS", "INCHES", "DETECTED"]).default("MILLIMETERS"), repair_behavior: z.enum(["REPAIR", "ERROR", "IGNORE"]).default("REPAIR"), position: xyz.optional(), orientation: orientation.optional(), split_multi_model_file: z.boolean().optional() }),
  summarize: (a) => `Import ${a["file"]}`,
});
tool({ name: "get_model", category: "models", defaultPolicy: "allow", description: "Get one model's properties: transform, bounding box, supports, lock state.", annotations: READ_ONLY, input: z.object({ model_id: z.string(), scene_id: sceneId }) });
tool({ name: "update_model", category: "models", defaultPolicy: "allow", description: "Move, rotate, rescale, rename or lock a model. `position` is {x,y,z} mm; `orientation` is Euler degrees {x,y,z}. `lock` (FREE, LOCKED_XY_ROTATION_FREE_TRANSLATION, LOCKED_ROTATION_FREE_TRANSLATION, FULLY_LOCKED) controls what auto_layout / auto_pack may change.", annotations: MUTATING, input: z.object({ model_id: z.string(), scene_id: sceneId, name: z.string().optional(), position: xyz.optional(), orientation: orientation.optional(), scale: z.number().optional(), lock: z.string().optional() }) });
tool({ name: "duplicate_model", category: "models", defaultPolicy: "allow", description: "Make `count` copies of a model. Returns the scene. Run auto_layout or auto_pack afterwards.", annotations: MUTATING, input: z.object({ model_id: z.string(), count: z.number().int().min(1).default(1), scene_id: sceneId }) });
tool({ name: "replace_model", category: "models", defaultPolicy: "allow", description: "Swap a model's mesh for a new file while keeping its placement and supports.", annotations: MUTATING, input: z.object({ model_id: z.string(), file: z.string(), scene_id: sceneId, repair_behavior: z.enum(["REPAIR", "ERROR", "IGNORE"]).default("REPAIR") }) });
tool({ name: "delete_model", category: "models", defaultPolicy: "allow", description: "Remove a model from the scene.", annotations: DESTRUCTIVE, input: z.object({ model_id: z.string(), scene_id: sceneId }), summarize: (a) => `Delete model ${a["model_id"]}` });

// Prep ----------------------------------------------------------------------
tool({ name: "auto_orient", category: "prep", defaultPolicy: "allow", description: 'Rotate models to the orientation PreForm judges best for printing. `mode="DENTAL"` uses the Dental Workspace algorithm; `tilt` (degrees) applies only in DENTAL mode.', annotations: MUTATING, input: z.object({ scene_id: sceneId, models, mode: z.literal("DENTAL").optional(), tilt: z.number().int().optional() }) });
tool({
  name: "auto_support", category: "prep", defaultPolicy: "allow",
  description: "Generate support structures. Leave parameters unset for PreForm's defaults. `density` and `slope_multiplier` are unitless factors around 1.0; `raft_type` is FULL_RAFT, MINI_RAFT or MINI_RAFTS_ON_BP.",
  annotations: MUTATING,
  input: z.object({ scene_id: sceneId, models, density: z.number().optional(), slope_multiplier: z.number().optional(), only_minima: z.boolean().optional(), raft_type: z.enum(["FULL_RAFT", "MINI_RAFT", "MINI_RAFTS_ON_BP"]).optional(), raft_label_enabled: z.boolean().optional(), breakaway_structure_enabled: z.boolean().optional(), touchpoint_size_mm: z.number().optional(), internal_supports_enabled: z.boolean().optional(), raft_thickness_mm: z.number().optional(), height_above_raft_mm: z.number().optional() }),
});
tool({ name: "auto_layout", category: "prep", defaultPolicy: "allow", description: 'Arrange models on the build platform. SLA printers only (machine types starting with FORM- or FRM). For SLS printers (Fuse) use auto_pack. `mode="DENTAL"` uses the Dental Workspace layout.', annotations: MUTATING, input: z.object({ scene_id: sceneId, models, model_spacing_mm: z.number().optional(), placement_margin_mm: z.number().optional(), lock_rotation: z.boolean().optional(), allow_overlapping_supports: z.boolean().optional(), mode: z.literal("DENTAL").optional() }) });
tool({ name: "fill_build_platform", category: "prep", defaultPolicy: "allow", description: "Duplicate the given models as many times as fit and lay the copies out. SLA only; returns `new_model_ids`. For SLS printers use fill_build_chamber.", annotations: MUTATING, input: z.object({ scene_id: sceneId, models, model_spacing_mm: z.number().optional(), placement_margin_mm: z.number().optional() }) });
tool({ name: "auto_pack", category: "prep", defaultPolicy: "allow", description: "Pack all models into the 3D build chamber. SLS printers only (machine types starting with FS or PILK). For SLA printers use auto_layout. `packing_mode` is PACK_HEIGHT (minimize build height, faster print) or PACK_VOLUME (tightest packing).", annotations: MUTATING, input: z.object({ scene_id: sceneId, model_spacing_mm: z.number().optional(), distance_from_wall_mm: z.number().optional(), packing_mode: z.enum(["PACK_HEIGHT", "PACK_VOLUME"]).optional(), seed: z.number().int().optional() }) });
tool({ name: "fill_build_chamber", category: "prep", defaultPolicy: "allow", description: "Duplicate the given models until the SLS build chamber is full and pack them. SLS only; returns `new_model_ids`. Set `fill_to_height_mm` to fill only part of the chamber.", annotations: MUTATING, input: z.object({ scene_id: sceneId, models, fill_to_height_mm: z.number().optional(), model_spacing_mm: z.number().optional(), distance_from_wall_mm: z.number().optional() }) });
tool({ name: "pack_and_cage", category: "prep", defaultPolicy: "allow", description: "Pack models and build a printed cage around them so they stay together after SLS printing. SLS only; acts on the most recently created scene. `packing_type` is PACK_VOLUME (default), PACK_HEIGHT, PACK_NORMAL or PACK_NONE. Returns the scene.", annotations: MUTATING, input: z.object({ models, cage_label: z.string().optional(), packing_type: z.enum(["PACK_VOLUME", "PACK_HEIGHT", "PACK_NORMAL", "PACK_NONE"]).optional(), model_spacing_mm: z.number().optional() }) });
tool({ name: "hollow_model", category: "prep", defaultPolicy: "allow", description: "Hollow models to save resin. Follow up with auto_add_drain_holes so resin can escape.", annotations: MUTATING, input: z.object({ scene_id: sceneId, models, wall_thickness_mm: z.number().optional(), feature_size_mm: z.number().optional() }) });
tool({ name: "label_model", category: "prep", defaultPolicy: "allow", description: "Emboss or engrave text onto a model's surface. `position` is the label centre {x,y,z} in scene mm; `orientation` (Euler degrees) sets the text direction.", annotations: MUTATING, input: z.object({ model_id: z.string(), label: z.string(), position: xyz, font_size_mm: z.number(), depth_mm: z.number(), scene_id: sceneId, orientation: orientation.optional(), application_mode: z.enum(["EMBOSS", "ENGRAVE"]).default("EMBOSS") }) });
tool({ name: "add_drain_holes", category: "prep", defaultPolicy: "allow", description: 'Add hand-placed drain holes to one model. Each entry needs `position` {x,y,z}, `orientation`, `diameter_mm`, `depth_mm` (number or "AUTO") and `create_plug`. Prefer auto_add_drain_holes unless the user gives coordinates.', annotations: MUTATING, input: z.object({ model_id: z.string(), drain_holes: z.array(z.record(z.string(), z.unknown())), scene_id: sceneId }) });
tool({ name: "auto_add_drain_holes", category: "prep", defaultPolicy: "allow", description: "Place drain holes automatically on every model that cup detection flags. Models without cups are skipped.", annotations: MUTATING, input: z.object({ scene_id: sceneId, models, diameter_mm: z.number().default(1.5), max_holes_per_model: z.number().int().min(1).default(4) }) });

// Analysis ------------------------------------------------------------------
tool({ name: "get_print_validation", category: "analysis", defaultPolicy: "allow", description: "Full printability check per model: cups, unsupported_minima, undersupported, has_seamline.", annotations: READ_ONLY, input: z.object({ scene_id: sceneId }) });
tool({ name: "detect_cups", category: "analysis", defaultPolicy: "allow", description: "Count resin cups (trapped-resin pockets) per model. Faster than full validation.", annotations: READ_ONLY, input: z.object({ scene_id: sceneId }) });
tool({ name: "detect_minima", category: "analysis", defaultPolicy: "allow", description: "Count unsupported local minima per model (points that would print in mid-air).", annotations: READ_ONLY, input: z.object({ scene_id: sceneId }) });
tool({ name: "detect_supportedness", category: "analysis", defaultPolicy: "allow", description: "Percentage of each model's surface that is unsupported (PreForm's red shading).", annotations: READ_ONLY, input: z.object({ scene_id: sceneId }) });
tool({ name: "detect_thin_walls", category: "analysis", defaultPolicy: "allow", description: "Find wall regions thinner than `threshold_mm` per model, with volumes and bounding boxes.", annotations: READ_ONLY, input: z.object({ threshold_mm: z.number().positive(), scene_id: sceneId, models }) });
tool({ name: "get_interferences", category: "analysis", defaultPolicy: "allow", description: "List pairs of model ids that overlap or sit closer than `collision_offset_mm`.", annotations: READ_ONLY, input: z.object({ scene_id: sceneId, collision_offset_mm: z.number().optional() }) });
tool({ name: "estimate_print_time", category: "analysis", defaultPolicy: "allow", description: "Estimate print time in seconds for the scene. Read material usage from get_scene.", annotations: READ_ONLY, input: z.object({ scene_id: sceneId }) });

// Export --------------------------------------------------------------------
tool({ name: "save_form", category: "export", defaultPolicy: "allow", description: "Save the scene as a .form file. Connected: absolute path on the connector machine, overwrites silently. Simulated: stored as a virtual file listed in the dashboard.", annotations: DESTRUCTIVE, input: z.object({ file: z.string(), scene_id: sceneId }), summarize: (a) => `Save .form to ${a["file"]}` });
tool({ name: "save_screenshot", category: "export", defaultPolicy: "allow", description: "Render the scene to a .png or .webp. `view_type` is ZOOM_ON_MODELS, FULL_BUILD_VOLUME or FULL_PLATFORM_WIDTH.", annotations: DESTRUCTIVE, input: z.object({ file: z.string(), scene_id: sceneId, image_size_px: z.number().int().default(1024), view_type: z.enum(["ZOOM_ON_MODELS", "FULL_BUILD_VOLUME", "FULL_PLATFORM_WIDTH"]).default("ZOOM_ON_MODELS"), yaw: z.number().optional(), pitch: z.number().optional() }), summarize: (a) => `Save screenshot to ${a["file"]}` });
tool({ name: "save_fps_file", category: "export", defaultPolicy: "allow", description: "Export the scene's print settings to a .fps file for reuse with create_scene.", annotations: DESTRUCTIVE, input: z.object({ file: z.string(), scene_id: sceneId }), summarize: (a) => `Save .fps to ${a["file"]}` });

// Printers ------------------------------------------------------------------
tool({ name: "list_devices", category: "printers", defaultPolicy: "allow", description: "List printers in this environment with status, current job, tank, cartridge or powder levels. Pass can_print=true to keep only idle printers.", annotations: READ_ONLY, input: z.object({ can_print: z.boolean().optional() }) });
tool({ name: "get_device", category: "printers", defaultPolicy: "allow", description: "Status of one printer: connection, current job and progress, tank and cartridge material, time remaining, errors.", annotations: READ_ONLY, input: z.object({ device_id: z.string().describe("Printer serial name, alias or IP") }) });
tool({ name: "discover_devices", category: "printers", defaultPolicy: "allow", description: "Scan the local network for Formlabs printers. Pass `ip_address` to probe one host.", annotations: READ_ONLY, input: z.object({ timeout_seconds: z.number().int().default(10), ip_address: z.string().optional() }) });
tool({
  name: "print_to_printer", category: "printers", defaultPolicy: "approve",
  description: 'Upload the scene to a printer and queue it, or start it. This is a gated action: depending on the environment policy it may wait for a human approval in the dashboard (the response then carries `approval_id`; poll get_approval). `printer` is a printer serial name (e.g. "Form4-BrightOtter"), alias or IP. `print_now=true` starts immediately if the printer is idle; otherwise the job waits in the queue. Returns `job_id`.',
  annotations: DESTRUCTIVE,
  input: z.object({ printer: z.string(), job_name: z.string(), scene_id: sceneId, print_now: z.boolean().optional(), find_printer_timeout_seconds: z.number().int().default(30) }),
  summarize: (a) => `Print "${a["job_name"]}" on ${a["printer"]}${a["print_now"] ? " now" : ""}`,
});

// Materials -----------------------------------------------------------------
tool({ name: "list_materials", category: "materials", defaultPolicy: "allow", description: "List printers with their materials and print settings. Each material setting's `scene_settings` holds the exact machine_type, material_code, print_setting and layer_thickness_mm for create_scene. Pass `machine_type` to keep only one printer family.", annotations: READ_ONLY, input: z.object({ machine_type: z.string().optional() }) });
tool({ name: "list_printer_types", category: "materials", defaultPolicy: "allow", description: 'Short list of printer families with machine_type codes and build volumes. Use it to map a printer name ("Form 4", "Fuse 1+") to a machine_type before create_scene. FORM-/FRM codes are SLA (auto_layout); FS/PILK codes are SLS (auto_pack).', annotations: READ_ONLY, input: z.object({}) });

// Account -------------------------------------------------------------------
tool({ name: "login", category: "account", defaultPolicy: "approve", description: "Log in to Formlabs Web Services on the connector machine for remote printing and Fleet Control. Credentials never pass through the conversation; they come from the connector's environment.", annotations: MUTATING, input: z.object({}), summarize: () => "Log in to Formlabs Web Services" });
tool({ name: "logout", category: "account", defaultPolicy: "allow", description: "Log out of Formlabs Web Services.", annotations: MUTATING, input: z.object({}) });

// Cloud-only ----------------------------------------------------------------
tool({ name: "get_environment", category: "cloud", defaultPolicy: "allow", description: "Describe the environment this token is bound to: name, simulated or connected, connector status, simulation speed, and which tools require approval.", annotations: READ_ONLY, input: z.object({}) });
tool({ name: "list_print_jobs", category: "cloud", defaultPolicy: "allow", description: "List recent print jobs in this environment (queued, printing, finished, failed) with progress and timing. Newest first.", annotations: READ_ONLY, input: z.object({ status: z.enum(["queued", "printing", "paused", "finished", "failed", "aborted", "submitted"]).optional(), limit: z.number().int().min(1).max(200).default(25) }) });
tool({ name: "get_print_job", category: "cloud", defaultPolicy: "allow", description: "Progress and status of one print job by `job_id` (from print_to_printer or list_print_jobs).", annotations: READ_ONLY, input: z.object({ job_id: z.string() }) });
tool({ name: "get_approval", category: "cloud", defaultPolicy: "allow", description: "Check a gated action. While `status` is pending the human has not decided yet; once approved the action runs and `result` holds its output. Poll every 10-30 seconds, and tell the user the dashboard link if it stays pending.", annotations: READ_ONLY, input: z.object({ approval_id: z.string() }) });
tool({ name: "get_operation", category: "cloud", defaultPolicy: "allow", description: "Status of a long-running connector operation returned as `operation_id` when a call outlived the request window.", annotations: READ_ONLY, input: z.object({ operation_id: z.string() }) });

export const SENSITIVE_TOOLS = TOOLS.filter((t) => t.defaultPolicy !== "allow").map((t) => t.name);

export function summarizeCall(name: string, args: Record<string, unknown>): string {
  const t = toolByName(name);
  if (t?.summarize) return t.summarize(args);
  const keys = Object.keys(args).filter((k) => args[k] !== undefined);
  return keys.length ? `${name} (${keys.map((k) => `${k}=${JSON.stringify(args[k]).slice(0, 40)}`).join(", ")})` : name;
}
