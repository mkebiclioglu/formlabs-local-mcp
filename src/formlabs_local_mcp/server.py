"""Formlabs Local API MCP server.

Each tool wraps one PreFormServer endpoint (Local API 0.9.x). Long-running
endpoints are called with `?async=true` and polled, so every tool call is
synchronous from the model's point of view and reports progress while it waits.

Conventions:
- `scene_id` defaults to "default" so simple flows never have to track IDs.
- Every file path is validated by `formlabs_local_mcp.paths` before it is
  forwarded: absolute, under an allowed directory, not hidden, right extension.
"""

from __future__ import annotations

import logging
import math
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from mcp.server.mcpserver import Context, MCPServer
from mcp.types import ToolAnnotations

from formlabs_local_mcp import __version__
from formlabs_local_mcp.client import PreFormClient, PreFormError
from formlabs_local_mcp.config import Config
from formlabs_local_mcp.paths import (
    FORM_EXTENSIONS,
    FPS_EXTENSIONS,
    IMAGE_EXTENSIONS,
    MODEL_EXTENSIONS,
    input_path,
    output_path,
)
from formlabs_local_mcp.preform import PreFormServerProcess

log = logging.getLogger("formlabs_local_mcp")

Models = str | list[str]
JSON = dict[str, Any]


@dataclass
class AppContext:
    client: PreFormClient
    preform: PreFormServerProcess
    config: Config


@asynccontextmanager
async def app_lifespan(_server: MCPServer[AppContext]) -> AsyncIterator[AppContext]:
    config = Config.from_env()
    log.info(
        "PreFormServer: url=%s path=%s spawn=%s allowed_paths=%s",
        config.base_url,
        config.preform_server_path,
        config.spawn_preform_server,
        [str(p) for p in config.allowed_paths],
    )
    preform = PreFormServerProcess(config)
    await preform.ensure_running()
    client = PreFormClient(config)
    try:
        yield AppContext(client=client, preform=preform, config=config)
    finally:
        await client.close()
        await preform.shutdown()


mcp: MCPServer[AppContext] = MCPServer(
    "formlabs",
    version=__version__,
    instructions=(
        "Prepares and sends 3D print jobs through a local Formlabs PreFormServer. "
        "Typical flow: create_scene -> import_model -> auto_orient -> auto_support -> "
        "auto_layout (SLA) or auto_pack (SLS) -> get_print_validation -> "
        "estimate_print_time -> save_form or print_to_printer. "
        "File paths must be absolute and live under the user's home directory. "
        "Always confirm with the user before print_to_printer."
    ),
    lifespan=app_lifespan,
)

READ_ONLY = ToolAnnotations(read_only_hint=True, destructive_hint=False)
MUTATING = ToolAnnotations(read_only_hint=False, destructive_hint=False)
DESTRUCTIVE = ToolAnnotations(read_only_hint=False, destructive_hint=True)


def _app(ctx: Context) -> AppContext:
    return ctx.request_context.lifespan_context


def _client(ctx: Context) -> PreFormClient:
    return _app(ctx).client


def _config(ctx: Context) -> Config:
    return _app(ctx).config


def _progress(ctx: Context, label: str):
    async def report(fraction: float) -> None:
        try:
            await ctx.report_progress(progress=fraction, total=1.0, message=label)
        except Exception:
            # Clients without progress support must never break a call.
            pass

    return report


def _body(**kwargs: Any) -> JSON:
    """Build a request body, dropping None values so server defaults apply."""
    return {k: v for k, v in kwargs.items() if v is not None}


# ---------------------------------------------------------------------------
# Health and account
# ---------------------------------------------------------------------------


@mcp.tool(annotations=READ_ONLY)
async def health_check(ctx: Context) -> JSON:
    """Return the PreFormServer version. Call this first to confirm the server is reachable."""
    return await _client(ctx).get("/")


@mcp.tool(annotations=READ_ONLY)
async def get_user(ctx: Context) -> JSON:
    """Return the Formlabs account currently logged in (after `login`)."""
    return await _client(ctx).get("/user/")


# ---------------------------------------------------------------------------
# Scenes
# ---------------------------------------------------------------------------


