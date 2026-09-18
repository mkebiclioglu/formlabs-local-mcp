/**
 * End-to-end smoke test against a real PreFormServer.
 *
 *   npm run smoke [-- /abs/path/to/part.stl]
 *
 * Uses the same discovery as the MCP server, calls the tools directly, and
 * prints PASS/FAIL per step. Exit code is non-zero on failure.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { callTool } from "../src/tools.js";

function cubeStl(size = 10): string {
  const s = size;
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
  const tris = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const faces = tris.map((t) => `facet normal 0 0 0\n outer loop\n${t.map((i) => `  vertex ${v[i]!.join(" ")}`).join("\n")}\n endloop\nendfacet`);
  return `solid cube\n${faces.join("\n")}\nendsolid cube\n`;
}

async function main(stlArg?: string): Promise<number> {
  const cfg = loadConfig();
  console.log(`[smoke] ${JSON.stringify(cfg.summary())}`);
  const app = createApp(cfg, (l) => { if (!/New incoming|Received|disconnected|HTTP Request/.test(l)) console.error(l); });
  const ctx = { progress: async () => {}, signal: new AbortController().signal };
  let failures = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`[${ok ? "PASS" : "FAIL"}] ${name} ${detail}`.trimEnd());
    if (!ok) failures++;
  };
  const workdir = mkdtempSync(path.join(homedir(), "formlabs-smoke-"));
  try {
    const health = (await callTool(app, "health_check", {}, ctx)) as { version?: string };
    check("health_check", !!health.version, JSON.stringify(health));
    const printers = (await callTool(app, "list_printer_types", {}, ctx)) as unknown[];
    check("list_printer_types", printers.length > 0, `${printers.length} printer families`);

    const scene = (await callTool(app, "create_scene", { machine_type: "FORM-4-0", material_code: "FLGPBK05", layer_thickness_mm: 0.1 }, ctx)) as { id?: string };
    const sceneId = scene.id ?? "default";
    check("create_scene", !!scene.id, `id=${sceneId}`);

    const stl = stlArg ?? path.join(workdir, "cube.stl");
    if (!stlArg) writeFileSync(stl, cubeStl());
    const model = (await callTool(app, "import_model", { file: stl, scene_id: sceneId }, ctx)) as { id?: string };
    check("import_model", !!model.id, `model_id=${model.id}`);

    for (const step of ["auto_orient", "auto_support", "auto_layout"]) {
      await callTool(app, step, { scene_id: sceneId }, ctx);
      check(step, true);
    }
    const validation = (await callTool(app, "get_print_validation", { scene_id: sceneId }, ctx)) as Record<string, unknown>;
    check("get_print_validation", "per_model_results" in validation, JSON.stringify(validation));
    const drains = (await callTool(app, "auto_add_drain_holes", { scene_id: sceneId }, ctx)) as Record<string, unknown>;
    check("auto_add_drain_holes", "results" in drains, JSON.stringify(drains));
    const est = (await callTool(app, "estimate_print_time", { scene_id: sceneId }, ctx)) as Record<string, unknown>;
    check("estimate_print_time", "total_print_time_s" in est, JSON.stringify(est));

    const form = path.join(workdir, "cube.form");
    await callTool(app, "save_form", { file: form, scene_id: sceneId }, ctx);
    check("save_form", statSync(form).size > 0, form);
    const png = path.join(workdir, "cube.png");
    try {
      await callTool(app, "save_screenshot", { file: png, scene_id: sceneId }, ctx);
      check("save_screenshot", statSync(png).size > 0, png);
    } catch (err) {
      // Headless CI runners without a GPU can crash PreFormServer's renderer; that is an
      // environment limit, not a tool bug, so allow it to be downgraded to a warning there.
      if (process.env["SMOKE_ALLOW_SCREENSHOT_FAIL"]) console.log(`[WARN] save_screenshot ${(err as Error).message}`);
      else check("save_screenshot", false, (err as Error).message);
    }
    const loaded = (await callTool(app, "load_form", { file: form }, ctx)) as { id?: string; models?: unknown[] };
    check("load_form", (loaded.models?.length ?? 0) === 1, `id=${loaded.id}`);

    // PreFormServer ships one built-in virtual printer per model ("Form 4", "Fuse 1+", ...;
    // connection_type VIRTUAL). Printing to one exercises the whole job upload path without
    // hardware, so this is the closest thing to a print test a CI runner can do.
    const devices = (await callTool(app, "list_devices", {}, ctx)) as { devices?: { id?: string; connection_type?: string }[] };
    const virtual = (devices.devices ?? []).filter((d) => d.connection_type === "VIRTUAL").map((d) => d.id);
    check("list_devices", virtual.includes("Form 4"), `${virtual.length} virtual printers`);
    // The scene from load_form: the original may be gone if the screenshot crashed PreFormServer.
    const job = (await callTool(app, "print_to_printer", { printer: "Form 4", job_name: "smoke", scene_id: loaded.id ?? sceneId }, ctx)) as { job_id?: string };
    check("print_to_printer (virtual Form 4)", !!job.job_id, `job_id=${job.job_id}`);

    const guard = await callTool(app, "import_model", { file: "/etc/hosts.stl", scene_id: sceneId }, ctx).then(() => "accepted", (e: Error) => e.message);
    check("path guard", /outside|does not exist/.test(guard), guard.slice(0, 80));
  } finally {
    await app.close();
    if (process.env["SMOKE_KEEP"]) console.log(`[smoke] kept ${workdir}`);
    else rmSync(workdir, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  return failures === 0 ? 0 : 1;
}

main(process.argv[2]).then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
