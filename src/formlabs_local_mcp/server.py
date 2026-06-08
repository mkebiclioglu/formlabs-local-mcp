"""Formlabs Local API MCP server.

Each MCP tool corresponds to one PreFormServer endpoint. Long-running endpoints
are called with ?async=true and polled internally so each tool call is
synchronous from the MCP caller's perspective.

Conventions:
- `scene_id` defaults to "default" so simple workflows don't have to track IDs.
- File path parameters MUST be absolute paths (PreFormServer rejects relative
  paths, env vars, and URLs — see the API docs).
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from mcp.server.fastmcp import Context, FastMCP

from formlabs_local_mcp.client import PreFormClient, PreFormError
from formlabs_local_mcp.config import Config
from formlabs_local_mcp.preform import PreFormServerProcess

log = logging.getLogger("formlabs_local_mcp")


@dataclass
class AppContext:
    client: PreFormClient
    preform: PreFormServerProcess


@asynccontextmanager
async def app_lifespan(_server: FastMCP) -> AsyncIterator[AppContext]:
    config = Config.from_env()
    preform = PreFormServerProcess(config)
    await preform.ensure_running()
    client = PreFormClient(config)
    try:
        yield AppContext(client=client, preform=preform)
    finally:
        await client.close()
        await preform.shutdown()


mcp = FastMCP(
    "formlabs-local",
    instructions=(
        "Drives a local Formlabs PreFormServer for 3D print job preparation. "
        "Typical flow: create_scene → import_model → auto_orient → auto_support → "
        "estimate_print_time → save_form or print_to_printer. "
        "All file paths must be absolute."
    ),
    lifespan=app_lifespan,
)


def _client(ctx: Context) -> PreFormClient:
    return ctx.request_context.lifespan_context.client  # type: ignore[attr-defined]


async def _report_progress(ctx: Context, fraction: float, label: str) -> None:
    try:
        await ctx.report_progress(progress=fraction, total=1.0, message=label)
    except Exception:
        # Older MCP clients may not support progress; never let it crash the call.
        pass


# ---------------------------------------------------------------------------
# Server lifecycle / health
# ---------------------------------------------------------------------------

@mcp.tool()
async def health_check(ctx: Context) -> dict:
    """Return the PreFormServer API version. Use this to confirm the server is reachable."""
    return await _client(ctx).get("/")


# ---------------------------------------------------------------------------
# Scene management
# ---------------------------------------------------------------------------

@mcp.tool()
async def create_scene(
    ctx: Context,
    machine_type: str | None = None,
    material_code: str | None = None,
    print_setting: str = "DEFAULT",
    layer_thickness_mm: float | None = None,
    fps_file: str | None = None,
) -> dict:
    """Create a new scene with the given printer setup.

    Provide EITHER (machine_type + material_code + layer_thickness_mm) OR fps_file
    (absolute path to a .fps print-settings file). Returns the scene including its `id`.

    Use `list_materials` to discover valid machine_type / material_code combinations.
    """
    body: dict[str, Any] = {"print_setting": print_setting}
    if fps_file:
        body["fps_file"] = fps_file
    else:
        if not (machine_type and material_code and layer_thickness_mm):
            raise ValueError(
                "Provide either fps_file or all of machine_type, material_code, layer_thickness_mm"
            )
        body["machine_type"] = machine_type
        body["material_code"] = material_code
        body["layer_thickness_mm"] = layer_thickness_mm
    return await _client(ctx).post("/scene/", json=body)


@mcp.tool()
async def list_scenes(ctx: Context) -> dict:
    """List all scenes currently cached by PreFormServer."""
    return await _client(ctx).get("/scenes/")


@mcp.tool()
async def get_scene(ctx: Context, scene_id: str = "default") -> dict:
    """Get the full state of a scene including loaded models and print settings."""
    return await _client(ctx).get(f"/scene/{scene_id}/")


@mcp.tool()
async def delete_scene(ctx: Context, scene_id: str) -> dict:
    """Delete a cached scene. Cannot delete the 'default' scene this way — use a fresh create_scene call."""
    if scene_id == "default":
        # The API exposes DELETE /scene/default/ separately with different semantics
        # (it resets, not deletes). Surface that distinction here.
        result = await _client(ctx).delete("/scene/default/")
        return result or {"status": "reset"}
    result = await _client(ctx).delete(f"/scene/{scene_id}/")
    return result or {"status": "deleted", "scene_id": scene_id}


@mcp.tool()
async def load_form(ctx: Context, file: str) -> dict:
    """Load a .form file from disk and create a new scene from it.

    `file` must be an absolute path. Returns the new scene.
    """
    return await _client(ctx).post("/load-form/", json={"file": file})


# ---------------------------------------------------------------------------
# Models within a scene
# ---------------------------------------------------------------------------

@mcp.tool()
async def import_model(
    ctx: Context,
    file: str,
    scene_id: str = "default",
    name: str | None = None,
    scale: float = 1.0,
    units: str = "MILLIMETERS",
    repair_behavior: str = "REPAIR",
    position: dict | None = None,
    orientation: dict | None = None,
) -> dict:
    """Import an STL/OBJ model into a scene.

    `file` MUST be an absolute path. Returns the imported model's properties
    including its `id`.

    Defaults that differ from the bare API:
    - `repair_behavior` defaults to `REPAIR`. The raw API default is
      `KEEP_AS_IS`, which silently produces an empty scene for STLs exported
      by many CAD tools (OpenCASCADE, Fusion 360, etc.). Pass `"KEEP_AS_IS"`
      or `"NONE"` if you need to preserve the original mesh exactly.
    - `units` defaults to `MILLIMETERS`. Pass `CENTIMETERS`, `INCHES`,
      `METERS`, or `MICRONS` if your file uses something else.

    Post-import verification: this tool re-reads the scene after the import
    operation reports SUCCEEDED and raises an error if the model count did
    not actually increase — defense against the silent-failure mode where
    the operation succeeds but the mesh fails to load.
    """
    client = _client(ctx)
    body: dict[str, Any] = {
        "file": file,
        "scale": scale,
        "units": units,
        "repair_behavior": repair_behavior,
    }
    if name:
        body["name"] = name
    if position:
        body["position"] = position
    if orientation:
        body["orientation"] = orientation

    # Count models before for the post-condition check.
    try:
        before_scene = await client.get(f"/scene/{scene_id}/")
        before_count = len(before_scene.get("models") or [])
    except PreFormError:
        before_count = 0

    await _report_progress(ctx, 0.0, "importing model")
    result = await client.post_async_operation(
        f"/scene/{scene_id}/import-model/",
        json=body,
        progress_callback=lambda p: _report_progress(ctx, p, "importing model"),
    )
    await _report_progress(ctx, 1.0, "imported")

    # Defense in depth: confirm the scene actually has more models now.
    after_scene = await client.get(f"/scene/{scene_id}/")
    after_models = after_scene.get("models") or []
    if len(after_models) <= before_count:
        raise PreFormError(
            500,
            "IMPORT_PRODUCED_EMPTY_SCENE",
            (
                f"PreFormServer reported a successful import of {file} but the scene "
                f"still contains {len(after_models)} model(s). The STL likely failed "
                "to parse — try a different repair_behavior, verify the units, or "
                "open the file in PreForm to diagnose."
            ),
            body={"scene_id": scene_id, "import_result": result},
        )

    # If the async result lacked the model id (some PreFormServer versions),
    # fall back to the newly-added model from the scene.
    if isinstance(result, dict) and not result.get("id"):
        # The new model is whichever model wasn't there before.
        before_ids = {m.get("id") for m in (before_scene.get("models") or [])}
        new_models = [m for m in after_models if m.get("id") not in before_ids]
        if new_models:
            return new_models[-1]
    return result


@mcp.tool()
async def update_model(
    ctx: Context,
    model_id: str,
    scene_id: str = "default",
    position: dict | None = None,
    orientation: dict | None = None,
    scale: float | None = None,
) -> dict:
    """Update a model's transform (position, orientation, uniform scale)."""
    body: dict[str, Any] = {}
    if position is not None:
        body["position"] = position
    if orientation is not None:
        body["orientation"] = orientation
    if scale is not None:
        body["scale"] = scale
    return await _client(ctx).post(f"/scene/{scene_id}/models/{model_id}/", json=body)