@mcp.tool(annotations=MUTATING)
async def create_scene(
    ctx: Context,
    machine_type: str | None = None,
    material_code: str | None = None,
    layer_thickness_mm: float | str | None = None,
    print_setting: str = "DEFAULT",
    fps_file: str | None = None,
) -> JSON:
    """Create a new scene for a given printer and material. Returns the scene, including its `id`.

    Provide EITHER machine_type + material_code + layer_thickness_mm, OR the absolute
    path of a .fps print-settings file. Use `list_printer_types` and `list_materials`
    to find valid codes; never guess them. `layer_thickness_mm` may also be "ADAPTIVE"
    on printers that support it.
    """
    if fps_file:
        body: JSON = {"fps_file": input_path(fps_file, _config(ctx), FPS_EXTENSIONS)}
    else:
        if not (machine_type and material_code and layer_thickness_mm):
            raise ValueError(
                "Provide either fps_file or all of machine_type, material_code and "
                "layer_thickness_mm."
            )
        body = {
            "machine_type": machine_type,
            "material_code": material_code,
            "layer_thickness_mm": layer_thickness_mm,
            "print_setting": print_setting,
        }
    try:
        return await _client(ctx).post("/scene/", json=body)
    except PreFormError as exc:
        if exc.code == "INPUT_ERROR" and not fps_file:
            raise PreFormError(
                exc.status,
                exc.code,
                f"{exc.message}. The combination machine_type={machine_type} "
                f"material_code={material_code} layer_thickness_mm={layer_thickness_mm} is not "
                "offered by PreForm. Call list_materials(machine_type=...) and use one of the "
                "listed scene_settings exactly.",
                body=exc.body,
            ) from exc
        raise


@mcp.tool(annotations=READ_ONLY)
async def list_scenes(ctx: Context) -> JSON:
    """List every scene PreFormServer currently holds in memory."""
    return await _client(ctx).get("/scenes/")


@mcp.tool(annotations=READ_ONLY)
async def get_scene(ctx: Context, scene_id: str = "default") -> JSON:
    """Get a scene: models (ids, bounding boxes), print settings, material usage, build volume."""
    return await _client(ctx).get(f"/scene/{scene_id}/")


@mcp.tool(annotations=MUTATING)
async def update_scene(
    ctx: Context,
    scene_id: str = "default",
    machine_type: str | None = None,
    material_code: str | None = None,
    layer_thickness_mm: float | str | None = None,
    print_setting: str | None = None,
) -> JSON:
    """Change a scene's printer, material, layer thickness or print setting, keeping its models."""
    body = _body(
        machine_type=machine_type,
        material_code=material_code,
        layer_thickness_mm=layer_thickness_mm,
        print_setting=print_setting,
    )
    if not body:
        raise ValueError("Nothing to update.")
    return await _client(ctx).put(f"/scene/{scene_id}/", json=body)


@mcp.tool(annotations=DESTRUCTIVE)
async def delete_scene(ctx: Context, scene_id: str) -> JSON:
    """Delete a scene and its models. Deleting "default" resets it to empty."""
    result = await _client(ctx).delete(f"/scene/{scene_id}/")
    return result or {"status": "deleted", "scene_id": scene_id}


@mcp.tool(annotations=MUTATING)
async def load_form(ctx: Context, file: str) -> JSON:
    """Open an existing .form file as a new scene. `file` must be absolute. Returns the scene."""
    path = input_path(file, _config(ctx), FORM_EXTENSIONS)
    return await _client(ctx).post_async_operation(
        "/load-form/", json={"file": path}, progress_callback=_progress(ctx, "loading .form")
    )


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


@mcp.tool(annotations=MUTATING)
async def import_model(
    ctx: Context,
    file: str,
    scene_id: str = "default",
    name: str | None = None,
    scale: float = 1.0,
    units: str = "MILLIMETERS",
    repair_behavior: str = "REPAIR",
    position: JSON | None = None,
    orientation: JSON | None = None,
    split_multi_model_file: bool | None = None,
) -> JSON:
    """Import a model file (STL, OBJ, 3MF, STEP) into a scene. Returns the model with its `id`.

    `file` must be an absolute path. Defaults that differ from the raw API:
    - `repair_behavior` is REPAIR (API default ERROR fails on the slightly broken
      meshes most CAD tools export). Other values: ERROR, IGNORE.
    - `units` is MILLIMETERS. Use INCHES for inch-based files, or DETECTED to let
      PreForm guess from the file.

    After the import the tool re-reads the scene and fails with
    IMPORT_PRODUCED_EMPTY_SCENE if no model was actually added. That error means
    the file is malformed; do not retry, tell the user.
    """
    client = _client(ctx)
    path = input_path(file, _config(ctx), MODEL_EXTENSIONS)
    body = _body(
        file=path,
        scale=scale,
        units=units,
        repair_behavior=repair_behavior,
        name=name,
        position=position,
        orientation=orientation,
        split_multi_model_file=split_multi_model_file,
    )

    try:
        before = await client.get(f"/scene/{scene_id}/")
        before_ids = {m.get("id") for m in (before.get("models") or [])}
    except PreFormError:
        before_ids = set()

    result = await client.post_async_operation(
        f"/scene/{scene_id}/import-model/",
        json=body,
        progress_callback=_progress(ctx, "importing model"),
    )

    after = await client.get(f"/scene/{scene_id}/")
    after_models = after.get("models") or []
    new_models = [m for m in after_models if m.get("id") not in before_ids]
    if not new_models:
        raise PreFormError(
            500,
            "IMPORT_PRODUCED_EMPTY_SCENE",
            f"PreFormServer accepted {path} but no model appeared in the scene. The file "
            "probably failed to parse. Open it in PreForm to diagnose; do not retry.",
            body={"scene_id": scene_id, "import_result": result},
        )
    if isinstance(result, dict) and result.get("id"):
        return result
    return new_models[-1] if len(new_models) == 1 else {"models": new_models}


