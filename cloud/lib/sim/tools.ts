/**
 * Tool implementations for a simulated environment. Each mirrors what the
 * corresponding PreFormServer endpoint returns closely enough that an agent
 * cannot tell the difference in the happy path, and errors use PreForm-style
 * codes (INPUT_ERROR, MODEL_NOT_FOUND, ...).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { listMaterialsPayload, PRINTER_TYPES, material as materialOf, validSceneSettings } from "./catalog";
import * as E from "./engine";
import { resolvePart } from "./parts";
import * as S from "./store";
import type { EnvRow } from "./store";

export const SIMULATOR_VERSION = "formbridge-sim 1.0.0 (PreForm Local API 0.9.29 compatible)";

type Args = Record<string, unknown>;

export async function runSimTool(db: SupabaseClient, env: EnvRow, name: string, a: Args): Promise<unknown> {
  const sceneKey = () => String(a["scene_id"] ?? "default");
  const withScene = async (fn: (scene: E.SimScene) => unknown | Promise<unknown>, save = true) => {
    const scene = await S.loadScene(db, env.id, sceneKey());
    const out = await fn(scene);
    if (save) await S.saveScene(db, env.id, scene);
    return out;
  };

  switch (name) {
    // Setup ------------------------------------------------------------------
    case "health_check":
      return { version: SIMULATOR_VERSION, api_version: "0.9.29", environment: env.name, simulated: true, simulation_speed: Number(env.sim_speed) };
    case "preform_status":
      return { mode: "simulated", installed: true, executable: null, version: SIMULATOR_VERSION, base_url: null, spawn: false, allowed_paths: ["sample:*", "https://* (STL)", "any file name (derived geometry)"], credentials_configured: false, platform: "cloud", hint: "This is a simulated environment: printers, materials and print jobs are virtual. Call health_check next." };
    case "install_preform_server":
      return { status: "not_applicable", message: "Simulated environments have no PreFormServer to install. Create a connected environment in the dashboard to drive a real PreForm install." };
    case "get_user":
      return { username: "demo", email: "demo@formbridge.local", simulated: true };
    case "login":
      return { status: "logged_in", username: "demo", email: "demo@formbridge.local", simulated: true };
    case "logout":
      return { status: "logged_out" };

    // Scenes -----------------------------------------------------------------
    case "create_scene": {
      if (a["fps_file"]) throw new E.SimError("INPUT_ERROR", "Simulated environments do not read .fps files. Provide machine_type, material_code and layer_thickness_mm instead.");
      const mt = a["machine_type"], mc = a["material_code"], lt = a["layer_thickness_mm"];
      if (!(typeof mt === "string" && typeof mc === "string" && lt !== undefined)) throw new E.SimError("INPUT_ERROR", "Provide all of machine_type, material_code and layer_thickness_mm.");
      const scene = await S.createScene(db, env.id, { machine_type: mt, material_code: mc, layer_thickness_mm: lt as number | "ADAPTIVE", print_setting: String(a["print_setting"] ?? "DEFAULT") });
      return E.scenePayload(scene);
    }
    case "list_scenes":
      return { scenes: (await S.listScenes(db, env.id)).map((s) => ({ id: s.scene_key, machine_type: s.machine_type, material_code: s.material_code, layer_thickness_mm: s.layer_thickness_mm, model_count: s.models.length })) };
    case "get_scene":
      return withScene((s) => E.scenePayload(s), false);
    case "update_scene":
      return withScene((s) => {
        const mt = typeof a["machine_type"] === "string" ? a["machine_type"] : s.machine_type;
        const mc = typeof a["material_code"] === "string" ? a["material_code"] : s.material_code;
        const lt = (a["layer_thickness_mm"] ?? s.layer_thickness_mm) as number | "ADAPTIVE";
        if (!a["machine_type"] && !a["material_code"] && a["layer_thickness_mm"] === undefined && !a["print_setting"]) throw new E.SimError("INPUT_ERROR", "Nothing to update.");
        const check = validSceneSettings(mt, mc, lt);
        if (!check.ok) throw new E.SimError("INPUT_ERROR", `${check.reason}. Call list_materials(machine_type=${mt}) for valid combinations.`);
        const printerChanged = check.printer.machine_type !== s.machine_type;
        s.machine_type = check.printer.machine_type;
        s.material_code = check.material.code;
        s.layer_thickness_mm = lt;
        if (typeof a["print_setting"] === "string") s.print_setting = a["print_setting"];
        if (printerChanged) for (const m of s.models) { m.laid_out = false; if (check.printer.technology === "SLS") m.supports = undefined; }
        return E.scenePayload(s);
      });
    case "delete_scene": {
      const key = String(a["scene_id"]);
      await S.loadScene(db, env.id, key);
      await S.deleteScene(db, env.id, key);
      return { status: "deleted", scene_id: key };
    }
    case "load_form": {
      const file = String(a["file"]);
      const { data } = await db.from("sim_artifacts").select("*").eq("environment_id", env.id).eq("path", file).eq("kind", "form").order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!data) throw new E.SimError("FILE_NOT_FOUND", `No virtual .form file at ${file}. In a simulated environment load_form only restores files written by save_form.`);
      const snap = data["scene_snapshot"] as E.SimScene;
      const scene = await S.createScene(db, env.id, { machine_type: snap.machine_type, material_code: snap.material_code, layer_thickness_mm: snap.layer_thickness_mm, print_setting: snap.print_setting });
      scene.models = snap.models.map((m) => ({ ...m, id: E.newModelId() }));
      await S.saveScene(db, env.id, scene);
      return E.scenePayload(scene);
    }

    // Models -----------------------------------------------------------------
    case "import_model": {
      const file = String(a["file"]);
      const geometry = await resolvePart(file);
      const scale = Number(a["scale"] ?? 1) * (a["units"] === "INCHES" ? 25.4 : 1);
      return withScene((s) => {
        const model: E.SimModel = {
          id: E.newModelId(),
          name: typeof a["name"] === "string" ? a["name"] : geometry.name,
          file,
          geometry,
          position: (a["position"] as E.SimModel["position"]) ?? { x: 0, y: 0, z: 0 },
          orientation: { x: 0, y: 0, z: 0 },
          scale,
          lock: "FREE",
          oriented: false,
          laid_out: false,
        };
        s.models.push(model);
        return E.modelPayload(model);
      });
    }
    case "get_model":
      return withScene((s) => E.modelPayload(E.selectModels(s, [String(a["model_id"])])[0]!), false);
    case "update_model":
      return withScene((s) => {
        const m = E.selectModels(s, [String(a["model_id"])])[0]!;
        const fields = ["name", "position", "orientation", "scale", "lock"].filter((k) => a[k] !== undefined);
        if (fields.length === 0) throw new E.SimError("INPUT_ERROR", "Nothing to update.");
        if (typeof a["name"] === "string") m.name = a["name"];
        if (a["position"]) { m.position = a["position"] as E.SimModel["position"]; m.laid_out = true; }
        if (a["orientation"]) { const o = a["orientation"] as Record<string, number>; m.orientation = { x: Number(o["x"] ?? 0), y: Number(o["y"] ?? 0), z: Number(o["z"] ?? 0) }; m.oriented = true; m.supports = undefined; }
        if (typeof a["scale"] === "number") { m.scale = a["scale"]; m.supports = undefined; }
        if (typeof a["lock"] === "string") m.lock = a["lock"];
        return E.modelPayload(m);
      });
    case "duplicate_model":
      return withScene((s) => {
        const m = E.selectModels(s, [String(a["model_id"])])[0]!;
        const count = Number(a["count"] ?? 1);
        const ids: string[] = [];
        for (let i = 0; i < count; i++) {
          const copy: E.SimModel = { ...structuredClone(m), id: E.newModelId(), name: `${m.name} (${i + 2})`, laid_out: false };
          s.models.push(copy);
          ids.push(copy.id);
        }
        return { ...E.scenePayload(s), new_model_ids: ids };
      });
    case "replace_model": {
      const geometry = await resolvePart(String(a["file"]));
      return withScene((s) => {
        const m = E.selectModels(s, [String(a["model_id"])])[0]!;
        m.geometry = geometry;
        m.file = String(a["file"]);
        return E.modelPayload(m);
      });
    }
    case "delete_model":
      return withScene((s) => {
        const m = E.selectModels(s, [String(a["model_id"])])[0]!;
        s.models = s.models.filter((x) => x.id !== m.id);
        return { status: "deleted", model_id: m.id };
      });

    // Prep -------------------------------------------------------------------
    case "auto_orient":
      return withScene((s) => E.autoOrient(s, a["models"] as "ALL" | string[], a["mode"] as "DENTAL" | undefined));
    case "auto_support":
      return withScene((s) => E.autoSupport(s, a["models"] as "ALL" | string[], { density: a["density"] as number | undefined, raft_type: a["raft_type"] as string | undefined, touchpoint_size_mm: a["touchpoint_size_mm"] as number | undefined, only_minima: a["only_minima"] as boolean | undefined }));
    case "auto_layout":
      return withScene((s) => E.autoLayout(s, a["models"] as "ALL" | string[], a["model_spacing_mm"] as number | undefined, a["placement_margin_mm"] as number | undefined));
    case "fill_build_platform":
      return withScene((s) => {
        const targets = [...E.selectModels(s, a["models"] as "ALL" | string[])];
        if (E.isSLSScene(s)) throw new E.SimError("INPUT_ERROR", "fill_build_platform is SLA only; use fill_build_chamber.");
        const copies = Math.min(E.countThatFit(s, targets, a["model_spacing_mm"] as number | undefined), 60);
        const ids: string[] = [];
        for (let i = 0; i < copies; i++) for (const t of targets) { const c = { ...structuredClone(t), id: E.newModelId(), name: `${t.name} (${i + 2})`, laid_out: false }; s.models.push(c); ids.push(c.id); }
        E.autoLayout(s, "ALL", a["model_spacing_mm"] as number | undefined, a["placement_margin_mm"] as number | undefined);
        return { new_model_ids: ids, model_count: s.models.length };
      });
    case "auto_pack":
      return withScene((s) => E.autoPack(s, { packing_mode: a["packing_mode"] as string | undefined, model_spacing_mm: a["model_spacing_mm"] as number | undefined }));
    case "fill_build_chamber":
      return withScene((s) => {
        if (!E.isSLSScene(s)) throw new E.SimError("INPUT_ERROR", "fill_build_chamber is SLS only; use fill_build_platform.");
        const targets = [...E.selectModels(s, a["models"] as "ALL" | string[])];
        const copies = Math.min(E.countThatFit(s, targets), 80);
        const ids: string[] = [];
        for (let i = 0; i < copies; i++) for (const t of targets) { const c = { ...structuredClone(t), id: E.newModelId(), name: `${t.name} (${i + 2})`, laid_out: false }; s.models.push(c); ids.push(c.id); }
        E.autoPack(s, { model_spacing_mm: a["model_spacing_mm"] as number | undefined });
        return { new_model_ids: ids, model_count: s.models.length, build_height_mm: E.buildHeight(s) };
      });
    case "pack_and_cage": {
      const scenes = await S.listScenes(db, env.id);
      const s = scenes[scenes.length - 1];
      if (!s) throw new E.SimError("SCENE_NOT_FOUND", "No scene exists yet.");
      if (!E.isSLSScene(s)) throw new E.SimError("INPUT_ERROR", "pack_and_cage is SLS only.");
      E.autoPack(s, { packing_mode: (a["packing_type"] as string | undefined) === "PACK_HEIGHT" ? "PACK_HEIGHT" : "PACK_VOLUME", model_spacing_mm: a["model_spacing_mm"] as number | undefined });
      for (const m of E.selectModels(s, a["models"] as "ALL" | string[])) m.caged = true;
      await S.saveScene(db, env.id, s);
      return { ...E.scenePayload(s), cage_label: a["cage_label"] ?? null };
    }
    case "hollow_model":
      return withScene((s) => E.hollow(s, a["models"] as "ALL" | string[], a["wall_thickness_mm"] as number | undefined));
    case "label_model":
      return withScene((s) => {
        const m = E.selectModels(s, [String(a["model_id"])])[0]!;
        m.labels = [...(m.labels ?? []), String(a["label"])];
        return { status: "labelled", model_id: m.id, labels: m.labels, application_mode: a["application_mode"] ?? "EMBOSS" };
      });
    case "add_drain_holes":
      return withScene((s) => {
        const m = E.selectModels(s, [String(a["model_id"])])[0]!;
        const holes = Array.isArray(a["drain_holes"]) ? a["drain_holes"].length : 0;
        m.drain_holes = (m.drain_holes ?? 0) + holes;
        return { status: "added", model_id: m.id, holes_added: holes, warnings: [], infos: [] };
      });
    case "auto_add_drain_holes":
      return withScene((s) => {
        const results: unknown[] = [];
        const max = Number(a["max_holes_per_model"] ?? 4);
        for (const m of E.selectModels(s, a["models"] as "ALL" | string[])) {
          const cups = Math.max(0, (m.oriented ? Math.max(0, m.geometry.cups - 1) : m.geometry.cups) - (m.drain_holes ?? 0));
          if (cups <= 0) { results.push({ model_id: m.id, status: "skipped", reason: "no cups" }); continue; }
          const n = Math.min(cups, max);
          m.drain_holes = (m.drain_holes ?? 0) + n;
          results.push({ model_id: m.id, status: "added", cups_detected: cups, holes_requested: n, warnings: [], infos: [] });
        }
        return { results };
      });

    // Analysis ---------------------------------------------------------------
    case "get_print_validation":
      return withScene((s) => E.validation(s), false);
    case "detect_cups":
      return withScene((s) => E.cupDetection(s), false);
    case "detect_minima":
      return withScene((s) => E.minimaDetection(s), false);
    case "detect_supportedness":
      return withScene((s) => E.supportedness(s), false);
    case "detect_thin_walls":
      return withScene((s) => E.thinWalls(s, a["models"] as "ALL" | string[], Number(a["threshold_mm"])), false);
    case "get_interferences":
      return withScene((s) => E.interferences(s, a["collision_offset_mm"] as number | undefined), false);
    case "estimate_print_time":
      return withScene((s) => {
        if (s.models.length === 0) throw new E.SimError("EMPTY_SCENE", "The scene has no models to estimate.");
        return E.estimate(s);
      }, false);

    // Export -----------------------------------------------------------------
    case "save_form":
    case "save_screenshot":
    case "save_fps_file": {
      const file = String(a["file"]);
      const kind = name === "save_form" ? "form" : name === "save_fps_file" ? "fps" : file.toLowerCase().endsWith(".webp") ? "webp" : "png";
      const scene = await S.loadScene(db, env.id, sceneKey());
      if (name !== "save_fps_file" && scene.models.length === 0) throw new E.SimError("EMPTY_SCENE", "The scene has no models to save.");
      const { error } = await db.from("sim_artifacts").insert({ environment_id: env.id, path: file, kind, scene_snapshot: scene });
      if (error) throw error;
      return { status: "saved", file, virtual: true, note: "Simulated environment: the file is recorded in the dashboard (Files) rather than written to disk." };
    }

    // Printers ---------------------------------------------------------------
    case "list_devices": {
      const farm = await S.loadFarm(db, env);
      const settings = S.envSettings(env);
      let list = farm.printers.map((p) => E.devicePayload(p, farm.jobs.find((j) => j.id === p.current_job_id), settings, farm.jobs.filter((j) => j.printer_id === p.id && j.status === "queued").length));
      if (a["can_print"] === true) list = list.filter((d) => d["can_print"]);
      if (a["can_print"] === false) list = list.filter((d) => !d["can_print"]);
      return { devices: list, count: list.length };
    }
    case "get_device": {
      const farm = await S.loadFarm(db, env);
      const p = S.findPrinter(farm.printers, String(a["device_id"]));
      if (!p) throw new E.SimError("DEVICE_NOT_FOUND", `No printer ${a["device_id"]}. Known: ${farm.printers.map((x) => x.serial).join(", ")}`);
      return E.devicePayload(p, farm.jobs.find((j) => j.id === p.current_job_id), S.envSettings(env), farm.jobs.filter((j) => j.printer_id === p.id && j.status === "queued").length);
    }
    case "discover_devices": {
      const farm = await S.loadFarm(db, env);
      const online = farm.printers.filter((p) => p.online && (!a["ip_address"] || p.ip_address === a["ip_address"]));
      return { discovered: online.map((p) => ({ id: p.serial, ip_address: p.ip_address, product_name: p.product_name })), count: online.length };
    }
    case "print_to_printer": {
      const scene = await S.loadScene(db, env.id, sceneKey());
      return S.submitPrint(db, env, scene, String(a["printer"]), String(a["job_name"]), a["print_now"] === true, { tokenId: (a["__token_id"] as string | undefined) ?? null });
    }

    // Materials --------------------------------------------------------------
    case "list_materials": {
      const data = listMaterialsPayload();
      const mt = typeof a["machine_type"] === "string" ? a["machine_type"].toUpperCase() : undefined;
      if (!mt) return data;
      return { printer_types: data.printer_types.filter((p) => ((p as { supported_machine_type_ids: string[] }).supported_machine_type_ids ?? []).includes(mt)) };
    }
    case "list_printer_types":
      return PRINTER_TYPES.map((p) => ({ label: p.label, machine_types: [p.machine_type], product_names: [p.product_name], build_volume_dimensions_mm: p.build_volume_mm, technology: p.technology, material_count: p.materials.length }));

    default:
      throw new E.SimError("UNKNOWN_TOOL", `Tool ${name} is not implemented by the simulator`);
  }
}

export { materialOf };