@mcp.tool()
async def delete_model(ctx: Context, model_id: str, scene_id: str = "default") -> dict:
    """Remove a model from the scene."""
    result = await _client(ctx).delete(f"/scene/{scene_id}/models/{model_id}/")
    return result or {"status": "deleted", "model_id": model_id}


# ---------------------------------------------------------------------------
# Auto operations (long-running)
# ---------------------------------------------------------------------------

@mcp.tool()
async def auto_orient(
    ctx: Context,
    scene_id: str = "default",
    models: str | list[str] = "ALL",
    tilt: float | None = None,
) -> dict:
    """Automatically choose orientation to minimize supports.

    `models` is "ALL" or a list of model IDs.
    """
    body: dict[str, Any] = {"models": models}
    if tilt is not None:
        body["tilt"] = tilt
    return await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/auto-orient/",
        json=body,
        progress_callback=lambda p: _report_progress(ctx, p, "auto-orienting"),
    )


@mcp.tool()
async def auto_support(
    ctx: Context,
    scene_id: str = "default",
    models: str | list[str] = "ALL",
    density: float | None = None,
    slope_multiplier: float | None = None,
    only_minima: bool | None = None,
    raft_type: str | None = None,
    touchpoint_size_mm: float | None = None,
    internal_supports_enabled: bool | None = None,
) -> dict:
    """Generate support structures.

    `models` is "ALL" or a list of model IDs. `raft_type` is FULL_RAFT,
    MINI_RAFT, or MINI_RAFTS_ON_BP.
    """
    body: dict[str, Any] = {"models": models}
    for key, value in [
        ("density", density),
        ("slope_multiplier", slope_multiplier),
        ("only_minima", only_minima),
        ("raft_type", raft_type),
        ("touchpoint_size_mm", touchpoint_size_mm),
        ("internal_supports_enabled", internal_supports_enabled),
    ]:
        if value is not None:
            body[key] = value
    return await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/auto-support/",
        json=body,
        progress_callback=lambda p: _report_progress(ctx, p, "generating supports"),
    )