@mcp.tool(annotations=READ_ONLY)
async def get_model(ctx: Context, model_id: str, scene_id: str = "default") -> JSON:
    """Get one model's properties: transform, bounding box, supports, lock state."""
    return await _client(ctx).get(f"/scene/{scene_id}/models/{model_id}/")


@mcp.tool(annotations=MUTATING)
async def update_model(
    ctx: Context,
    model_id: str,
    scene_id: str = "default",
    name: str | None = None,
    position: JSON | None = None,
    orientation: JSON | None = None,
    scale: float | None = None,
    lock: str | None = None,
) -> JSON:
    """Move, rotate, rescale, rename or lock a model.

    `position` is {x, y, z} in mm. `orientation` is Euler degrees {x, y, z}.
    `lock` is FREE, LOCKED_XY_ROTATION_FREE_TRANSLATION, LOCKED_ROTATION_FREE_TRANSLATION
    or FULLY_LOCKED and controls what auto_pack / auto_layout may change.
    """
    body = _body(name=name, position=position, orientation=orientation, scale=scale, lock=lock)
    if not body:
        raise ValueError("Nothing to update.")
    return await _client(ctx).post(f"/scene/{scene_id}/models/{model_id}/", json=body)


@mcp.tool(annotations=MUTATING)
async def duplicate_model(
    ctx: Context, model_id: str, count: int = 1, scene_id: str = "default"
) -> JSON:
    """Make `count` copies of a model. Returns the scene. Run auto_layout / auto_pack after."""
    return await _client(ctx).post(
        f"/scene/{scene_id}/models/{model_id}/duplicate/", json={"count": count}
    )


@mcp.tool(annotations=MUTATING)
async def replace_model(
    ctx: Context,
    model_id: str,
    file: str,
    scene_id: str = "default",
    repair_behavior: str = "REPAIR",
) -> JSON:
    """Swap a model's mesh for a new file while keeping its placement and supports.

    Useful when the user re-exports a revised part. `file` must be an absolute path.
    """
    path = input_path(file, _config(ctx), MODEL_EXTENSIONS)
    return await _client(ctx).post(
        f"/scene/{scene_id}/models/{model_id}/replace/",
        json={"file": path, "repair_behavior": repair_behavior},
    )


@mcp.tool(annotations=DESTRUCTIVE)
async def delete_model(ctx: Context, model_id: str, scene_id: str = "default") -> JSON:
    """Remove a model from the scene."""
    result = await _client(ctx).delete(f"/scene/{scene_id}/models/{model_id}/")
    return result or {"status": "deleted", "model_id": model_id}


# ---------------------------------------------------------------------------
# Preparation (long-running)
# ---------------------------------------------------------------------------


@mcp.tool(annotations=MUTATING)
async def auto_orient(
    ctx: Context,
    scene_id: str = "default",
    models: Models = "ALL",
    mode: str | None = None,
    tilt: int | None = None,
) -> JSON:
    """Rotate models to the orientation PreForm judges best for printing.

    `models` is "ALL" or a list of model ids. `mode="DENTAL"` uses the Dental
    Workspace algorithm; `tilt` (degrees) only applies in DENTAL mode.
    """
    body = _body(models=models, mode=mode, tilt=tilt)
    return await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/auto-orient/", json=body, progress_callback=_progress(ctx, "orienting")
    )


