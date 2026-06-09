"""Runtime configuration loaded from environment variables."""

from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass
from urllib.parse import urlparse


@dataclass(frozen=True)
class Config:
    base_url: str
    preform_server_path: str | None
    preform_server_port: int
    spawn_preform_server: bool
    poll_interval_seconds: float
    poll_timeout_seconds: float

    @property
    def is_loopback(self) -> bool:
        """True iff `base_url` points at the loopback interface.

        Used by `login` to refuse sending credentials over plaintext HTTP to a
        remote host. `localhost` is treated as loopback even though name
        resolution could in theory disagree — the host the user typed is what
        matters here.
        """
        host = (urlparse(self.base_url).hostname or "").lower()
        if host in ("", "localhost"):
            return True
        try:
            return ipaddress.ip_address(host).is_loopback
        except ValueError:
            return False

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
