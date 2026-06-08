"""PreFormServer subprocess lifecycle.

If `PREFORM_SERVER_PATH` is set in the environment, we spawn the PreFormServer
executable and wait for its `READY FOR INPUT` stdout signal before letting the
MCP server accept tool calls. Otherwise we assume something else (the user, a
launchd service, an IDE plugin) has already started it on the configured port.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import sys
from pathlib import Path

import httpx

from formlabs_local_mcp.config import Config

log = logging.getLogger(__name__)

READY_TOKEN = "READY FOR INPUT"


class PreFormServerProcess:
    def __init__(self, config: Config):
        self._config = config
        self._proc: asyncio.subprocess.Process | None = None
        self._stdout_task: asyncio.Task | None = None
        self._ready = asyncio.Event()

    async def ensure_running(self) -> None:
        """Spawn the server if configured to, then verify it's reachable."""
        if self._config.spawn_preform_server and self._config.preform_server_path:
            await self._spawn()
        await self._wait_until_reachable()

    async def _spawn(self) -> None:
        path = Path(self._config.preform_server_path)  # type: ignore[arg-type]
        if not path.exists():
            raise FileNotFoundError(f"PREFORM_SERVER_PATH does not exist: {path}")
        log.info("Spawning PreFormServer at %s on port %s", path, self._config.preform_server_port)
        self._proc = await asyncio.create_subprocess_exec(
            str(path),
            "--port",
            str(self._config.preform_server_port),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        self._stdout_task = asyncio.create_task(self._drain_stdout())
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=60.0)
        except asyncio.TimeoutError as exc:
            await self.shutdown()
            raise RuntimeError("PreFormServer did not signal READY FOR INPUT within 60s") from exc

    async def _drain_stdout(self) -> None:
        assert self._proc and self._proc.stdout
        while True:
            line = await self._proc.stdout.readline()
            if not line:
                return
            text = line.decode(errors="replace").rstrip()
            # Log to stderr so we don't pollute the MCP stdio transport.
            print(f"[preform] {text}", file=sys.stderr, flush=True)
            if READY_TOKEN in text:
                self._ready.set()

    async def _wait_until_reachable(self) -> None:
        url = f"{self._config.base_url}/"
        deadline = asyncio.get_event_loop().time() + 30.0
        async with httpx.AsyncClient(timeout=5.0) as client:
            while True:
                try:
                    resp = await client.get(url)
                    if resp.status_code < 500:
                        return
                except (httpx.ConnectError, httpx.ReadError):
                    pass
                if asyncio.get_event_loop().time() > deadline:
                    raise RuntimeError(
                        f"PreFormServer at {url} is not reachable. "
                        "Either start it manually or set PREFORM_SERVER_PATH so the MCP "
                        "server can spawn it."
                    )
                await asyncio.sleep(0.5)

    async def shutdown(self) -> None:
        if not self._proc:
            return
        if self._proc.returncode is None:
            try:
                self._proc.send_signal(signal.SIGTERM)
                await asyncio.wait_for(self._proc.wait(), timeout=10.0)
            except (ProcessLookupError, asyncio.TimeoutError):
                with contextlib.suppress(ProcessLookupError):
                    self._proc.kill()
        if self._stdout_task:
            self._stdout_task.cancel()


# Local import to keep the module's top-level imports tidy.
import contextlib  # noqa: E402
