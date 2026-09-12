"""Guard rails for every tool that hands a file path to PreFormServer.

PreFormServer reads and writes whatever absolute path it is given, as the
user running it. A prompt-injected model could otherwise be talked into
writing `~/.ssh/authorized_keys` or reading `/etc/passwd`. Three checks keep
that surface small:

1. The path must be absolute (PreFormServer rejects anything else anyway).
2. It must resolve (symlinks included) to somewhere under an allowed root.
   Default root: the user's home directory.
3. No path component may be hidden (start with ".") unless explicitly
   allowed. That keeps `~/.ssh`, `~/.aws`, `~/.config` and friends off limits
   even though they live under home.
4. The extension must match what the tool is for (`.stl` in, `.form` out).
"""

from __future__ import annotations

import os
from pathlib import Path

from formlabs_local_mcp.config import Config

MODEL_EXTENSIONS = frozenset({".stl", ".obj", ".3mf", ".step", ".stp", ".form"})
FORM_EXTENSIONS = frozenset({".form"})
FPS_EXTENSIONS = frozenset({".fps"})
IMAGE_EXTENSIONS = frozenset({".png", ".webp"})


class PathNotAllowed(ValueError):
    """Raised when a path fails one of the checks above."""


def _check(path: str, config: Config, extensions: frozenset[str], must_exist: bool) -> Path:
    if not path or not path.strip():
        raise PathNotAllowed("A file path is required.")
    p = Path(os.path.expanduser(path))
    if not p.is_absolute():
        raise PathNotAllowed(
            f"Path must be absolute (got {path!r}). Resolve it against the working "
            "directory first; PreFormServer does not accept relative paths."
        )
    resolved = p.resolve()
    if resolved.suffix.lower() not in extensions:
        allowed = ", ".join(sorted(extensions))
        raise PathNotAllowed(f"{path!r} must end in one of: {allowed}.")
    if not any(resolved == root or root in resolved.parents for root in config.allowed_paths):
        roots = ", ".join(str(r) for r in config.allowed_paths)
        raise PathNotAllowed(
            f"{path!r} is outside the allowed directories ({roots}). "
            "Set FORMLABS_ALLOWED_PATHS to add more."
        )
    if not config.allow_hidden_paths:
        rel_parts = resolved.parts
        for root in config.allowed_paths:
            if resolved == root or root in resolved.parents:
                rel_parts = resolved.relative_to(root).parts
                break
        hidden = [part for part in rel_parts if part.startswith(".")]
        if hidden:
            raise PathNotAllowed(
                f"{path!r} passes through a hidden directory or file ({hidden[0]}). "
                "Set FORMLABS_ALLOW_HIDDEN_PATHS=1 if that is intentional."
            )
    if must_exist and not resolved.is_file():
        raise PathNotAllowed(f"{path!r} does not exist or is not a file.")
    if not must_exist and not resolved.parent.is_dir():
        raise PathNotAllowed(f"The directory for {path!r} does not exist.")
    return resolved


def input_path(path: str, config: Config, extensions: frozenset[str] = MODEL_EXTENSIONS) -> str:
    """Validate a path PreFormServer will read. Returns the resolved string."""
    return str(_check(path, config, extensions, must_exist=True))


def output_path(path: str, config: Config, extensions: frozenset[str]) -> str:
    """Validate a path PreFormServer will write. Returns the resolved string."""
    return str(_check(path, config, extensions, must_exist=False))
