"""End-to-end smoke test against a real PreFormServer.

    uv run python tests/smoke_e2e.py [/abs/path/to/part.stl]

Uses the same discovery as the MCP server (auto-detects PreFormServer, or
honours PREFORM_SERVER_PATH / PREFORM_SERVER_URL), calls the tool functions
directly, and prints PASS/FAIL per step. Exit code is non-zero on failure.
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

from formlabs_local_mcp import server
from formlabs_local_mcp.client import PreFormClient
from formlabs_local_mcp.config import Config
from formlabs_local_mcp.preform import PreFormServerProcess

CUBE_STL = """solid cube
{faces}
endsolid cube
"""


def _cube_stl(size: float = 10.0) -> str:
    s = size
    v = [(0, 0, 0), (s, 0, 0), (s, s, 0), (0, s, 0), (0, 0, s), (s, 0, s), (s, s, s), (0, s, s)]
    tris = [
        (0, 2, 1),
        (0, 3, 2),
        (4, 5, 6),
        (4, 6, 7),
        (0, 1, 5),
        (0, 5, 4),
        (1, 2, 6),
        (1, 6, 5),
        (2, 3, 7),
        (2, 7, 6),
        (3, 0, 4),
        (3, 4, 7),
    ]
    faces = []
    for a, b, c in tris:
        faces.append(
            "facet normal 0 0 0\n outer loop\n"
            + "".join(f"  vertex {v[i][0]} {v[i][1]} {v[i][2]}\n" for i in (a, b, c))
            + " endloop\nendfacet"
        )
    return CUBE_STL.format(faces="\n".join(faces))


@dataclass
class Ctx:
    request_context: SimpleNamespace

    async def report_progress(self, **_: object) -> None:
        pass


async def main(stl_arg: str | None) -> int:
    cfg = Config.from_env()
    print(
        f"[smoke] url={cfg.base_url} path={cfg.preform_server_path} "
        f"spawn={cfg.spawn_preform_server}"
    )
    preform = PreFormServerProcess(cfg)
    failures = 0

    def check(name: str, ok: bool, detail: str = "") -> None:
        nonlocal failures
        print(f"[{'PASS' if ok else 'FAIL'}] {name} {detail}".rstrip())
        if not ok:
            failures += 1

    workdir = Path(tempfile.mkdtemp(prefix="formlabs-smoke-", dir=Path.home()))
    try:
        await preform.ensure_running()
        check("PreFormServer reachable", True)
        client = PreFormClient(cfg)
        ctx = Ctx(SimpleNamespace(lifespan_context=server.AppContext(client, preform, cfg)))
        try:
            version = await server.health_check(ctx)
            check("health_check", bool(version.get("version")), str(version))

            printers = await server.list_printer_types(ctx)
            check("list_printer_types", len(printers) > 0, f"{len(printers)} printer families")

            scene = await server.create_scene(
                ctx, machine_type="FORM-4-0", material_code="FLGPBK05", layer_thickness_mm=0.1
            )
            scene_id = scene.get("id") or "default"
            check("create_scene", bool(scene_id), f"id={scene_id}")

            stl = Path(stl_arg) if stl_arg else workdir / "cube.stl"
            if not stl_arg:
                stl.write_text(_cube_stl())
            model = await server.import_model(ctx, file=str(stl), scene_id=scene_id)
            model_id = model.get("id")
            check("import_model", bool(model_id), f"model_id={model_id}")

            await server.auto_orient(ctx, scene_id=scene_id)
            check("auto_orient", True)
            await server.auto_support(ctx, scene_id=scene_id)
            check("auto_support", True)
            await server.auto_layout(ctx, scene_id=scene_id)
            check("auto_layout", True)

            validation = await server.get_print_validation(ctx, scene_id=scene_id)
            check("get_print_validation", "per_model_results" in validation, str(validation))
            cups = await server.detect_cups(ctx, scene_id=scene_id)
            check("detect_cups", "per_model_results" in cups, str(cups))
            drains = await server.auto_add_drain_holes(ctx, scene_id=scene_id)
            check("auto_add_drain_holes", "results" in drains, str(drains))

            est = await server.estimate_print_time(ctx, scene_id=scene_id)
            check("estimate_print_time", "total_print_time_s" in est, str(est))

            form = workdir / "cube.form"
            await server.save_form(ctx, file=str(form), scene_id=scene_id)
            check("save_form", form.is_file() and form.stat().st_size > 0, str(form))
            png = workdir / "cube.png"
            await server.save_screenshot(ctx, file=str(png), scene_id=scene_id)
            check("save_screenshot", png.is_file() and png.stat().st_size > 0, str(png))

            loaded = await server.load_form(ctx, file=str(form))
            check("load_form", len(loaded.get("models") or []) == 1, f"id={loaded.get('id')}")

            try:
                await server.import_model(ctx, file="/etc/hosts.stl", scene_id=scene_id)
                check("path guard", False, "accepted a path outside the allowlist")
            except Exception as exc:
                check("path guard", "outside" in str(exc) or "not exist" in str(exc), str(exc)[:80])
        finally:
            await client.close()
    finally:
        await preform.shutdown()
        if os.environ.get("SMOKE_KEEP"):
            print(f"[smoke] kept {workdir}")
        else:
            for f in workdir.iterdir():
                f.unlink()
            workdir.rmdir()

    print()
    print("ALL CHECKS PASSED" if failures == 0 else f"{failures} CHECK(S) FAILED")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else None)))