@mcp.tool(annotations=MUTATING)
async def auto_support(
    ctx: Context,
    scene_id: str = "default",
    models: Models = "ALL",
    density: float | None = None,
    slope_multiplier: float | None = None,
    only_minima: bool | None = None,
    raft_type: str | None = None,
    raft_label_enabled: bool | None = None,
    breakaway_structure_enabled: bool | None = None,
    touchpoint_size_mm: float | None = None,
    internal_supports_enabled: bool | None = None,
    raft_thickness_mm: float | None = None,
    height_above_raft_mm: float | None = None,
) -> JSON:
    """Generate support structures. Leave parameters unset to use PreForm's defaults.

    `density` and `slope_multiplier` are unitless factors around 1.0.
    `raft_type` is FULL_RAFT, MINI_RAFT or MINI_RAFTS_ON_BP.
    """
    body = _body(
        models=models,
        density=density,
        slope_multiplier=slope_multiplier,
        only_minima=only_minima,
        raft_type=raft_type,
        raft_label_enabled=raft_label_enabled,
        breakaway_structure_enabled=breakaway_structure_enabled,
        touchpoint_size_mm=touchpoint_size_mm,
        internal_supports_enabled=internal_supports_enabled,
        raft_thickness_mm=raft_thickness_mm,
        height_above_raft_mm=height_above_raft_mm,
    )
    return await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/auto-support/",
        json=body,
        progress_callback=_progress(ctx, "generating supports"),
    )


@mcp.tool(annotations=MUTATING)
async def auto_layout(
    ctx: Context,
    scene_id: str = "default",
    models: Models = "ALL",
    model_spacing_mm: float | None = None,
    placement_margin_mm: float | None = None,
    lock_rotation: bool | None = None,
    allow_overlapping_supports: bool | None = None,
    mode: str | None = None,
) -> JSON:
    """Arrange models on the build platform. SLA printers only (machine types starting with FORM-).

    For SLS printers (Fuse) use `auto_pack`. `mode="DENTAL"` uses the Dental Workspace layout.
    """
    body = _body(
        models=models,
        model_spacing_mm=model_spacing_mm,
        placement_margin_mm=placement_margin_mm,
        lock_rotation=lock_rotation,
        allow_overlapping_supports=allow_overlapping_supports,
        mode=mode,
    )
    return await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/auto-layout/", json=body, progress_callback=_progress(ctx, "laying out")
    )


@mcp.tool(annotations=MUTATING)
async def fill_build_platform(
    ctx: Context,
    scene_id: str = "default",
    models: Models = "ALL",
    model_spacing_mm: float | None = None,
    placement_margin_mm: float | None = None,
) -> JSON:
    """Duplicate the given models as many times as fit and lay the copies out. SLA only.

    Returns `new_model_ids`. For SLS printers use `fill_build_chamber`.
    """
    layout = _body(model_spacing_mm=model_spacing_mm, placement_margin_mm=placement_margin_mm)
    body = _body(models=models, layout_options=layout or None)
    return await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/fill-build-platform/",
        json=body,
        progress_callback=_progress(ctx, "filling platform"),
    )


@mcp.tool(annotations=MUTATING)
async def auto_pack(
    ctx: Context,
    scene_id: str = "default",
    model_spacing_mm: float | None = None,
    distance_from_wall_mm: float | None = None,
    packing_mode: str | None = None,
    seed: int | None = None,
) -> JSON:
    """Pack all models into the 3D build chamber. SLS printers only (machine types FS*).

    For SLA printers use `auto_layout`. `packing_mode` is PACK_HEIGHT (minimize build
    height, faster print) or PACK_VOLUME (tightest packing).
    """
    body = _body(
        model_spacing_mm=model_spacing_mm,
        distance_from_wall_mm=distance_from_wall_mm,
        packing_mode=packing_mode,
        seed=seed,
    )
    return await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/auto-pack/", json=body, progress_callback=_progress(ctx, "packing")
    )


@mcp.tool(annotations=MUTATING)
async def fill_build_chamber(
    ctx: Context,
    scene_id: str = "default",
    models: Models = "ALL",
    fill_to_height_mm: float | None = None,
    model_spacing_mm: float | None = None,
    distance_from_wall_mm: float | None = None,
) -> JSON:
    """Duplicate the given models until the SLS build chamber is full and pack them. SLS only.

    Returns `new_model_ids`. Set `fill_to_height_mm` to fill only part of the chamber.
    """
    packing = _body(model_spacing_mm=model_spacing_mm, distance_from_wall_mm=distance_from_wall_mm)
    body = _body(
        models=models, fill_to_height_mm=fill_to_height_mm, packing_options=packing or None
    )
    return await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/fill-build-chamber/",
        json=body,
        progress_callback=_progress(ctx, "filling chamber"),
    )


