"""Unit tests for the path-allowlist validator."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from formlabs_local_mcp.paths import PathNotAllowed, validate_path


def test_empty_allowlist_passes_through(tmp_path: Path) -> None:
    target = str(tmp_path / "anywhere.form")
    assert validate_path(target, ()) == target


def test_path_inside_prefix_is_allowed(tmp_path: Path) -> None:
    inside = tmp_path / "sub" / "part.stl"
    inside.parent.mkdir()
    result = validate_path(str(inside), (tmp_path.resolve(),))
    assert result == str(inside.resolve())


def test_path_outside_prefix_is_rejected(tmp_path: Path) -> None:
    other = tmp_path.parent / "elsewhere.stl"
    with pytest.raises(PathNotAllowed):
        validate_path(str(other), (tmp_path.resolve(),))


def test_relative_path_is_rejected_when_allowlist_set(tmp_path: Path) -> None:
    with pytest.raises(PathNotAllowed):
        validate_path("relative/path.stl", (tmp_path.resolve(),))


def test_symlink_escape_is_blocked(tmp_path: Path) -> None:
    """A symlink inside the allowed dir pointing outside it must be rejected."""
    outside = tmp_path.parent / "secret.txt"
    outside.write_text("nope")
    try:
        link = tmp_path / "innocent.stl"
        os.symlink(outside, link)
        with pytest.raises(PathNotAllowed):
            validate_path(str(link), (tmp_path.resolve(),))
    finally:
        outside.unlink(missing_ok=True)


def test_nonexistent_path_under_prefix_is_allowed(tmp_path: Path) -> None:
    """save_form writes a new file — the target won't exist yet."""
    future = tmp_path / "not-yet.form"
    result = validate_path(str(future), (tmp_path.resolve(),))
    assert result == str(future.resolve())