@mcp.tool()
async def auto_layout(
    ctx: Context,
    scene_id: str = "default",
    models: str | list[str] = "ALL",
    alignment: str | None = None,
    spacing_mm: float | None = None,
) -> dict:
    """Arrange models on the build platform. SLA printers only (Form 4, Form 3, etc.).

    For SLS printers like the Fuse, use `auto_pack` instead.
    """
    body: dict[str, Any] = {"models": models}
    if alignment is not None:
        body["alignment"] = alignment
    if spacing_mm is not None:
        body["spacing_mm"] = spacing_mm
    return await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/auto-layout/",
        json=body,
        progress_callback=lambda p: _report_progress(ctx, p, "auto-layout"),
    )


@mcp.tool()
async def auto_pack(
    ctx: Context,
    scene_id: str = "default",
    models: str | list[str] = "ALL",
    spacing_mm: float | None = None,
) -> dict:
    """Pack models into the build volume. SLS printers only (Fuse 1+, Fuse 1).

    For SLA printers, use `auto_layout` instead.
    """
    body: dict[str, Any] = {"models": models}
    if spacing_mm is not None:
        body["spacing_mm"] = spacing_mm
    return await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/auto-pack/",
        json=body,
        progress_callback=lambda p: _report_progress(ctx, p, "auto-packing"),
    )


# ---------------------------------------------------------------------------
# Model modifications
# ---------------------------------------------------------------------------

@mcp.tool()
async def hollow_model(
    ctx: Context,
    scene_id: str = "default",
    models: str | list[str] = "ALL",
    wall_thickness_mm: float | None = None,
) -> dict:
    """Hollow the specified models to reduce material usage."""
    body: dict[str, Any] = {"models": models}
    if wall_thickness_mm is not None:
        body["wall_thickness_mm"] = wall_thickness_mm
    return await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/hollow/",
        json=body,
        progress_callback=lambda p: _report_progress(ctx, p, "hollowing"),
    )


@mcp.tool()
async def add_drain_holes(
    ctx: Context,
    scene_id: str,
    holes: list[dict],
) -> dict:
    """Add drain holes to hollowed models.

    `holes` is a list of hole specs; each must include the model_id, position,
    and diameter_mm. Refer to the API docs for the full hole schema.
    """
    return await _client(ctx).post(
        f"/scene/{scene_id}/add-drain-holes/",
        json={"holes": holes},
    )


# ---------------------------------------------------------------------------
# Validation & estimation
# ---------------------------------------------------------------------------

@mcp.tool()
async def estimate_print_time(ctx: Context, scene_id: str = "default") -> dict:
    """Estimate print time and material usage for the current scene."""
    return await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/estimate-print-time/",
        json={},
        progress_callback=lambda p: _report_progress(ctx, p, "estimating"),
    )


@mcp.tool()
async def get_print_validation(ctx: Context, scene_id: str = "default") -> dict:
    """Run print validation. Returns errors and warnings that would block or affect printing."""
    return await _client(ctx).get(f"/scene/{scene_id}/print-validation/")


# ---------------------------------------------------------------------------
# Exporting
# ---------------------------------------------------------------------------

@mcp.tool()
async def save_form(ctx: Context, file: str, scene_id: str = "default") -> dict:
    """Save the current scene to a .form file at the given absolute path."""
    result = await _client(ctx).post(
        f"/scene/{scene_id}/save-form/",
        json={"file": file},
    )
    return result or {"status": "saved", "file": file}


@mcp.tool()
async def save_screenshot(
    ctx: Context,
    file: str,
    scene_id: str = "default",
    width: int = 1024,
    height: int = 768,
) -> dict:
    """Save a PNG screenshot of the scene to the given absolute path."""
    result = await _client(ctx).post(
        f"/scene/{scene_id}/save-screenshot/",
        json={"file": file, "width": width, "height": height},
    )
    return result or {"status": "saved", "file": file}