@mcp.tool(annotations=MUTATING)
async def pack_and_cage(
    ctx: Context,
    models: Models = "ALL",
    cage_label: str | None = None,
    packing_type: str | None = None,
    model_spacing_mm: float | None = None,
) -> JSON:
    """Pack models and build a printed cage around them so they stay together after SLS printing.

    SLS only. Acts on the most recently created scene (the API has no scene_id for
    this endpoint). `packing_type` is PACK_VOLUME (default), PACK_HEIGHT, PACK_NORMAL
    or PACK_NONE. Returns the updated scene.
    """
    body = _body(
        models=models,
        cage_label=cage_label,
        model_spacing_mm=model_spacing_mm,
        packing_type={"packing_type": packing_type} if packing_type else None,
    )
    return await _client(ctx).post("/scene/pack-and-cage/", json=body)


@mcp.tool(annotations=MUTATING)
async def hollow_model(
    ctx: Context,
    scene_id: str = "default",
    models: Models = "ALL",
    wall_thickness_mm: float | None = None,
    feature_size_mm: float | None = None,
) -> JSON:
    """Hollow models to save resin. Follow up with `auto_add_drain_holes` so resin can escape."""
    body = _body(
        models=models, wall_thickness_mm=wall_thickness_mm, feature_size_mm=feature_size_mm
    )
    return await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/hollow/", json=body, progress_callback=_progress(ctx, "hollowing")
    )


@mcp.tool(annotations=MUTATING)
async def label_model(
    ctx: Context,
    model_id: str,
    label: str,
    position: JSON,
    font_size_mm: float,
    depth_mm: float,
    scene_id: str = "default",
    orientation: JSON | None = None,
    application_mode: str = "EMBOSS",
) -> JSON:
    """Emboss or engrave text onto a model's surface.

    `position` is the label's centre {x, y, z} in scene mm. `orientation` (Euler
    degrees {x, y, z}) sets the text direction; +x runs along the text, +z is the
    surface normal. `application_mode` is EMBOSS or ENGRAVE.
    """
    body = _body(
        model_id=model_id,
        label=label,
        position=position,
        orientation=orientation or {"x": 0, "y": 0, "z": 0},
        font_size_mm=font_size_mm,
        depth_mm=depth_mm,
        application_mode=application_mode,
    )
    return await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/label/", json=body, progress_callback=_progress(ctx, "labelling")
    )


# ---------------------------------------------------------------------------
# Drain holes
# ---------------------------------------------------------------------------


@mcp.tool(annotations=MUTATING)
async def add_drain_holes(
    ctx: Context,
    model_id: str,
    drain_holes: list[JSON],
    scene_id: str = "default",
) -> JSON:
    """Add hand-placed drain holes to one model.

    Each entry in `drain_holes` needs `position` {x,y,z}, `orientation`, `diameter_mm`,
    `depth_mm` (number or "AUTO") and `create_plug`; `max_search_distance` (mm) lets
    PreForm snap the hole onto the nearest surface. Prefer `auto_add_drain_holes`
    unless the user gives coordinates.
    """
    return await _client(ctx).post(
        f"/scene/{scene_id}/add-drain-holes/",
        json={"model_id": model_id, "drain_holes": drain_holes},
    )


def _bare_id(model_id: str) -> str:
    """PreFormServer reports per-model results keyed by "{uuid}" while scene models use "uuid"."""
    return model_id.strip("{}")


def _by_model_id(per_model_results: JSON | None) -> JSON:
    return {_bare_id(k): v for k, v in (per_model_results or {}).items()}


def _sample_bottom_positions(
    min_corner: JSON, max_corner: JSON, n: int, margin_below_mm: float = 1.0
) -> list[JSON]:
    """Grid of N points just under the bottom face of a bounding box.

    Starting slightly below z_min means PreForm's upward surface search hits the
    lowest surface of the model first.
    """
    x_min, x_max = min_corner.get("x", 0.0), max_corner.get("x", 0.0)
    y_min, y_max = min_corner.get("y", 0.0), max_corner.get("y", 0.0)
    z = min_corner.get("z", 0.0) - margin_below_mm
    if n <= 1:
        return [{"x": (x_min + x_max) / 2, "y": (y_min + y_max) / 2, "z": z}]
    cols = math.ceil(math.sqrt(n))
    rows = math.ceil(n / cols)
    out: list[JSON] = []
    for r in range(rows):
        for c in range(cols):
            if len(out) >= n:
                break
            out.append(
                {
                    "x": x_min + (c + 0.5) * (x_max - x_min) / cols,
                    "y": y_min + (r + 0.5) * (y_max - y_min) / rows,
                    "z": z,
                }
            )
    return out


