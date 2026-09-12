"""Thin httpx wrapper around the PreFormServer HTTP API.

Centralizes base URL and timeouts, translates error responses into
`PreFormError`, and hides the `?async=true` + poll `/operations/{id}/` dance
behind `post_async_operation` / `get_async_operation`.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from formlabs_local_mcp.config import Config

ProgressCallback = Callable[[float], Awaitable[None]]


class PreFormError(RuntimeError):
    """Raised when PreFormServer returns a non-success response."""

    def __init__(self, status: int, code: str | None, message: str, body: Any = None):
        self.status = status
        self.code = code
        self.message = message
        self.body = body
        super().__init__(f"[{status}] {code or 'error'}: {message}")


class PreFormClient:
    def __init__(self, config: Config):
        self._config = config
        # PreFormServer caps blocking calls at ten minutes; give the read a bit more.
        self._client = httpx.AsyncClient(
            base_url=config.base_url,
            timeout=httpx.Timeout(connect=10.0, read=620.0, write=60.0, pool=10.0),
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        resp = await self._client.request(method, path, json=json, params=params)
        return self._handle(resp)

    async def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        return await self.request("GET", path, params=params)

    async def post(self, path: str, json: Any = None, params: dict[str, Any] | None = None) -> Any:
        return await self.request("POST", path, json=json, params=params)

    async def put(self, path: str, json: Any = None) -> Any:
        return await self.request("PUT", path, json=json)

    async def delete(self, path: str) -> Any:
        return await self.request("DELETE", path)

    async def post_async_operation(
        self,
        path: str,
        json: Any = None,
        progress_callback: ProgressCallback | None = None,
    ) -> Any:
        """POST with ?async=true, then poll until the operation finishes."""
        return await self._async_operation("POST", path, json, progress_callback)

    async def get_async_operation(
        self,
        path: str,
        progress_callback: ProgressCallback | None = None,
    ) -> Any:
        """GET with ?async=true (validation endpoints), then poll until done."""
        return await self._async_operation("GET", path, None, progress_callback)

    async def _async_operation(
        self,
        method: str,
        path: str,
        json: Any,
        progress_callback: ProgressCallback | None,
    ) -> Any:
        accepted = await self.request(method, path, json=json, params={"async": "true"})
        op_id = None
        if isinstance(accepted, dict):
            op_id = accepted.get("operationId") or accepted.get("operation_id")
        if not op_id:
            # Server answered synchronously; the response is the result.
            return accepted
        return await self.poll_operation(op_id, progress_callback=progress_callback)

    async def poll_operation(
        self, operation_id: str, progress_callback: ProgressCallback | None = None
    ) -> Any:
        interval = self._config.poll_interval_seconds
        deadline = time.monotonic() + self._config.poll_timeout_seconds
        last_progress = -1.0
        while True:
            op = await self.get(f"/operations/{operation_id}/")
            status = op.get("status")
            progress = float(op.get("progress") or 0.0)
            if progress_callback and progress != last_progress:
                try:
                    await progress_callback(progress)
                except Exception:
                    pass
                last_progress = progress

            if status == "SUCCEEDED":
                return op.get("result")
            if status == "FAILED":
                result = op.get("result") or {}
                err = result.get("error") if isinstance(result, dict) else None
                code = err.get("code") if isinstance(err, dict) else None
                message = err.get("message") if isinstance(err, dict) else None
                raise PreFormError(500, code, message or "Operation failed", body=op)

            if time.monotonic() > deadline:
                raise PreFormError(
                    408,
                    "OPERATION_TIMEOUT",
                    f"Operation {operation_id} did not complete within "
                    f"{self._config.poll_timeout_seconds:.0f}s",
                )
            await asyncio.sleep(interval)

    @staticmethod
    def _handle(resp: httpx.Response) -> Any:
        if resp.is_success:
            if resp.status_code == 204 or not resp.content:
                return None
            try:
                return resp.json()
            except ValueError:
                return resp.text
        code = None
        message = resp.text
        body: Any = None
        try:
            body = resp.json()
            err = body.get("error") if isinstance(body, dict) else None
            if isinstance(err, dict):
                code = err.get("code")
                message = err.get("message") or message
        except ValueError:
            pass
        raise PreFormError(resp.status_code, code, message, body=body)
