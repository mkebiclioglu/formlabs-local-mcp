import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, type AppContext } from "../src/app.js";
import { PreFormError } from "../src/client.js";
import { tools, toolByName, callTool } from "../src/tools.js";
import { fakePreform, json, makeConfig, tmp } from "./helpers.js";

const servers: Server[] = [];
afterEach(() => { for (const s of servers) s.close(); servers.length = 0; });

async function appWith(routes: Parameters<typeof fakePreform>[0], overrides = {}) {
  const f = await fakePreform(routes);
  servers.push(f.server);
  const home = tmp();
  const app = createApp(makeConfig({ baseUrl: f.url, home, allowedPaths: [home], spawn: false, ...overrides }));
  return { app, home, calls: f.calls };
}

const noProgress = { progress: async () => {}, signal: new AbortController().signal };

describe("tool registry", () => {
  it("registers the full surface with annotations", () => {
    const names = new Set(tools.map((t) => t.name));
    for (const n of ["health_check", "create_scene", "import_model", "auto_orient", "auto_support", "auto_layout", "auto_pack", "fill_build_platform", "fill_build_chamber", "pack_and_cage", "hollow_model", "label_model", "add_drain_holes", "auto_add_drain_holes", "get_print_validation", "detect_cups", "detect_minima", "detect_supportedness", "detect_thin_walls", "get_interferences", "estimate_print_time", "save_form", "save_screenshot", "save_fps_file", "list_devices", "get_device", "discover_devices", "print_to_printer", "list_materials", "list_printer_types", "login", "logout", "install_preform_server", "preform_status"]) {
      expect(names, n).toContain(n);
    }
    expect(toolByName("print_to_printer").annotations.destructiveHint).toBe(true);
    expect(toolByName("save_form").annotations.destructiveHint).toBe(true);
    expect(toolByName("health_check").annotations.readOnlyHint).toBe(true);
    expect(toolByName("install_preform_server").annotations.destructiveHint).toBe(true);
    // Credentials are never tool parameters.
    expect(Object.keys(toolByName("login").input.shape)).toEqual([]);
    for (const t of tools) expect(t.description.length, t.name).toBeGreaterThan(20);
  });
});

describe("import_model", () => {
  it("validates the path, sends REPAIR + MILLIMETERS, and returns the new model", async () => {
    let scenes = 0;
    const { app, home, calls } = await appWith({
      "GET /scene/default/": (_r, _b, res) => json(res, 200, { id: "default", models: scenes++ === 0 ? [] : [{ id: "m1" }] }),
      "POST /scene/default/import-model/": (_r, _b, res) => json(res, 202, { operationId: "op" }),
      "GET /operations/op/": (_r, _b, res) => json(res, 200, { status: "SUCCEEDED", progress: 1, result: { id: "m1" } }),
    });
    const stl = join(home, "part.stl");
    writeFileSync(stl, "");
    const out = await callTool(app, "import_model", { file: stl }, noProgress);
    expect(out).toEqual({ id: "m1" });
    const body = JSON.parse(calls.find((c) => c.path.endsWith("import-model/"))!.body);
    expect(body).toMatchObject({ file: stl, repair_behavior: "REPAIR", units: "MILLIMETERS" });
  });

  it("rejects paths outside the allowlist before any HTTP call", async () => {
    const { app, calls } = await appWith({});
    await expect(callTool(app, "import_model", { file: "/etc/passwd.stl" }, noProgress)).rejects.toThrow(/outside|does not exist/);
    expect(calls).toHaveLength(0);
  });

  it("fails with IMPORT_PRODUCED_EMPTY_SCENE when nothing was added", async () => {
    const { app, home } = await appWith({
      "GET /scene/default/": (_r, _b, res) => json(res, 200, { id: "default", models: [] }),
      "POST /scene/default/import-model/": (_r, _b, res) => json(res, 202, { operationId: "op" }),
      "GET /operations/op/": (_r, _b, res) => json(res, 200, { status: "SUCCEEDED", progress: 1, result: {} }),
    });
    const stl = join(home, "part.stl");
    writeFileSync(stl, "");
    const err = await callTool(app, "import_model", { file: stl }, noProgress).catch((e) => e);
    expect(err).toBeInstanceOf(PreFormError);
    expect(err.code).toBe("IMPORT_PRODUCED_EMPTY_SCENE");
  });
});

describe("Wine path mapping", () => {
  it("sends Z: paths for inputs and outputs while validating and collecting locally", async () => {
    let scenes = 0;
    const { app, home, calls } = await appWith({
      "GET /scene/default/": (_r, _b, res) => json(res, 200, { id: "default", models: scenes++ === 0 ? [] : [{ id: "m1" }] }),
      "POST /scene/default/import-model/": (_r, _b, res) => json(res, 200, { id: "m1" }),
      "POST /scene/default/save-form/": (_r, _b, res) => json(res, 200, {}),
    }, { pathStyle: "wine", pathMap: [] });
    const stl = join(home, "part.stl");
    writeFileSync(stl, "");
    await callTool(app, "import_model", { file: stl }, noProgress);
    expect(JSON.parse(calls.find((c) => c.path.endsWith("import-model/"))!.body).file).toBe(`Z:${stl}`);
    await callTool(app, "save_form", { file: join(home, "out.form") }, noProgress);
    expect(JSON.parse(calls.find((c) => c.path.endsWith("save-form/"))!.body).file).toBe(`Z:${join(home, "out.form")}`);
  });
  it("rewrites a mounted directory for a containerised PreFormServer", async () => {
    let scenes = 0;
    const { app, home, calls } = await appWith({
      "GET /scene/default/": (_r, _b, res) => json(res, 200, { id: "default", models: scenes++ === 0 ? [] : [{ id: "m1" }] }),
      "POST /scene/default/import-model/": (_r, _b, res) => json(res, 200, { id: "m1" }),
    }, { pathStyle: "native" });
    app.config.pathMap = [{ local: home, remote: "Z:/jobs" }]; // the fake home is only known after appWith
    const stl = join(home, "sub", "part.stl");
    mkdirSync(join(home, "sub"));
    writeFileSync(stl, "");
    await callTool(app, "import_model", { file: stl }, noProgress);
    expect(JSON.parse(calls.find((c) => c.path.endsWith("import-model/"))!.body).file).toBe("Z:/jobs/sub/part.stl");
  });
});

