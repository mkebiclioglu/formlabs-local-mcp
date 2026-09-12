from __future__ import annotations

from pathlib import Path

import pytest

from formlabs_local_mcp.config import Config


def make_config(**overrides) -> Config:
    base = dict(
        base_url="http://127.0.0.1:44388",
        preform_server_path=None,
        preform_server_port=44388,
        spawn_preform_server=False,
        poll_interval_seconds=0.01,
        poll_timeout_seconds=2.0,
        startup_timeout_seconds=1.0,
        telemetry_enabled=False,
        allowed_paths=(Path.home().resolve(),),
        allow_hidden_paths=False,
        allow_remote_login=False,
    )
    base.update(overrides)
    return Config(**base)


@pytest.fixture
def config() -> Config:
    return make_config()
