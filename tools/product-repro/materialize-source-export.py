#!/usr/bin/env python3
"""Materialize the pinned product source-export tree from local Git objects."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath


BASE_VIEWER_COMMIT = "80a9cd308cb3c6c5a1ccc27241cd645803675921"
D2B_REFERENCE_COMMIT = "b30ad676922af73448952d5a9cac312467a944f9"
D2B_REFERENCE_TREE_OID = "6e5b4844548c1355dea7e5cbbcb1200c9d2335fd"
BASE_SOURCE_PREFIX = PurePosixPath("src")
OVERLAY_SOURCE_PREFIX = PurePosixPath("src/protocol/d2b-reference")
OVERLAY_TARGET_PREFIX = PurePosixPath("src/protocol/d2b-reference")
TARGET_RELATIVE = PurePosixPath("src/product/source-export/viewer")


class MaterializeError(RuntimeError):
    """Raised when a fail-closed materialization check fails."""


def run_git(repository: Path, *arguments: str) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise MaterializeError(f"git {' '.join(arguments)} failed: {detail}")
    return result.stdout


def repository_root() -> Path:
    candidate = Path(__file__).resolve().parents[2]
    root = Path(run_git(candidate, "rev-parse", "--show-toplevel").decode().strip()).resolve()
    if root != candidate:
        raise MaterializeError("tool must run from its own Device-to-Browser-Viewer repository")
    return root


def verify_commit(repository: Path, commit: str) -> None:
    resolved = run_git(repository, "rev-parse", "--verify", f"{commit}^{{commit}}").decode().strip()
    if resolved != commit:
        raise MaterializeError(f"Git commit did not resolve exactly: {commit}")


def verify_d2b_reference_tree(repository: Path, viewer_head: str) -> str:
    observed = run_git(
        repository,
        "rev-parse",
        "--verify",
        f"{viewer_head}:{OVERLAY_SOURCE_PREFIX.as_posix()}",
    ).decode().strip()
    object_type = run_git(repository, "cat-file", "-t", observed).decode().strip()
    if object_type != "tree":
        raise MaterializeError(
            f"Viewer D2B reference object is not a Git tree: {object_type}"
        )
    if observed != D2B_REFERENCE_TREE_OID:
        raise MaterializeError(
            "D2B reference tree identity mismatch: "
            f"expected={D2B_REFERENCE_TREE_OID} observed={observed}"
        )
    return observed


def tree_blobs(
    repository: Path,
    commit: str,
    source_prefix: PurePosixPath,
    target_prefix: PurePosixPath,
) -> dict[PurePosixPath, tuple[str, bytes]]:
    output = run_git(repository, "ls-tree", "-r", "-z", commit, "--", str(source_prefix))
    blobs: dict[PurePosixPath, tuple[str, bytes]] = {}
    for record in output.split(b"\0"):
        if not record:
            continue
        metadata, separator, encoded_path = record.partition(b"\t")
        if not separator:
            raise MaterializeError("unexpected git ls-tree record")
        fields = metadata.decode("ascii").split()
        if len(fields) != 3:
            raise MaterializeError("unexpected git ls-tree metadata")
        mode, object_type, object_id = fields
        if mode != "100644" or object_type != "blob":
            raise MaterializeError(
                f"unsupported Git entry mode/type {mode} {object_type}: "
                f"{encoded_path.decode('utf-8', errors='replace')}"
            )
        try:
            path = PurePosixPath(encoded_path.decode("utf-8"))
            relative = path.relative_to(source_prefix)
        except (UnicodeDecodeError, ValueError) as error:
            raise MaterializeError("invalid source-export Git path") from error
        if not relative.parts or any(part in ("", ".", "..") for part in relative.parts):
            raise MaterializeError(f"unsafe source-export Git path: {relative}")
        target = target_prefix / relative
        if target in blobs:
            raise MaterializeError(f"duplicate source-export Git path: {target}")
        payload = run_git(repository, "cat-file", "blob", object_id)
        blobs[target] = (object_id, payload)
    if not blobs:
        raise MaterializeError(f"Git source-export tree is empty: {commit}:{source_prefix}")
    return blobs


def composite_blobs(
    repository: Path, viewer_head: str
) -> tuple[dict[PurePosixPath, tuple[str, bytes]], int]:
    base = tree_blobs(
        repository,
        BASE_VIEWER_COMMIT,
        BASE_SOURCE_PREFIX,
        PurePosixPath("src"),
    )
    overlay = tree_blobs(
        repository,
        viewer_head,
        OVERLAY_SOURCE_PREFIX,
        OVERLAY_TARGET_PREFIX,
    )
    composite = {
        path: value
        for path, value in base.items()
        if OVERLAY_TARGET_PREFIX not in (path, *path.parents)
    }
    composite.update(overlay)
    return composite, len(overlay)


def expected_directories(blobs: dict[PurePosixPath, tuple[str, bytes]]) -> set[str]:
    directories = {"."}
    for relative in blobs:
        parent = relative.parent
        while str(parent) not in (".", ""):
            directories.add(parent.as_posix())
            parent = parent.parent
    return directories


def inspect_existing(
    viewer_root: Path, blobs: dict[PurePosixPath, tuple[str, bytes]]
) -> None:
    if viewer_root.is_symlink() or not viewer_root.is_dir():
        raise MaterializeError("existing generated Viewer root is not a real directory")

    actual_files: set[str] = set()
    actual_directories = {"."}
    for current, directory_names, file_names in os.walk(viewer_root, followlinks=False):
        current_path = Path(current)
        current_relative = current_path.relative_to(viewer_root)
        if current_path.is_symlink():
            raise MaterializeError(f"symlink prohibited in existing target: {current_relative}")
        for name in list(directory_names):
            path = current_path / name
            relative = path.relative_to(viewer_root).as_posix()
            if path.is_symlink():
                raise MaterializeError(f"symlink prohibited in existing target: {relative}")
            if not path.is_dir():
                raise MaterializeError(f"unexpected non-directory in target: {relative}")
            actual_directories.add(relative)
        for name in file_names:
            path = current_path / name
            relative = path.relative_to(viewer_root).as_posix()
            file_mode = path.lstat().st_mode
            if stat.S_ISLNK(file_mode) or not stat.S_ISREG(file_mode):
                raise MaterializeError(f"non-regular file prohibited in target: {relative}")
            actual_files.add(relative)

    expected_files = {relative.as_posix() for relative in blobs}
    if actual_files != expected_files or actual_directories != expected_directories(blobs):
        missing = sorted(expected_files - actual_files)
        extra = sorted(actual_files - expected_files)
        extra_directories = sorted(actual_directories - expected_directories(blobs))
        raise MaterializeError(
            "existing generated Viewer tree is not exact: "
            f"missing={missing} extra={extra} extra_directories={extra_directories}"
        )

    for relative, (_, expected) in blobs.items():
        path = viewer_root / Path(*relative.parts)
        actual = path.read_bytes()
        if actual != expected:
            raise MaterializeError(
                "existing generated Viewer file differs: "
                f"{relative} expected_sha256={hashlib.sha256(expected).hexdigest()} "
                f"actual_sha256={hashlib.sha256(actual).hexdigest()}"
            )


def ensure_real_ancestors(repository: Path, destination_parent: Path) -> None:
    relative = destination_parent.relative_to(repository)
    current = repository
    for part in relative.parts:
        current = current / part
        if current.exists() or current.is_symlink():
            if current.is_symlink() or not current.is_dir():
                raise MaterializeError(f"destination ancestor is not a real directory: {current}")


def materialize(
    repository: Path, viewer_root: Path, blobs: dict[PurePosixPath, tuple[str, bytes]]
) -> str:
    if viewer_root.exists() or viewer_root.is_symlink():
        inspect_existing(viewer_root, blobs)
        return "already-exact"

    destination_parent = viewer_root.parent
    ensure_real_ancestors(repository, destination_parent)
    destination_parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".viewer-materialize-", dir=destination_parent))
    try:
        for relative, (_, payload) in blobs.items():
            destination = temporary / Path(*relative.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(payload)
            destination.chmod(0o644)
        inspect_existing(temporary, blobs)
        if viewer_root.exists() or viewer_root.is_symlink():
            raise MaterializeError("generated Viewer target appeared during materialization")
        temporary.rename(viewer_root)
    except BaseException:
        if temporary.exists():
            shutil.rmtree(temporary)
        raise
    return "materialized"


def main() -> int:
    try:
        repository = repository_root()
        verify_commit(repository, BASE_VIEWER_COMMIT)
        viewer_head = run_git(repository, "rev-parse", "HEAD").decode().strip()
        verify_commit(repository, viewer_head)
        observed_d2b_reference_tree_oid = verify_d2b_reference_tree(
            repository, viewer_head
        )
        blobs, overlay_file_count = composite_blobs(repository, viewer_head)
        viewer_root = repository.joinpath(*TARGET_RELATIVE.parts)
        action = materialize(repository, viewer_root, blobs)
        print(
            json.dumps(
                {
                    "result": "PASS",
                    "action": action,
                    "base_viewer_commit": BASE_VIEWER_COMMIT,
                    "base_viewer_tree": "src",
                    "viewer_head": viewer_head,
                    "d2b_reference_commit": D2B_REFERENCE_COMMIT,
                    "d2b_reference_tree_oid": D2B_REFERENCE_TREE_OID,
                    "observed_d2b_reference_tree_oid": (
                        observed_d2b_reference_tree_oid
                    ),
                    "overlay_source": OVERLAY_SOURCE_PREFIX.as_posix(),
                    "overlay_file_count": overlay_file_count,
                    "target": TARGET_RELATIVE.as_posix(),
                    "file_count": len(blobs),
                    "representation": (
                        "historical Viewer base plus current Viewer HEAD D2B reference "
                        "Git blobs; generated copy, not source authority"
                    ),
                },
                sort_keys=True,
            )
        )
        return 0
    except (MaterializeError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({"result": "FAIL", "error": str(error)}, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