@mcp.tool(annotations=MUTATING)
async def auto_add_drain_holes(
    ctx: Context,
    scene_id: str = "default",
    models: Models = "ALL",
    diameter_mm: float = 1.5,
    max_holes_per_model: int = 4,
) -> JSON:
    """Place drain holes automatically on every model that cup detection flags.

    Runs `detect_cups`, then for each model with cups samples points under its
    bounding box and lets PreForm project them onto the surface (depth AUTO).
    Models without cups are skipped. If a model's result carries a "no surface
    found" warning, the cups are on a side face; offer `add_drain_holes` instead.
    """
    client = _client(ctx)
    scene = await client.get(f"/scene/{scene_id}/")
    detection = await client.get_async_operation(
        f"/scene/{scene_id}/cup-detection/", progress_callback=_progress(ctx, "detecting cups")
    )
    per_model = _by_model_id((detection or {}).get("per_model_results"))
    scene_models = {_bare_id(m["id"]): m for m in (scene.get("models") or []) if m.get("id")}

    if models == "ALL":
        target_ids = list(scene_models)
    elif isinstance(models, list):
        target_ids = list(models)
    else:
        target_ids = [models]

    results: list[JSON] = []
    for model_id in map(_bare_id, target_ids):
        cups = int((per_model.get(model_id) or {}).get("cup_count") or 0)
        if cups <= 0:
            results.append({"model_id": model_id, "status": "skipped", "reason": "no cups"})
            continue
        model = scene_models.get(model_id)
        bbox = (model or {}).get("bounding_box") or {}
        mn, mx = bbox.get("min_corner"), bbox.get("max_corner")
        if not (mn and mx):
            results.append({"model_id": model_id, "status": "skipped", "reason": "no bounding box"})
            continue

        n = min(cups, max_holes_per_model)
        height = mx.get("z", 0.0) - mn.get("z", 0.0)
        holes = [
            {
                "position": p,
                "orientation": {"z_direction": [0.0, 0.0, 1.0], "x_direction": [1.0, 0.0, 0.0]},
                "diameter_mm": diameter_mm,
                "depth_mm": "AUTO",
                "max_search_distance": max(height + 2.0, 2.0),
                "create_plug": False,
            }
            for p in _sample_bottom_positions(mn, mx, n)
        ]
        try:
            response = await client.post(
                f"/scene/{scene_id}/add-drain-holes/",
                json={"model_id": model_id, "drain_holes": holes},
            )
            results.append(
                {
                    "model_id": model_id,
                    "status": "added",
                    "cups_detected": cups,
                    "holes_requested": len(holes),
                    "warnings": (response or {}).get("warnings") or [],
                    "infos": (response or {}).get("infos") or [],
                }
            )
        except PreFormError as exc:
            results.append(
                {
                    "model_id": model_id,
                    "status": "error",
                    "cups_detected": cups,
                    "error_code": exc.code,
                    "error_message": exc.message,
                }
            )
    return {"results": results}


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------


@mcp.tool(annotations=READ_ONLY)
async def get_print_validation(ctx: Context, scene_id: str = "default") -> JSON:
    """Full printability check per model: cups, unsupported_minima, undersupported, has_seamline."""
    return await _client(ctx).get_async_operation(
        f"/scene/{scene_id}/print-validation/", progress_callback=_progress(ctx, "validating")
    )


@mcp.tool(annotations=READ_ONLY)
async def detect_cups(ctx: Context, scene_id: str = "default") -> JSON:
    """Count resin cups (trapped-resin pockets) per model. Faster than full validation."""
    return await _client(ctx).get_async_operation(
        f"/scene/{scene_id}/cup-detection/", progress_callback=_progress(ctx, "detecting cups")
    )


@mcp.tool(annotations=READ_ONLY)
async def detect_minima(ctx: Context, scene_id: str = "default") -> JSON:
    """Count unsupported local minima per model (points that would print in mid-air)."""
    return await _client(ctx).get_async_operation(
        f"/scene/{scene_id}/minima-detection/", progress_callback=_progress(ctx, "detecting minima")
    )


