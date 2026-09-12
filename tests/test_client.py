"""PreFormClient: request shape, error translation, async polling."""

from __future__ import annotations

import httpx
import pytest
import respx

from formlabs_local_mcp.client import PreFormClient, PreFormError

BASE = "http://127.0.0.1:44388"


@respx.mock
async def test_get_returns_json(config) -> None:
    respx.get(f"{BASE}/").mock(return_value=httpx.Response(200, json={"version": "3.62.1"}))
    client = PreFormClient(config)
    try:
        assert await client.get("/") == {"version": "3.62.1"}
    finally:
        await client.close()


@respx.mock
async def test_error_response_translates_to_preform_error(config) -> None:
    respx.post(f"{BASE}/scene/").mock(
        return_value=httpx.Response(
            400, json={"error": {"code": "INVALID_MATERIAL", "message": "Unknown material"}}
        )
    )
    client = PreFormClient(config)
    try:
        with pytest.raises(PreFormError) as exc:
            await client.post("/scene/", json={"material_code": "BOGUS"})
        assert exc.value.status == 400
        assert exc.value.code == "INVALID_MATERIAL"
        assert "Unknown material" in str(exc.value)
    finally:
        await client.close()


@respx.mock
async def test_async_operation_polls_until_succeeded(config) -> None:
    route = respx.post(f"{BASE}/scene/default/auto-orient/").mock(
        return_value=httpx.Response(202, json={"operationId": "op-123"})
    )
    respx.get(f"{BASE}/operations/op-123/").mock(
        side_effect=[
            httpx.Response(200, json={"id": "op-123", "status": "IN_PROGRESS", "progress": 0.5}),
            httpx.Response(
                200,
                json={"id": "op-123", "status": "SUCCEEDED", "progress": 1.0, "result": {"n": 3}},
            ),
        ]
    )
    seen: list[float] = []

    async def track(p: float) -> None:
        seen.append(p)

    client = PreFormClient(config)
    try:
        result = await client.post_async_operation(
            "/scene/default/auto-orient/", json={"models": "ALL"}, progress_callback=track
        )
        assert result == {"n": 3}
        assert seen == [0.5, 1.0]
        assert route.calls[0].request.url.params["async"] == "true"
    finally:
        await client.close()


@respx.mock
async def test_get_async_operation(config) -> None:
    respx.get(f"{BASE}/scene/default/cup-detection/").mock(
        return_value=httpx.Response(202, json={"operationId": "op-cups"})
    )
    respx.get(f"{BASE}/operations/op-cups/").mock(
        return_value=httpx.Response(
            200,
            json={
                "status": "SUCCEEDED",
                "progress": 1.0,
                "result": {"per_model_results": {"m1": {"cup_count": 2}}},
            },
        )
    )
    client = PreFormClient(config)
    try:
        result = await client.get_async_operation("/scene/default/cup-detection/")
        assert result["per_model_results"]["m1"]["cup_count"] == 2
    finally:
        await client.close()


@respx.mock
async def test_async_operation_failed_raises(config) -> None:
    respx.post(f"{BASE}/scene/default/auto-support/").mock(
        return_value=httpx.Response(202, json={"operationId": "op-fail"})
    )
    respx.get(f"{BASE}/operations/op-fail/").mock(
        return_value=httpx.Response(
            200,
            json={
                "status": "FAILED",
                "progress": 0.0,
                "result": {"error": {"code": "SUPPORT_GEN_FAILED", "message": "Bad mesh"}},
            },
        )
    )
    client = PreFormClient(config)
    try:
        with pytest.raises(PreFormError) as exc:
            await client.post_async_operation("/scene/default/auto-support/", json={})
        assert exc.value.code == "SUPPORT_GEN_FAILED"
        assert "Bad mesh" in str(exc.value)
    finally:
        await client.close()


@respx.mock
async def test_async_operation_handles_inline_result(config) -> None:
    respx.post(f"{BASE}/scene/default/auto-orient/").mock(
        return_value=httpx.Response(200, json={"oriented": 1})
    )
    client = PreFormClient(config)
    try:
        assert await client.post_async_operation("/scene/default/auto-orient/", json={}) == {
            "oriented": 1
        }
    finally:
        await client.close()


@respx.mock
async def test_async_operation_times_out(config) -> None:
    respx.post(f"{BASE}/scene/default/auto-support/").mock(
        return_value=httpx.Response(202, json={"operationId": "op-slow"})
    )
    respx.get(f"{BASE}/operations/op-slow/").mock(
        return_value=httpx.Response(200, json={"status": "IN_PROGRESS", "progress": 0.1})
    )
    client = PreFormClient(config)
    try:
        with pytest.raises(PreFormError) as exc:
            await client.post_async_operation("/scene/default/auto-support/", json={})
        assert exc.value.code == "OPERATION_TIMEOUT"
    finally:
        await client.close()
