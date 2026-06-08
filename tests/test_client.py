"""Sanity tests for the PreFormClient: request shape, error translation, async polling."""

from __future__ import annotations

import asyncio

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


@respx.mock
async def test_health_check_returns_json() -> None:
    respx.get("http://localhost:44388/").mock(
        return_value=httpx.Response(200, json={"version": "0.9.22"})
    )
    client = PreFormClient(_config())
    try:
        result = await client.get("/")
        assert result == {"version": "0.9.22"}
    finally:
        await client.close()


@respx.mock
async def test_error_response_translates_to_preform_error() -> None:
    respx.post("http://localhost:44388/scene/").mock(
        return_value=httpx.Response(
            400,
            json={"error": {"code": "INVALID_MATERIAL", "message": "Unknown material"}},
        )
    )
    client = PreFormClient(_config())
    try:
        with pytest.raises(PreFormError) as exc:
            await client.post("/scene/", json={"material_code": "BOGUS"})
        assert exc.value.status == 400
        assert exc.value.code == "INVALID_MATERIAL"
        assert "Unknown material" in str(exc.value)
    finally:
        await client.close()


@respx.mock
async def test_async_operation_polls_until_succeeded() -> None:
    respx.post("http://localhost:44388/scene/default/auto-orient/").mock(
        return_value=httpx.Response(202, json={"id": "op-123"})
    )
    # First poll: in progress. Second poll: done.
    respx.get("http://localhost:44388/operations/op-123/").mock(
        side_effect=[
            httpx.Response(200, json={"id": "op-123", "status": "IN_PROGRESS", "progress": 0.5}),
            httpx.Response(
                200,
                json={
                    "id": "op-123",
                    "status": "SUCCEEDED",
                    "progress": 1.0,
                    "result": {"models_oriented": 3},
                },
            ),
        ]
    )

    progress_seen: list[float] = []

    async def track(p: float) -> None:
        progress_seen.append(p)

    client = PreFormClient(_config())
    try:
        result = await client.post_async_operation(
            "/scene/default/auto-orient/",
            json={"models": "ALL"},
            progress_callback=track,
        )
        assert result == {"models_oriented": 3}
        assert progress_seen == [0.5, 1.0]
    finally:
        await client.close()


@respx.mock
async def test_async_operation_failed_raises() -> None:
    respx.post("http://localhost:44388/scene/default/auto-support/").mock(
        return_value=httpx.Response(202, json={"id": "op-fail"})
    )
    respx.get("http://localhost:44388/operations/op-fail/").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": "op-fail",
                "status": "FAILED",
                "progress": 0.0,
                "result": {"error": {"code": "SUPPORT_GEN_FAILED", "message": "Bad mesh"}},
            },
        )
    )
    client = PreFormClient(_config())
    try:
        with pytest.raises(PreFormError) as exc:
            await client.post_async_operation("/scene/default/auto-support/", json={"models": "ALL"})
        assert exc.value.code == "SUPPORT_GEN_FAILED"
        assert "Bad mesh" in str(exc.value)
    finally:
        await client.close()


@respx.mock
async def test_async_operation_times_out() -> None:
    respx.post("http://localhost:44388/scene/default/auto-support/").mock(
        return_value=httpx.Response(202, json={"id": "op-slow"})
    )
    respx.get("http://localhost:44388/operations/op-slow/").mock(
        return_value=httpx.Response(
            200, json={"id": "op-slow", "status": "IN_PROGRESS", "progress": 0.1}
        )
    )
    client = PreFormClient(_config())
    try:
        with pytest.raises(PreFormError) as exc:
            await client.post_async_operation("/scene/default/auto-support/", json={})
        assert exc.value.code == "OPERATION_TIMEOUT"
    finally:
        await client.close()