@mcp.tool(annotations=READ_ONLY)
async def detect_supportedness(ctx: Context, scene_id: str = "default") -> JSON:
    """Percentage of each model's surface that is unsupported (PreForm's red shading)."""
    return await _client(ctx).get_async_operation(
        f"/scene/{scene_id}/supportedness-detection/",
        progress_callback=_progress(ctx, "checking supports"),
    )


@mcp.tool(annotations=READ_ONLY)
async def detect_thin_walls(
    ctx: Context, threshold_mm: float, scene_id: str = "default", models: Models = "ALL"
) -> JSON:
    """Find wall regions thinner than `threshold_mm` per model, with volumes and bounding boxes."""
    return await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/thin-wall-detection/",
        json={"models": models, "threshold_mm": threshold_mm},
        progress_callback=_progress(ctx, "detecting thin walls"),
    )


@mcp.tool(annotations=READ_ONLY)
async def get_interferences(
    ctx: Context, scene_id: str = "default", collision_offset_mm: float | None = None
) -> JSON | list[Any]:
    """List pairs of model ids that overlap or sit closer than `collision_offset_mm`."""
    return await _client(ctx).post(
        f"/scene/{scene_id}/interferences/", json=_body(collision_offset_mm=collision_offset_mm)
    )


@mcp.tool(annotations=READ_ONLY)
async def estimate_print_time(ctx: Context, scene_id: str = "default") -> JSON:
    """Estimate print time (seconds) for the scene. Read material usage from `get_scene`."""
    return await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/estimate-print-time/",
        json={},
        progress_callback=_progress(ctx, "estimating"),
    )


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


@mcp.tool(annotations=DESTRUCTIVE)
async def save_form(ctx: Context, file: str, scene_id: str = "default") -> JSON:
    """Save the scene as a .form file at an absolute path.

    Overwrites silently, so confirm with the user first if the file already exists.
    """
    path = output_path(file, _config(ctx), FORM_EXTENSIONS)
    result = await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/save-form/",
        json={"file": path},
        progress_callback=_progress(ctx, "saving"),
    )
    return result or {"status": "saved", "file": path}


@mcp.tool(annotations=DESTRUCTIVE)
async def save_screenshot(
    ctx: Context,
    file: str,
    scene_id: str = "default",
    image_size_px: int = 1024,
    view_type: str = "ZOOM_ON_MODELS",
    yaw: float | None = None,
    pitch: float | None = None,
) -> JSON:
    """Render the scene to a .png or .webp at the given absolute path.

    `view_type` is ZOOM_ON_MODELS, FULL_BUILD_VOLUME or FULL_PLATFORM_WIDTH.
    """
    path = output_path(file, _config(ctx), IMAGE_EXTENSIONS)
    body = _body(file=path, image_size_px=image_size_px, view_type=view_type, yaw=yaw, pitch=pitch)
    result = await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/save-screenshot/",
        json=body,
        progress_callback=_progress(ctx, "rendering"),
    )
    return result or {"status": "saved", "file": path}


@mcp.tool(annotations=DESTRUCTIVE)
async def save_fps_file(ctx: Context, file: str, scene_id: str = "default") -> JSON:
    """Export the scene's print settings to a .fps file for reuse with `create_scene`."""
    path = output_path(file, _config(ctx), FPS_EXTENSIONS)
    result = await _client(ctx).post(f"/scene/{scene_id}/save-fps-file/", json={"file": path})
    return result or {"status": "saved", "file": path}


# ---------------------------------------------------------------------------
# Printers
# ---------------------------------------------------------------------------


@mcp.tool(annotations=READ_ONLY)
async def list_devices(ctx: Context, can_print: bool | None = None) -> JSON:
    """List printers PreFormServer has already discovered (run `discover_devices` to refresh).

    Includes Fleet Control queues and Dashboard printers only after `login`.
    """
    return await _client(ctx).get("/devices/", params=_body(can_print=can_print))


@mcp.tool(annotations=READ_ONLY)
async def get_device(ctx: Context, device_id: str) -> JSON:
    """Status of one printer: connection, tank and cartridge material, time remaining."""
    return await _client(ctx).get(f"/devices/{device_id}/")


@mcp.tool(annotations=READ_ONLY)
async def discover_devices(
    ctx: Context, timeout_seconds: int = 10, ip_address: str | None = None
) -> JSON:
    """Scan the local network for Formlabs printers. Pass `ip_address` to probe one host."""
    body = _body(timeout_seconds=timeout_seconds, ip_address=ip_address)
    return await _client(ctx).post_async_operation(
        "/discover-devices/", json=body, progress_callback=_progress(ctx, "discovering printers")
    )


