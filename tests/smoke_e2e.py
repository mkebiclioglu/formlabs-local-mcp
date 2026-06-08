"""End-to-end smoke test against a real PreFormServer.

Run with:
    PREFORM_SERVER_PATH=/path/to/PreFormServer python tests/smoke_e2e.py

Spawns PreFormServer via the MCP server's lifespan, then exercises a few
real tool calls in-process (skipping the MCP transport layer). Prints
PASS/FAIL for each step.
"""

from __future__ import annotations

import asyncio
import os
import sys

from formlabs_local_mcp.client import PreFormClient, PreFormError
from formlabs_local_mcp.config import Config
from formlabs_local_mcp.preform import PreFormServerProcess


async def main() -> int:
    cfg = Config.from_env()
    print(f"[smoke] base_url={cfg.base_url}")
    print(f"[smoke] spawn={cfg.spawn_preform_server} path={cfg.preform_server_path}")

    preform = PreFormServerProcess(cfg)
    failures = 0
    try:
        await preform.ensure_running()
        print("[PASS] PreFormServer is reachable")

        client = PreFormClient(cfg)
        try:
            # 1. health_check
            version = await client.get("/")
            print(f"[PASS] health_check → {version}")

            # 2. list_materials — shape is {"printer_types": [...]}
            try:
                materials = await client.get("/list-materials/")
                printers = materials.get("printer_types") or []
                print(f"[PASS] list_materials → {len(printers)} printer types")
                if printers:
                    print(f"        sample printer: {printers[0].get('label')}")
            except PreFormError as exc:
                print(f"[FAIL] list_materials → {exc}")
                failures += 1

            # 3. create_scene with a known good combo (Form 4, Black V5)
            try:
                scene = await client.post(
                    "/scene/",
                    json={
                        "machine_type": "FORM-4-0",
                        "material_code": "FLGPBK05",
                        "print_setting": "DEFAULT",
                        "layer_thickness_mm": 0.025,
                    },
                )
                scene_id = scene.get("id") or scene.get("scene_id")
                print(f"[PASS] create_scene → id={scene_id}")
            except PreFormError as exc:
                print(f"[FAIL] create_scene → {exc}")
                scene_id = None
                failures += 1

            # 4. import_model with REPAIR + MILLIMETERS (mirrors the MCP tool's defaults).
            # Override with FORMLABS_TEST_STL if you have a known-good file.
            if scene_id:
                stl_path = os.environ.get(
                    "FORMLABS_TEST_STL",
                    os.path.expanduser("~/part_20260607_233556.stl"),
                )
                if not os.path.exists(stl_path):
                    print(f"[SKIP] import_model → no STL at {stl_path}")
                else:
                    try:
                        result = await client.post_async_operation(
                            f"/scene/{scene_id}/import-model/",
                            json={
                                "file": stl_path,
                                "repair_behavior": "REPAIR",
                                "units": "MILLIMETERS",
                                "scale": 1.0,
                            },
                        )
                        # Verify the scene actually has the model now.
                        after = await client.get(f"/scene/{scene_id}/")
                        models = after.get("models") or []
                        if not models:
                            print("[FAIL] import_model → operation succeeded but scene is empty")
                            failures += 1
                        else:
                            print(f"[PASS] import_model → {len(models)} model(s) in scene")
                    except PreFormError as exc:
                        print(f"[FAIL] import_model → {exc}")
                        failures += 1

            # 5. list_scenes — should include our scene
            try:
                scenes = await client.get("/scenes/")
                n = len(scenes) if isinstance(scenes, list) else len(scenes.get("scenes", []))
                print(f"[PASS] list_scenes → {n} scenes")
            except PreFormError as exc:
                print(f"[FAIL] list_scenes → {exc}")
                failures += 1

        finally:
            await client.close()
    finally:
        await preform.shutdown()

    print()
    if failures == 0:
        print("ALL CHECKS PASSED")
        return 0
    print(f"{failures} CHECK(S) FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
