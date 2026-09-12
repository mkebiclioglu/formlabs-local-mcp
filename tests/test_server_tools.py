"""The MCP tool surface: registration, annotations, and path guards in tools."""

from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace

import httpx
import pytest
import respx

from formlabs_local_mcp import server
from formlabs_local_mcp.client import PreFormClient, PreFormError
from formlabs_local_mcp.paths import PathNotAllowed
from tests.conftest import make_config

BASE = "http://127.0.0.1:44388"


@dataclass
class FakeContext:
    """Just enough of mcp's Context for the tool functions."""

    request_context: SimpleNamespace

    async def report_progress(self, **_: object) -> None:
        pass


def fake_ctx(config, client) -> FakeContext:
    app = server.AppContext(client=client, preform=None, config=config)  # type: ignore[arg-type]
    return FakeContext(request_context=SimpleNamespace(lifespan_context=app))


async def test_tools_are_registered() -> None:
    tools = await server.mcp.list_tools()
    names = {t.name for t in tools}
    expected = {
        "health_check",
        "create_scene",
        "import_model",
        "auto_orient",
        "auto_support",
        "auto_layout",
        "auto_pack",
        "fill_build_platform",
        "fill_build_chamber",
        "pack_and_cage",
        "detect_cups",
        "detect_thin_walls",
        "auto_add_drain_holes",
        "estimate_print_time",
        "save_form",
        "save_screenshot",
        "print_to_printer",
        "list_printer_types",
        "login",
    }
    assert expected <= names
    by_name = {t.name: t for t in tools}
    assert by_name["print_to_printer"].annotations.destructive_hint is True
    assert by_name["health_check"].annotations.read_only_hint is True
    # Credentials must never be tool parameters.
    assert by_name["login"].input_schema.get("properties", {}) == {}


async def test_import_model_rejects_paths_outside_allowlist(tmp_path) -> None:
    cfg = make_config(allowed_paths=(tmp_path.resolve(),))
    client = PreFormClient(cfg)
    try:
        with pytest.raises(PathNotAllowed):
            await server.import_model(fake_ctx(cfg, client), file="/etc/passwd.stl")
    finally:
        await client.close()


@respx.mock
async def test_import_model_fails_when_scene_stays_empty(tmp_path) -> None:
    cfg = make_config(allowed_paths=(tmp_path.resolve(),))
    stl = tmp_path / "part.stl"
    stl.write_text("")
    respx.get(f"{BASE}/scene/default/").mock(
        return_value=httpx.Response(200, json={"id": "default", "models": []})
    )
    respx.post(f"{BASE}/scene/default/import-model/").mock(
        return_value=httpx.Response(202, json={"operationId": "op-1"})
    )
    respx.get(f"{BASE}/operations/op-1/").mock(
        return_value=httpx.Response(200, json={"status": "SUCCEEDED", "progress": 1, "result": {}})
    )
    client = PreFormClient(cfg)
    try:
        with pytest.raises(PreFormError) as exc:
            await server.import_model(fake_ctx(cfg, client), file=str(stl))
        assert exc.value.code == "IMPORT_PRODUCED_EMPTY_SCENE"
    finally:
        await client.close()


@respx.mock
async def test_import_model_returns_new_model(tmp_path) -> None:
    cfg = make_config(allowed_paths=(tmp_path.resolve(),))
    stl = tmp_path / "part.stl"
    stl.write_text("")
    respx.get(f"{BASE}/scene/default/").mock(
        side_effect=[
            httpx.Response(200, json={"id": "default", "models": []}),
            httpx.Response(200, json={"id": "default", "models": [{"id": "m1"}]}),
        ]
    )
    import_route = respx.post(f"{BASE}/scene/default/import-model/").mock(
        return_value=httpx.Response(202, json={"operationId": "op-2"})
    )
    respx.get(f"{BASE}/operations/op-2/").mock(
        return_value=httpx.Response(
            200, json={"status": "SUCCEEDED", "progress": 1, "result": {"id": "m1"}}
        )
    )
    client = PreFormClient(cfg)
    try:
        result = await server.import_model(fake_ctx(cfg, client), file=str(stl))
        assert result == {"id": "m1"}
        sent = import_route.calls[0].request.content
        assert b'"repair_behavior":"REPAIR"' in sent.replace(b" ", b"")
        assert b'"units":"MILLIMETERS"' in sent.replace(b" ", b"")
    finally:
        await client.close()


