"""Config.from_env, PreFormServer discovery and loopback detection."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from formlabs_local_mcp import config as config_mod
from formlabs_local_mcp.config import Config
from tests.conftest import make_config


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for var in (
        "PREFORM_SERVER_PATH",
        "PREFORM_SERVER_URL",
        "PREFORM_SERVER_PORT",
        "PREFORM_SPAWN",
        "PREFORM_TELEMETRY",
        "FORMLABS_ALLOWED_PATHS",
        "FORMLABS_ALLOW_HIDDEN_PATHS",
        "FORMLABS_ALLOW_REMOTE_LOGIN",
        "FORMLABS_USERNAME",
        "FORMLABS_PASSWORD",
        "FORMLABS_ACCESS_TOKEN",
    ):
        monkeypatch.delenv(var, raising=False)


def test_defaults(monkeypatch) -> None:
    monkeypatch.setattr(config_mod, "find_preform_server", lambda: None)
    cfg = Config.from_env()
    assert cfg.base_url == "http://127.0.0.1:44388"
    assert cfg.preform_server_path is None
    assert cfg.spawn_preform_server is False
    assert cfg.allowed_paths == (Path.home().resolve(),)
    assert cfg.telemetry_enabled is False
    assert cfg.is_loopback


def test_auto_detected_binary_enables_spawn(monkeypatch, tmp_path) -> None:
    exe = tmp_path / "PreFormServer"
    exe.write_text("")
    monkeypatch.setattr(config_mod, "find_preform_server", lambda: exe)
    cfg = Config.from_env()
    assert cfg.preform_server_path == exe
    assert cfg.spawn_preform_server is True


def test_explicit_path_wins(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(config_mod, "find_preform_server", lambda: tmp_path / "wrong")
    monkeypatch.setenv("PREFORM_SERVER_PATH", str(tmp_path / "right"))
    assert Config.from_env().preform_server_path == tmp_path / "right"


def test_spawn_can_be_disabled(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(config_mod, "find_preform_server", lambda: tmp_path / "x")
    monkeypatch.setenv("PREFORM_SPAWN", "0")
    assert Config.from_env().spawn_preform_server is False


def test_remote_url_disables_spawn(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(config_mod, "find_preform_server", lambda: tmp_path / "x")
    monkeypatch.setenv("PREFORM_SERVER_URL", "http://10.0.0.5:44388/")
    cfg = Config.from_env()
    assert cfg.spawn_preform_server is False
    assert cfg.base_url == "http://10.0.0.5:44388"
    assert not cfg.is_loopback


def test_allowed_paths_from_env(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(config_mod, "find_preform_server", lambda: None)
    a, b = tmp_path / "a", tmp_path / "b"
    monkeypatch.setenv("FORMLABS_ALLOWED_PATHS", os.pathsep.join([str(a), str(b)]))
    assert Config.from_env().allowed_paths == (a.resolve(), b.resolve())


def test_credentials_not_in_repr(monkeypatch) -> None:
    monkeypatch.setattr(config_mod, "find_preform_server", lambda: None)
    monkeypatch.setenv("FORMLABS_USERNAME", "me@example.com")
    monkeypatch.setenv("FORMLABS_PASSWORD", "hunter2")
    cfg = Config.from_env()
    assert cfg.web_password == "hunter2"
    assert "hunter2" not in repr(cfg)


@pytest.mark.parametrize(
    "url,expected",
    [
        ("http://localhost:44388", True),
        ("http://127.0.0.1:44388", True),
        ("http://[::1]:44388", True),
        ("http://127.5.5.5", True),
        ("http://192.168.1.20:44388", False),
        ("http://preform.example.com", False),
    ],
)
def test_is_loopback(url: str, expected: bool) -> None:
    assert make_config(base_url=url).is_loopback is expected


def test_find_preform_server_checks_candidates(monkeypatch, tmp_path) -> None:
    exe = tmp_path / "PreFormServer.app" / "Contents" / "MacOS" / "PreFormServer"
    exe.parent.mkdir(parents=True)
    exe.write_text("")
    monkeypatch.setattr(config_mod.sys, "platform", "darwin")
    monkeypatch.setattr(config_mod, "_MAC_CANDIDATES", [str(exe)])
    assert config_mod.find_preform_server() == exe
