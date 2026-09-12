"""Runtime configuration.

Everything is driven by environment variables so the server works with zero
configuration in the common case (PreFormServer installed in the default
location, talking over loopback) and can be tuned without code changes.
"""

from __future__ import annotations

import ipaddress
import os
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_PORT = 44388

# Where the Formlabs zip lands when a user unpacks it and drags it to the usual
# places. Checked in order; the first existing file wins.
_MAC_CANDIDATES = [
    "/Applications/PreFormServer.app/Contents/MacOS/PreFormServer",
    "/Applications/PreFormServer/PreFormServer.app/Contents/MacOS/PreFormServer",
    "~/Applications/PreFormServer.app/Contents/MacOS/PreFormServer",
    "~/Applications/PreFormServer/PreFormServer.app/Contents/MacOS/PreFormServer",
]
_WINDOWS_CANDIDATES = [
    r"%ProgramFiles%\Formlabs\PreFormServer\PreFormServer.exe",
    r"%ProgramFiles%\PreFormServer\PreFormServer.exe",
    r"%LOCALAPPDATA%\Formlabs\PreFormServer\PreFormServer.exe",
    r"%LOCALAPPDATA%\PreFormServer\PreFormServer.exe",
]
_LINUX_CANDIDATES = [
    "/opt/PreFormServer/PreFormServer",
    "~/PreFormServer/PreFormServer",
]


def find_preform_server() -> Path | None:
    """Locate the PreFormServer executable without any configuration."""
    if sys.platform == "darwin":
        candidates = _MAC_CANDIDATES
    elif sys.platform.startswith("win"):
        candidates = _WINDOWS_CANDIDATES
    else:
        candidates = _LINUX_CANDIDATES
    for raw in candidates:
        p = Path(os.path.expandvars(os.path.expanduser(raw)))
        if p.is_file():
            return p
    found = shutil.which("PreFormServer")
    return Path(found) if found else None


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off")


@dataclass(frozen=True)
class Config:
    base_url: str
    preform_server_path: Path | None
    preform_server_port: int
    spawn_preform_server: bool
    poll_interval_seconds: float
    poll_timeout_seconds: float
    startup_timeout_seconds: float
    telemetry_enabled: bool
    allowed_paths: tuple[Path, ...]
    allow_hidden_paths: bool
    allow_remote_login: bool
    web_username: str | None = field(default=None, repr=False)
    web_password: str | None = field(default=None, repr=False)
    web_access_token: str | None = field(default=None, repr=False)

    @property
    def is_loopback(self) -> bool:
        """True when base_url points at this machine.

        `login` refuses to send credentials anywhere else, because the
        PreFormServer API is plain HTTP.
        """
        host = (urlparse(self.base_url).hostname or "").lower()
        if host in ("", "localhost"):
            return True
        try:
            return ipaddress.ip_address(host).is_loopback
        except ValueError:
            return False

    @classmethod
    def from_env(cls) -> Config:
        port = int(os.environ.get("PREFORM_SERVER_PORT", str(DEFAULT_PORT)))
        base_url = os.environ.get("PREFORM_SERVER_URL") or f"http://127.0.0.1:{port}"

        explicit = os.environ.get("PREFORM_SERVER_PATH")
        path: Path | None
        if explicit:
            path = Path(os.path.expanduser(explicit))
        else:
            path = find_preform_server()

        # Spawn only when we're talking to a local server and have a binary.
        # If the user pointed us at a remote URL there is nothing to spawn.
        remote = bool(os.environ.get("PREFORM_SERVER_URL"))
        spawn = _env_bool("PREFORM_SPAWN", True) and path is not None and not remote

        raw_allowed = os.environ.get("FORMLABS_ALLOWED_PATHS", "")
        if raw_allowed.strip():
            allowed = tuple(
                Path(os.path.expanduser(p.strip())).resolve()
                for p in raw_allowed.split(os.pathsep)
                if p.strip()
            )
        else:
            allowed = (Path.home().resolve(),)

        return cls(
            base_url=base_url.rstrip("/"),
            preform_server_path=path,
            preform_server_port=port,
            spawn_preform_server=spawn,
            poll_interval_seconds=float(os.environ.get("PREFORM_POLL_INTERVAL", "1.0")),
            poll_timeout_seconds=float(os.environ.get("PREFORM_POLL_TIMEOUT", "600")),
            startup_timeout_seconds=float(os.environ.get("PREFORM_STARTUP_TIMEOUT", "120")),
            telemetry_enabled=_env_bool("PREFORM_TELEMETRY", False),
            allowed_paths=allowed,
            allow_hidden_paths=_env_bool("FORMLABS_ALLOW_HIDDEN_PATHS", False),
            allow_remote_login=_env_bool("FORMLABS_ALLOW_REMOTE_LOGIN", False),
            web_username=os.environ.get("FORMLABS_USERNAME") or None,
            web_password=os.environ.get("FORMLABS_PASSWORD") or None,
            web_access_token=os.environ.get("FORMLABS_ACCESS_TOKEN") or None,
        )
