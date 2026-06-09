"""Tests for Config.is_loopback (gate for credential-sending tools)."""

from __future__ import annotations

import pytest

from formlabs_local_mcp.config import Config


def _cfg(base_url: str) -> Config:
    return Config(
        base_url=base_url,
        preform_server_path=None,
        preform_server_port=44388,
        spawn_preform_server=False,
        poll_interval_seconds=0.01,
        poll_timeout_seconds=2.0,
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:44388",
        "http://127.0.0.1:44388",
        "http://[::1]:44388",
        "https://localhost",
        "http://127.5.5.5",  # 127.0.0.0/8 is loopback
    ],
)
def test_loopback_urls(url: str) -> None:
    assert _cfg(url).is_loopback is True


@pytest.mark.parametrize(
    "url",
    [
        "http://192.168.1.50:44388",
        "http://10.0.0.5",
        "http://example.com",
        "https://printserver.lan",
        "http://[2001:db8::1]",
    ],
)
def test_non_loopback_urls(url: str) -> None:
    assert _cfg(url).is_loopback is False
