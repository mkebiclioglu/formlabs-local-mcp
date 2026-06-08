"""Runtime configuration loaded from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    base_url: str
    preform_server_path: str | None
    preform_server_port: int
    spawn_preform_server: bool
    poll_interval_seconds: float
    poll_timeout_seconds: float

    @classmethod
    def from_env(cls) -> "Config":
        port = int(os.environ.get("PREFORM_SERVER_PORT", "44388"))
        base_url = os.environ.get("PREFORM_SERVER_URL", f"http://localhost:{port}")
        path = os.environ.get("PREFORM_SERVER_PATH") or None
        spawn = path is not None and os.environ.get("PREFORM_SPAWN", "1") != "0"
        return cls(
            base_url=base_url.rstrip("/"),
            preform_server_path=path,
            preform_server_port=port,
            spawn_preform_server=spawn,
            poll_interval_seconds=float(os.environ.get("PREFORM_POLL_INTERVAL", "2.0")),
            poll_timeout_seconds=float(os.environ.get("PREFORM_POLL_TIMEOUT", "600")),
        )