@respx.mock
async def test_auto_add_drain_holes_uses_cup_detection(tmp_path) -> None:
    cfg = make_config(allowed_paths=(tmp_path.resolve(),))
    respx.get(f"{BASE}/scene/default/").mock(
        return_value=httpx.Response(
            200,
            json={
                "models": [
                    {
                        "id": "m1",
                        "bounding_box": {
                            "min_corner": {"x": -5, "y": -5, "z": 0},
                            "max_corner": {"x": 5, "y": 5, "z": 10},
                        },
                    },
                    {"id": "m2", "bounding_box": {}},
                ]
            },
        )
    )
    respx.get(f"{BASE}/scene/default/cup-detection/").mock(
        return_value=httpx.Response(
            200, json={"per_model_results": {"{m1}": {"cup_count": 2}, "{m2}": {"cup_count": 0}}}
        )
    )
    holes_route = respx.post(f"{BASE}/scene/default/add-drain-holes/").mock(
        return_value=httpx.Response(200, json={"warnings": [], "infos": []})
    )
    client = PreFormClient(cfg)
    try:
        out = await server.auto_add_drain_holes(fake_ctx(cfg, client))
        assert out["results"][0]["status"] == "added"
        assert out["results"][0]["holes_requested"] == 2
        assert out["results"][1]["status"] == "skipped"
        assert holes_route.call_count == 1
    finally:
        await client.close()


async def test_login_refuses_without_env_credentials() -> None:
    cfg = make_config()
    client = PreFormClient(cfg)
    try:
        with pytest.raises(ValueError, match="No Formlabs credentials"):
            await server.login(fake_ctx(cfg, client))
    finally:
        await client.close()


async def test_login_refuses_remote_plaintext() -> None:
    cfg = make_config(base_url="http://10.0.0.9:44388", web_username="u", web_password="p")
    client = PreFormClient(cfg)
    try:
        with pytest.raises(ValueError, match="non-local"):
            await server.login(fake_ctx(cfg, client))
    finally:
        await client.close()


@respx.mock
async def test_login_uses_env_credentials_and_hides_tokens() -> None:
    cfg = make_config(web_username="me@example.com", web_password="hunter2")
    login_route = respx.post(f"{BASE}/login/").mock(
        return_value=httpx.Response(200, json={"access_token": "secret", "refresh_token": "s2"})
    )
    respx.get(f"{BASE}/user/").mock(
        return_value=httpx.Response(200, json={"username": "me", "email": "me@example.com"})
    )
    client = PreFormClient(cfg)
    try:
        out = await server.login(fake_ctx(cfg, client))
        assert out == {"status": "logged_in", "username": "me", "email": "me@example.com"}
        assert b"hunter2" in login_route.calls[0].request.content
    finally:
        await client.close()


@respx.mock
async def test_save_form_validates_extension_and_uses_async(tmp_path) -> None:
    cfg = make_config(allowed_paths=(tmp_path.resolve(),))
    route = respx.post(f"{BASE}/scene/default/save-form/").mock(
        return_value=httpx.Response(202, json={"operationId": "op-s"})
    )
    respx.get(f"{BASE}/operations/op-s/").mock(
        return_value=httpx.Response(
            200, json={"status": "SUCCEEDED", "progress": 1, "result": None}
        )
    )
    client = PreFormClient(cfg)
    try:
        with pytest.raises(PathNotAllowed):
            await server.save_form(fake_ctx(cfg, client), file=str(tmp_path / "job.sh"))
        out = await server.save_form(fake_ctx(cfg, client), file=str(tmp_path / "job.form"))
        assert out["status"] == "saved"
        assert route.call_count == 1
    finally:
        await client.close()