describe("create_scene", () => {
  it("explains INPUT_ERROR in terms of list_materials", async () => {
    const { app } = await appWith({ "POST /scene/": (_r, _b, res) => json(res, 400, { error: { code: "INPUT_ERROR", message: "Scene type not supported" } }) });
    await expect(callTool(app, "create_scene", { machine_type: "FORM-4-0", material_code: "X", layer_thickness_mm: 0.05 }, noProgress)).rejects.toThrow(/list_materials/);
  });
  it("requires either fps_file or the full triple", async () => {
    const { app } = await appWith({});
    await expect(callTool(app, "create_scene", { machine_type: "FORM-4-0" }, noProgress)).rejects.toThrow(/fps_file/);
  });
});

describe("auto_add_drain_holes", () => {
  it("uses cup detection, normalizes {id} keys and only drills cupped models", async () => {
    const { app, calls } = await appWith({
      "GET /scene/default/": (_r, _b, res) => json(res, 200, { models: [
        { id: "m1", bounding_box: { min_corner: { x: -5, y: -5, z: 0 }, max_corner: { x: 5, y: 5, z: 10 } } },
        { id: "m2", bounding_box: {} },
      ] }),
      "GET /scene/default/cup-detection/": (_r, _b, res) => json(res, 200, { per_model_results: { "{m1}": { cup_count: 2 }, "{m2}": { cup_count: 0 } } }),
      "POST /scene/default/add-drain-holes/": (_r, _b, res) => json(res, 200, { warnings: [], infos: [] }),
    });
    const out = (await callTool(app, "auto_add_drain_holes", {}, noProgress)) as { results: { status: string; holes_requested?: number }[] };
    expect(out.results[0]).toMatchObject({ status: "added", holes_requested: 2 });
    expect(out.results[1]).toMatchObject({ status: "skipped" });
    expect(calls.filter((c) => c.path.endsWith("add-drain-holes/"))).toHaveLength(1);
  });
});

describe("login", () => {
  it("refuses without env credentials", async () => {
    const { app } = await appWith({});
    await expect(callTool(app, "login", {}, noProgress)).rejects.toThrow(/No Formlabs credentials/);
  });
  it("refuses a non-loopback server", async () => {
    const { app } = await appWith({}, { baseUrl: "http://10.0.0.9:44388", credentials: { username: "u", password: "p" } });
    await expect(callTool(app, "login", {}, noProgress)).rejects.toThrow(/non-local/);
  });
  it("sends env credentials and returns no tokens", async () => {
    const { app, calls } = await appWith({
      "POST /login/": (_r, _b, res) => json(res, 200, { access_token: "SECRET", refresh_token: "S2" }),
      "GET /user/": (_r, _b, res) => json(res, 200, { username: "me", email: "me@x" }),
    }, { credentials: { username: "me@x", password: "hunter2" } });
    const out = await callTool(app, "login", {}, noProgress);
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(out).toEqual({ status: "logged_in", username: "me", email: "me@x" });
    expect(calls.find((c) => c.path === "/login/")?.body).toContain("hunter2");
  });
});

describe("save_form / save_screenshot", () => {
  it("validates extensions and uses async operations", async () => {
    const { app, home, calls } = await appWith({
      "POST /scene/default/save-form/": (_r, _b, res) => json(res, 202, { operationId: "op" }),
      "GET /operations/op/": (_r, _b, res) => json(res, 200, { status: "SUCCEEDED", progress: 1, result: null }),
    });
    await expect(callTool(app, "save_form", { file: join(home, "job.sh") }, noProgress)).rejects.toThrow(/must end in/);
    const out = await callTool(app, "save_form", { file: join(home, "job.form") }, noProgress);
    expect(out).toMatchObject({ status: "saved" });
    expect(calls.filter((c) => c.path.endsWith("save-form/"))).toHaveLength(1);
  });
});

describe("list_materials", () => {
  it("filters by machine type", async () => {
    const { app } = await appWith({ "GET /list-materials/": (_r, _b, res) => json(res, 200, { printer_types: [
      { label: "Form 4", supported_machine_type_ids: ["FORM-4-0"], materials: [] },
      { label: "Fuse 1+", supported_machine_type_ids: ["FS30-1-0"], materials: [] },
    ] }) });
    const out = (await callTool(app, "list_materials", { machine_type: "form-4-0" }, noProgress)) as { printer_types: { label: string }[] };
    expect(out.printer_types.map((p) => p.label)).toEqual(["Form 4"]);
  });
});

describe("preform_status", () => {
  it("reports what is installed and configured without needing PreFormServer", async () => {
    const { app } = await appWith({});
    const out = (await callTool(app, "preform_status", {}, noProgress)) as Record<string, unknown>;
    expect(out).toMatchObject({ installed: false, mode: "local" });
    expect(out["download_page"]).toContain("formlabs.com");
  });
});

describe("app lifecycle", () => {
  it("exposes the config and a client", async () => {
    const { app } = await appWith({});
    const a: AppContext = app;
    expect(a.config.allowedPaths).toHaveLength(1);
    expect(a.client).toBeTruthy();
  });
});
