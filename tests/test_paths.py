"""File-path guard rails."""

from __future__ import annotations

from pathlib import Path

import pytest

from formlabs_local_mcp.paths import (
    FORM_EXTENSIONS,
    MODEL_EXTENSIONS,
    PathNotAllowed,
    input_path,
    output_path,
)
from tests.conftest import make_config


@pytest.fixture
def sandbox(tmp_path: Path):
    (tmp_path / "parts").mkdir()
    (tmp_path / "parts" / "bracket.stl").write_bytes(b"solid x\nendsolid x\n")
    (tmp_path / ".ssh").mkdir()
    (tmp_path / ".ssh" / "authorized_keys.stl").write_text("")
    return make_config(allowed_paths=(tmp_path.resolve(),))


def test_input_path_accepts_model_in_allowed_dir(sandbox, tmp_path) -> None:
    p = tmp_path / "parts" / "bracket.stl"
    assert input_path(str(p), sandbox) == str(p.resolve())


def test_input_path_expands_tilde(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))  # Windows
    (tmp_path / "a.stl").write_text("")
    cfg = make_config(allowed_paths=(tmp_path.resolve(),))
    assert input_path("~/a.stl", cfg) == str((tmp_path / "a.stl").resolve())


def test_relative_path_rejected(sandbox) -> None:
    with pytest.raises(PathNotAllowed, match="absolute"):
        input_path("parts/bracket.stl", sandbox)


def test_wrong_extension_rejected(sandbox, tmp_path) -> None:
    (tmp_path / "parts" / "notes.txt").write_text("")
    with pytest.raises(PathNotAllowed, match="must end in"):
        input_path(str(tmp_path / "parts" / "notes.txt"), sandbox)


def test_missing_input_rejected(sandbox, tmp_path) -> None:
    with pytest.raises(PathNotAllowed, match="does not exist"):
        input_path(str(tmp_path / "parts" / "nope.stl"), sandbox)


def test_outside_allowed_root_rejected(sandbox, tmp_path) -> None:
    outside = Path(tmp_path.anchor) / "etc" / "passwd.stl"  # absolute on every OS
    with pytest.raises(PathNotAllowed, match="outside the allowed"):
        input_path(str(outside), sandbox)


def test_hidden_directory_rejected(sandbox, tmp_path) -> None:
    with pytest.raises(PathNotAllowed, match="hidden"):
        input_path(str(tmp_path / ".ssh" / "authorized_keys.stl"), sandbox)


def test_hidden_directory_allowed_when_opted_in(tmp_path) -> None:
    cfg = make_config(allowed_paths=(tmp_path.resolve(),), allow_hidden_paths=True)
    (tmp_path / ".hidden").mkdir()
    target = tmp_path / ".hidden" / "x.form"
    assert output_path(str(target), cfg, FORM_EXTENSIONS) == str(target.resolve())


def test_symlink_escape_rejected(sandbox, tmp_path) -> None:
    outside = tmp_path.parent / f"{tmp_path.name}-outside"
    outside.mkdir()
    (outside / "secret.stl").write_text("")
    (tmp_path / "parts" / "link").symlink_to(outside)
    with pytest.raises(PathNotAllowed, match="outside the allowed"):
        input_path(str(tmp_path / "parts" / "link" / "secret.stl"), sandbox)


def test_output_path_requires_existing_parent(sandbox, tmp_path) -> None:
    with pytest.raises(PathNotAllowed, match="directory"):
        output_path(str(tmp_path / "missing" / "job.form"), sandbox, FORM_EXTENSIONS)


def test_output_path_accepts_new_file(sandbox, tmp_path) -> None:
    target = tmp_path / "parts" / "job.form"
    assert output_path(str(target), sandbox, FORM_EXTENSIONS) == str(target.resolve())


def test_output_extension_enforced(sandbox, tmp_path) -> None:
    with pytest.raises(PathNotAllowed, match="must end in"):
        output_path(str(tmp_path / "parts" / "job.sh"), sandbox, FORM_EXTENSIONS)


def test_model_extensions_cover_common_formats() -> None:
    assert {".stl", ".obj", ".3mf"} <= MODEL_EXTENSIONS
