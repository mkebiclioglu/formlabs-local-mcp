"""Thin httpx wrapper around the PreFormServer HTTP API.

Centralizes:
- Base URL and timeout configuration
- Error translation (HTTP errors → PreFormError with the server's error code/message)
- Async operation polling
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from formlabs_local_mcp.config import Config


class PreFormError(RuntimeError):
    """Raised when the PreFormServer returns a non-success response."""

    def __init__(self, status: int, code: str | None, message: str, body: Any = None):
        self.status = status
        self.code = code
        self.message = message
        self.body = body
        super().__init__(f"[{status}] {code or 'error'}: {message}")


class PreFormClient:
    def __init__(self, config: Config):
        self._config = config
        # 10 minute server-side cap on long blocking calls — use slightly more on the client.
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

    async def post(
        self,
        path: str,
        json: Any = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        return await self.request("POST", path, json=json, params=params)

    async def put(self, path: str, json: Any = None) -> Any:
        return await self.request("PUT", path, json=json)

    async def delete(self, path: str) -> Any:
        return await self.request("DELETE", path)

    async def post_async_operation(
        self,
        path: str,
        json: Any = None,
        progress_callback=None,
    ) -> Any:
        """POST with ?async=true, then poll /operations/{id}/ until done.

        Returns the final `result` payload from the operation. Raises
        PreFormError on FAILED. `progress_callback`, if provided, is awaited
        with a float in [0.0, 1.0] each time progress changes.
        """
        accepted = await self.request("POST", path, json=json, params={"async": "true"})
        # PreFormServer uses `operationId` (camelCase) in the OperationAcceptedModel.
        # Older drafts of the spec referenced `operation_id` / `id`; accept all three
        # to stay forward-compatible.
        op_id = (
            accepted.get("operationId")
            or accepted.get("operation_id")
            or accepted.get("id")
        )
        if not op_id:
            # Server didn't honour async — assume the response IS the result.
            return accepted
        return await self.poll_operation(op_id, progress_callback=progress_callback)

    async def poll_operation(self, operation_id: str, progress_callback=None) -> Any:
        interval = self._config.poll_interval_seconds
        deadline = asyncio.get_event_loop().time() + self._config.poll_timeout_seconds
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
                code = (err or {}).get("code") if isinstance(err, dict) else None
                message = (err or {}).get("message", "Operation failed") if isinstance(err, dict) else "Operation failed"
                raise PreFormError(200, code, message, body=op)

            if asyncio.get_event_loop().time() > deadline:
                raise PreFormError(
                    408,
                    "OPERATION_TIMEOUT",
                    f"Operation {operation_id} did not complete within "
                    f"{self._config.poll_timeout_seconds}s",
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
                return resp.content
        # Translate to PreFormError using the server's ErrorModel shape when available.
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