# ---------------------------------------------------------------------------
# Devices and printing
# ---------------------------------------------------------------------------

@mcp.tool()
async def list_devices(ctx: Context) -> dict:
    """List devices PreFormServer has discovered so far. Run `discover_devices` first to refresh."""
    return await _client(ctx).get("/devices/")


@mcp.tool()
async def discover_devices(
    ctx: Context,
    timeout_seconds: int = 10,
    ip_address: str | None = None,
) -> dict:
    """Actively scan the local network for Formlabs printers.

    If `ip_address` is given, only that address is probed.
    """
    body: dict[str, Any] = {"timeout_seconds": timeout_seconds}
    if ip_address:
        body["ip_address"] = ip_address
    return await _client(ctx).post_async_operation(
        "/discover-devices/",
        json=body,
        progress_callback=lambda p: _report_progress(ctx, p, "discovering devices"),
    )


@mcp.tool()
async def print_to_printer(
    ctx: Context,
    printer: str,
    job_name: str,
    scene_id: str = "default",
    print_now: bool | None = None,
    find_printer_timeout_seconds: int = 30,
) -> dict:
    """Upload the scene to a printer and queue (or start) the print.

    `printer` is the printer serial name, local IP address, or Fleet Control queue ID.
    Remote printing requires a prior `login` call.

    If `print_now` is None, the server prints immediately when the printer is ready
    and queues otherwise.
    """
    body: dict[str, Any] = {
        "printer": printer,
        "job_name": job_name,
        "find_printer_timeout_seconds": find_printer_timeout_seconds,
    }
    if print_now is not None:
        body["print_now"] = print_now
    return await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/print/",
        json=body,
        progress_callback=lambda p: _report_progress(ctx, p, "uploading to printer"),
    )


# ---------------------------------------------------------------------------
# Materials & auth
# ---------------------------------------------------------------------------

@mcp.tool()
async def list_materials(ctx: Context) -> dict:
    """List every printer type, material, and print setting PreFormServer knows about.

    Returns `{"printer_types": [...]}` where each printer entry contains its
    `label`, `build_volume_dimensions_mm`, and a `materials` list. Each material
    has `material_settings` with the exact `machine_type`, `material_code`,
    `print_setting`, and `layer_thickness_mm` you need to pass to `create_scene`.

    NOTE: this endpoint ignores query parameters — you always get the full
    list. For a smaller summary of just printer codes, use `list_printer_types`.
    """
    return await _client(ctx).get("/list-materials/")


@mcp.tool()
async def list_printer_types(ctx: Context) -> list[dict]:
    """Quick reference for the machine_type codes you can pass to create_scene.

    Returns a list of `{machine_type, label, build_volume_dimensions_mm}` —
    one entry per printer family PreFormServer supports. Use this when the
    user names a printer ("the Form 4", "the Fuse") to look up the right code.

    Common values for context:
      - FORM-4-0    Form 4 / 4B (SLA — use auto_layout)
      - FORM-3-0    Form 3 / 3B / 3+ / 3B+ (SLA — use auto_layout)
      - FORM-2-0    Form 2 (SLA — use auto_layout)
      - FS30-1-0    Fuse 1+ 30W (SLS — use auto_pack)
      - FS-1-0      Fuse 1 (SLS — use auto_pack)
    """
    materials = await _client(ctx).get("/list-materials/")
    printers = materials.get("printer_types") or []
    out: list[dict] = []
    for p in printers:
        # Pick the first material's first setting to surface the machine_type code.
        codes: set[str] = set()
        for m in p.get("materials") or []:
            for s in m.get("material_settings") or []:
                code = (s.get("scene_settings") or {}).get("machine_type")
                if code:
                    codes.add(code)
        for code in sorted(codes):
            out.append(
                {
                    "machine_type": code,
                    "label": p.get("label"),
                    "build_volume_dimensions_mm": p.get("build_volume_dimensions_mm"),
                }
            )
    return out


@mcp.tool()
async def login(ctx: Context, username: str, password: str) -> dict:
    """Log in to Formlabs Web Services. Required for remote printing and Fleet Control."""
    result = await _client(ctx).post(
        "/login/",
        json={"username": username, "password": password},
    )
    return result or {"status": "logged_in"}


@mcp.tool()
async def logout(ctx: Context) -> dict:
    """Log out of Formlabs Web Services."""
    result = await _client(ctx).post("/logout/", json={})
    return result or {"status": "logged_out"}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=__import__("sys").stderr,
    )
    mcp.run()


if __name__ == "__main__":
    main()
