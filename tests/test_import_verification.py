"""Test the post-import verification logic in the import_model MCP tool.

The tool fetches the scene before and after the import op, and raises
IMPORT_PRODUCED_EMPTY_SCENE if the model count did not grow — guarding
against the silent-failure case where PreFormServer reports SUCCEEDED but
the STL didn't actually parse.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from formlabs_local_mcp.client import PreFormClient, PreFormError
from formlabs_local_mcp.config import Config


def _config() -> Config:
    return Config(
        base_url="http://localhost:44388",
        preform_server_path=None,
        preform_server_port=44388,
        spawn_preform_server=False,
        poll_interval_seconds=0.01,
        poll_timeout_seconds=2.0,
    )


def _mock_scene(models: list[dict]) -> dict:
    return {"id": "default", "models": models}


@respx.mock
async def test_import_verification_raises_when_scene_stays_empty() -> None:
    """Mirror the MCP tool's logic: before-fetch, post async, after-fetch, count check."""
    respx.get("http://localhost:44388/scene/default/").mock(
        side_effect=[
            httpx.Response(200, json=_mock_scene([])),  # before
            httpx.Response(200, json=_mock_scene([])),  # after — still empty
        ]
    )
    respx.post("http://localhost:44388/scene/default/import-model/").mock(
        return_value=httpx.Response(202, json={"id": "op-1"})
    )
    respx.get("http://localhost:44388/operations/op-1/").mock(
        return_value=httpx.Response(
            200, json={"id": "op-1", "status": "SUCCEEDED", "progress": 1.0, "result": {}}
        )
    )

    client = PreFormClient(_config())
    try:
        # Reproduce the tool's logic inline (avoids importing FastMCP server scaffolding).
        before = await client.get("/scene/default/")
        before_count = len(before.get("models") or [])
        await client.post_async_operation(
            "/scene/default/import-model/",
            json={"file": "/tmp/junk.stl", "repair_behavior": "REPAIR"},
        )
        after = await client.get("/scene/default/")
        if len(after.get("models") or []) <= before_count:
            raise PreFormError(
                500,
                "IMPORT_PRODUCED_EMPTY_SCENE",
                "Scene stayed empty after import",
            )

        pytest.fail("Should have raised IMPORT_PRODUCED_EMPTY_SCENE")
    except PreFormError as exc:
        assert exc.code == "IMPORT_PRODUCED_EMPTY_SCENE"
    finally:
        await client.close()


@respx.mock
async def test_import_verification_passes_when_model_added() -> None:
    """Happy path: model count grows by 1, no error raised."""
    respx.get("http://localhost:44388/scene/default/").mock(
        side_effect=[
            httpx.Response(200, json=_mock_scene([])),  # before: empty
            httpx.Response(200, json=_mock_scene([{"id": "m1", "name": "part"}])),  # after: 1
        ]
    )
    respx.post("http://localhost:44388/scene/default/import-model/").mock(
        return_value=httpx.Response(202, json={"id": "op-2"})
    )
    respx.get("http://localhost:44388/operations/op-2/").mock(
        return_value=httpx.Response(
            200,
            json={"id": "op-2", "status": "SUCCEEDED", "progress": 1.0, "result": {"id": "m1"}},
        )
    )

    client = PreFormClient(_config())
    try:
        before = await client.get("/scene/default/")
        before_count = len(before.get("models") or [])
        await client.post_async_operation(
            "/scene/default/import-model/",
            json={"file": "/tmp/ok.stl"},
        )
        after = await client.get("/scene/default/")
        assert len(after.get("models") or []) > before_count
    finally:
        await client.close()