@mcp.tool(annotations=DESTRUCTIVE)
async def print_to_printer(
    ctx: Context,
    printer: str,
    job_name: str,
    scene_id: str = "default",
    print_now: bool | None = None,
    find_printer_timeout_seconds: int = 30,
) -> JSON:
    """Upload the scene to a printer and queue or start it. Confirm with the user first.

    `printer` is a printer serial name (e.g. "Fuse-Loud-Otter"), a local IP address,
    or a Fleet Control queue id (requires `login`). `print_now=True` starts the print
    immediately if the printer is ready; otherwise the job waits in the queue.
    Returns `job_id`.
    """
    body = _body(
        printer=printer,
        job_name=job_name,
        print_now=print_now,
        find_printer_timeout_seconds=find_printer_timeout_seconds,
    )
    return await _client(ctx).post_async_operation(
        f"/scene/{scene_id}/print/", json=body, progress_callback=_progress(ctx, "uploading job")
    )


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------


@mcp.tool(annotations=READ_ONLY)
async def list_materials(ctx: Context, machine_type: str | None = None) -> JSON:
    """List printers with their materials and print settings.

    Each material setting's `scene_settings` holds the exact machine_type,
    material_code, print_setting and layer_thickness_mm to pass to `create_scene`.
    Pass `machine_type` to keep only one printer family; the list is large.
    """
    data = await _client(ctx).get("/list-materials/")
    if not machine_type:
        return data
    wanted = machine_type.upper()
    printers = [
        p
        for p in data.get("printer_types") or []
        if wanted in [m.upper() for m in (p.get("supported_machine_type_ids") or [])]
    ]
    return {"printer_types": printers}


@mcp.tool(annotations=READ_ONLY)
async def list_printer_types(ctx: Context) -> list[JSON]:
    """Short list of printer families with their machine_type codes and build volumes.

    Use this to map a printer name the user says ("Form 4", "Fuse 1+") to a
    machine_type before calling `create_scene`. Codes starting with FORM- are SLA
    (use auto_layout); codes starting with FS are SLS (use auto_pack).
    """
    data = await _client(ctx).get("/list-materials/")
    out: list[JSON] = []
    for p in data.get("printer_types") or []:
        out.append(
            {
                "label": p.get("label"),
                "machine_types": p.get("supported_machine_type_ids") or [],
                "product_names": p.get("supported_product_names") or [],
                "build_volume_dimensions_mm": p.get("build_volume_dimensions_mm"),
                "material_count": len(p.get("materials") or []),
            }
        )
    return out


# ---------------------------------------------------------------------------
# Formlabs account
# ---------------------------------------------------------------------------


@mcp.tool(annotations=MUTATING)
async def login(ctx: Context) -> JSON:
    """Log in to Formlabs Web Services for remote printing, Fleet Control and Dashboard printers.

    Credentials are never passed through the conversation. Set FORMLABS_USERNAME and
    FORMLABS_PASSWORD (or FORMLABS_ACCESS_TOKEN) in the MCP server's environment and
    call this tool with no arguments.
    """
    cfg = _config(ctx)
    if not cfg.is_loopback and not cfg.allow_remote_login:
        raise ValueError(
            f"Refusing to send credentials to a non-local PreFormServer ({cfg.base_url}) over "
            "plain HTTP. Set FORMLABS_ALLOW_REMOTE_LOGIN=1 only on a trusted network."
        )
    if cfg.web_access_token:
        body: JSON = {"access_token": cfg.web_access_token}
    elif cfg.web_username and cfg.web_password:
        body = {"username": cfg.web_username, "password": cfg.web_password}
    else:
        raise ValueError(
            "No Formlabs credentials configured. Set FORMLABS_USERNAME and FORMLABS_PASSWORD "
            "(or FORMLABS_ACCESS_TOKEN) in the MCP server environment, then retry. "
            "Do not ask the user to paste a password into the chat."
        )
    await _client(ctx).post("/login/", json=body)
    # Deliberately drop the returned tokens; the model has no use for them.
    user = await _client(ctx).get("/user/")
    return {"status": "logged_in", "username": user.get("username"), "email": user.get("email")}


@mcp.tool(annotations=MUTATING)
async def logout(ctx: Context) -> JSON:
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
        stream=sys.stderr,
    )
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
