"""PreFormServer subprocess lifecycle.

When a PreFormServer binary is available locally we start it ourselves, wait
for its `READY FOR INPUT` line, and stop it when the MCP server exits. That
way PreFormServer's unauthenticated HTTP port is only open while an MCP
client is actually connected.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal
import sys
import time

import httpx

from formlabs_local_mcp.config import Config

log = logging.getLogger(__name__)

READY_TOKEN = "READY FOR INPUT"
DOWNLOAD_URL = "https://formlabs.com/support/Formlabs-API-downloads-and-release-notes"


class PreFormServerProcess:
    def __init__(self, config: Config):
        self._config = config
        self._proc: asyncio.subprocess.Process | None = None
        self._stdout_task: asyncio.Task[None] | None = None
        self._ready = asyncio.Event()

    async def ensure_running(self) -> None:
        """Spawn PreFormServer if configured to, then verify it answers HTTP."""
        cfg = self._config
        if cfg.spawn_preform_server and cfg.preform_server_path:
            if await self._already_reachable():
                log.info("PreFormServer already answering at %s; not spawning", cfg.base_url)
            else:
                await self._spawn()
        await self._wait_until_reachable()

    async def _already_reachable(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.get(f"{self._config.base_url}/")
                return resp.status_code < 500
        except httpx.HTTPError:
            return False

    async def _spawn(self) -> None:
        cfg = self._config
        path = cfg.preform_server_path
        assert path is not None
        if not path.is_file():
            raise FileNotFoundError(
                f"PreFormServer not found at {path}. Download it from {DOWNLOAD_URL} "
                "and either put PreFormServer.app in /Applications or set "
                "PREFORM_SERVER_PATH to the executable."
            )
        env = dict(os.environ)
        if not cfg.telemetry_enabled:
            env["DISABLE_PREFORMSERVER_TELEMETRY"] = "1"
        log.info("Starting PreFormServer (%s) on port %s", path, cfg.preform_server_port)
        self._proc = await asyncio.create_subprocess_exec(
            str(path),
            "--port",
            str(cfg.preform_server_port),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            stdin=asyncio.subprocess.DEVNULL,
            env=env,
        )
        self._stdout_task = asyncio.create_task(self._drain_stdout())
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=cfg.startup_timeout_seconds)
        except asyncio.TimeoutError as exc:
            await self.shutdown()
            raise RuntimeError(
                f"PreFormServer did not become ready within {cfg.startup_timeout_seconds:.0f}s. "
                "On macOS the first launch can be slow while Gatekeeper verifies the app; "
                "try again, or raise PREFORM_STARTUP_TIMEOUT."
            ) from exc

    async def _drain_stdout(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        while True:
            line = await self._proc.stdout.readline()
            if not line:
                return
            text = line.decode(errors="replace").rstrip()
            # stdout is the MCP transport; everything from PreFormServer goes to stderr.
            print(f"[preform] {text}", file=sys.stderr, flush=True)
            if READY_TOKEN in text:
                self._ready.set()

    async def _wait_until_reachable(self) -> None:
        cfg = self._config
        url = f"{cfg.base_url}/"
        deadline = time.monotonic() + 30.0
        async with httpx.AsyncClient(timeout=5.0) as client:
            while True:
                try:
                    resp = await client.get(url)
                    if resp.status_code < 500:
                        return
                except httpx.HTTPError:
                    pass
                if time.monotonic() > deadline:
                    hint = (
                        "Set PREFORM_SERVER_PATH to the PreFormServer executable so it can be "
                        "started automatically, or start it yourself first."
                        if cfg.preform_server_path is None
                        else "PreFormServer was started but never answered HTTP."
                    )
                    raise RuntimeError(f"PreFormServer at {url} is not reachable. {hint}")
                await asyncio.sleep(0.5)

    async def shutdown(self) -> None:
        proc = self._proc
        if proc is None:
            return
        if proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.send_signal(signal.SIGTERM)
            try:
                await asyncio.wait_for(proc.wait(), timeout=10.0)
            except asyncio.TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(proc.wait(), timeout=5.0)
        if self._stdout_task:
            self._stdout_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._stdout_task
        self._proc = None
