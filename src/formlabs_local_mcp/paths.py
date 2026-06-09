"""Path-allowlist validation for the filesystem-touching MCP tools.

The MCP tool surface includes several tools (import_model, load_form, save_form,
save_screenshot, create_scene with fps_file) that forward absolute file paths to
PreFormServer, which reads or writes the corresponding file. A prompt-injected
LLM could in principle ask the server to write to ~/.ssh/authorized_keys or
read /etc/passwd via these tools.

`FORMLABS_MCP_ALLOWED_PATHS` (colon-separated directory prefixes) lets operators
constrain that surface. When unset, validation is skipped — preserving the
existing zero-config behavior — and a startup warning is logged.
"""

from __future__ import annotations

from pathlib import Path


class PathNotAllowed(ValueError):
    """Raised when a file path is outside the configured allowlist."""


def validate_path(path: str, allowed_prefixes: tuple[Path, ...]) -> str:
    """Validate that `path` is within one of `allowed_prefixes`.

    Returns the resolved absolute path string for forwarding to PreFormServer.

    Resolves symlinks so an attacker can't allowlist-escape via a symlink
    inside an allowed directory that points elsewhere. `strict=False` so the
    target file doesn't need to exist yet (e.g. `save_form` writes a new file).

    If `allowed_prefixes` is empty, returns `path` unchanged — opt-in hardening.
    """
    if not allowed_prefixes:
        return path
    p = Path(path).expanduser()
    if not p.is_absolute():
        raise PathNotAllowed(
            f"Path must be absolute (got {path!r}). PreFormServer rejects "
            "relative paths."
        )
    resolved = p.resolve(strict=False)
    for prefix in allowed_prefixes:
        if resolved == prefix or resolved.is_relative_to(prefix):
            return str(resolved)
    raise PathNotAllowed(
        f"Path {path!r} is outside FORMLABS_MCP_ALLOWED_PATHS "
        f"(resolved to {resolved}). Allowed prefixes: "
        f"{', '.join(str(p) for p in allowed_prefixes)}."
    )
