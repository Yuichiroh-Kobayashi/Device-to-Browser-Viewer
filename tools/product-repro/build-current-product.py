#!/usr/bin/env python3
"""Build the current device-hosted product from clean, committed Viewer inputs."""

from __future__ import annotations

import difflib
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath


BASE_VIEWER_COMMIT = "80a9cd308cb3c6c5a1ccc27241cd645803675921"
D2B_AUTHORITY_COMMIT = "b30ad676922af73448952d5a9cac312467a944f9"
D2B_REFERENCE_TREE_OID = "6e5b4844548c1355dea7e5cbbcb1200c9d2335fd"
BUILDER_SHA256 = "616e1e4aff16d21b49f4d0b8f3c8bda46a5f47ad09d4a2eb9a0b0227ca06c5aa"
BUILDER_LINES = 368
BUILDER_RELATIVE = Path("tools/p2-builder/p2-builder.py")
PRODUCT_PREFIX = PurePosixPath("src/product/p2-sp")
BASE_SOURCE_PREFIX = PurePosixPath("src")
OVERLAY_PREFIX = PurePosixPath("src/protocol/d2b-reference")

# Explicit current-product file-scope authority. The recovered historical
# builder's own PROTOTYPE_ALLOWLIST is frozen at its recovered identity (see
# BUILDER_SHA256 above) and predates files a later, explicitly reviewed
# current-product change may add. This set is the current build's own
# approval boundary: every file that must be, and no file that must not be,
# present under the committed HEAD's src/product/p2-sp/. Adding a new
# product source file requires a deliberate, reviewed edit to this set --
# an unreviewed new file always fails closed (see verify_current_product_
# file_scope below), the same way the historical allowlist always did.
CURRENT_PRODUCT_ALLOWLIST = frozenset({
    "index.html",
    "app.css",
    "app.js",
    "runtime-owner.js",
    "student-primary-action-controller.js",
    "presentation/mode-controller.js",
    "presentation/student-view.js",
    "presentation/view-state.js",
    "presentation/deployment-context.js",
    "presentation/professional-view.js",
    "presentation/theme-controller.js",
    "graph/graph-core.js",
    "graph/waveform-canvas.js",
    "tests/one-runtime.test.mjs",
    "tests/lifecycle-ui.test.mjs",
    "tests/graph-core.test.mjs",
    "tests/deployment-context.test.mjs",
    "tests/responsive-static.test.mjs",
    "tests/student-presentation.test.mjs",
    "tests/student-primary-action-controller.test.mjs",
    "tests/student-primary-action-integration.test.mjs",
    "tests/theme-contrast.test.mjs",
    "tests/theme-lifecycle.test.mjs",
    "tests/theme-state.test.mjs",
    "README.measurement.md",
})


class CurrentBuildError(RuntimeError):
    """Raised when a current-product authority or build check fails."""


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def run_git(repository: Path, *arguments: str) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise CurrentBuildError(f"git {' '.join(arguments)} failed: {detail}")
    return result.stdout


def repository_root() -> Path:
    candidate = Path(__file__).resolve().parents[2]
    root = Path(run_git(candidate, "rev-parse", "--show-toplevel").decode().strip()).resolve()
    if root != candidate:
        raise CurrentBuildError("tool must run from its own Device-to-Browser-Viewer repository")
    return root


def verify_commit(repository: Path, commit: str) -> None:
    resolved = run_git(repository, "rev-parse", "--verify", f"{commit}^{{commit}}").decode().strip()
    if resolved != commit:
        raise CurrentBuildError(f"Git commit did not resolve exactly: {commit}")


def clean_head(repository: Path) -> str:
    head = run_git(repository, "rev-parse", "HEAD").decode().strip()
    verify_commit(repository, head)
    dirty = run_git(repository, "status", "--porcelain=v1", "-uall")
    if dirty:
        paths = dirty.decode("utf-8", errors="replace").splitlines()
        raise CurrentBuildError(f"Viewer worktree is not clean: {paths}")
    return head


def verify_d2b_reference_tree(repository: Path, viewer_head: str) -> str:
    observed = run_git(
        repository,
        "rev-parse",
        "--verify",
        f"{viewer_head}:{OVERLAY_PREFIX.as_posix()}",
    ).decode().strip()
    object_type = run_git(repository, "cat-file", "-t", observed).decode().strip()
    if object_type != "tree":
        raise CurrentBuildError(
            f"Viewer D2B reference object is not a Git tree: {object_type}"
        )
    if observed != D2B_REFERENCE_TREE_OID:
        raise CurrentBuildError(
            "D2B reference tree identity mismatch: "
            f"expected={D2B_REFERENCE_TREE_OID} observed={observed}"
        )
    return observed


def verify_current_product_file_scope(repository: Path, viewer_head: str) -> frozenset[str]:
    output = run_git(
        repository,
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        viewer_head,
        "--",
        PRODUCT_PREFIX.as_posix(),
    )
    names: set[str] = set()
    for record in output.split(b"\0"):
        if not record:
            continue
        try:
            path = PurePosixPath(record.decode("utf-8"))
            relative = path.relative_to(PRODUCT_PREFIX)
        except (UnicodeDecodeError, ValueError) as error:
            raise CurrentBuildError("invalid Git tree path under src/product/p2-sp") from error
        names.add(relative.as_posix())
    observed = frozenset(names)
    if observed != CURRENT_PRODUCT_ALLOWLIST:
        missing = sorted(CURRENT_PRODUCT_ALLOWLIST - observed)
        extra = sorted(observed - CURRENT_PRODUCT_ALLOWLIST)
        raise CurrentBuildError(
            "CURRENT_PRODUCT_FILE_SCOPE_APPROVAL_REQUIRED "
            f"missing={missing!r} extra={extra!r}"
        )
    return observed


def tree_blobs(
    repository: Path,
    commit: str,
    prefix: PurePosixPath,
    target_prefix: PurePosixPath = PurePosixPath("."),
) -> dict[PurePosixPath, bytes]:
    output = run_git(repository, "ls-tree", "-r", "-z", commit, "--", prefix.as_posix())
    blobs: dict[PurePosixPath, bytes] = {}
    for record in output.split(b"\0"):
        if not record:
            continue
        metadata, separator, encoded_path = record.partition(b"\t")
        fields = metadata.decode("ascii").split()
        if not separator or len(fields) != 3:
            raise CurrentBuildError("unexpected git ls-tree record")
        mode, object_type, object_id = fields
        if mode != "100644" or object_type != "blob":
            raise CurrentBuildError(
                f"unsupported Git entry mode/type {mode} {object_type}: "
                f"{encoded_path.decode('utf-8', errors='replace')}"
            )
        try:
            path = PurePosixPath(encoded_path.decode("utf-8"))
            relative = path.relative_to(prefix)
        except (UnicodeDecodeError, ValueError) as error:
            raise CurrentBuildError("invalid Git tree path") from error
        if not relative.parts or any(part in ("", ".", "..") for part in relative.parts):
            raise CurrentBuildError(f"unsafe Git tree path: {relative}")
        target = target_prefix / relative
        if target in blobs:
            raise CurrentBuildError(f"duplicate Git tree path: {target}")
        blobs[target] = run_git(repository, "cat-file", "blob", object_id)
    if not blobs:
        raise CurrentBuildError(f"Git tree is empty: {commit}:{prefix}")
    return blobs


def blob(repository: Path, commit: str, path: PurePosixPath) -> bytes:
    output = run_git(repository, "ls-tree", "-z", commit, "--", path.as_posix())
    records = [record for record in output.split(b"\0") if record]
    if len(records) != 1:
        raise CurrentBuildError(f"expected exactly one Git blob: {commit}:{path}")
    metadata, separator, encoded_path = records[0].partition(b"\t")
    fields = metadata.decode("ascii").split()
    if not separator or len(fields) != 3 or encoded_path.decode("utf-8") != path.as_posix():
        raise CurrentBuildError(f"unexpected Git blob record: {commit}:{path}")
    mode, object_type, object_id = fields
    if mode != "100644" or object_type != "blob":
        raise CurrentBuildError(f"unsupported Git blob mode/type: {commit}:{path}")
    return run_git(repository, "cat-file", "blob", object_id)


def write_blobs(destination: Path, blobs: dict[PurePosixPath, bytes]) -> None:
    for relative, payload in blobs.items():
        output = destination.joinpath(*relative.parts)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(payload)
        output.chmod(0o644)


def composite_source_export(repository: Path, viewer_head: str) -> tuple[dict[PurePosixPath, bytes], int]:
    base = tree_blobs(
        repository,
        BASE_VIEWER_COMMIT,
        BASE_SOURCE_PREFIX,
        PurePosixPath("src"),
    )
    overlay = tree_blobs(repository, viewer_head, OVERLAY_PREFIX, OVERLAY_PREFIX)
    composite = {
        path: payload
        for path, payload in base.items()
        if OVERLAY_PREFIX not in (path, *path.parents)
    }
    composite.update(overlay)
    return composite, len(overlay)


def prototype_allowlist_literal(allowlist: frozenset[str]) -> str:
    lines = ["PROTOTYPE_ALLOWLIST = frozenset(("]
    for name in sorted(allowlist):
        lines.append(f"    {name!r},")
    lines.append("))")
    return "\n".join(lines)


def adapt_builder(
    repository: Path, generation_root: Path, viewer_head: str
) -> tuple[Path, str]:
    original = (repository / BUILDER_RELATIVE).read_bytes()
    if sha256(original) != BUILDER_SHA256 or original.count(b"\n") != BUILDER_LINES:
        raise CurrentBuildError("tracked recovered builder identity mismatch")
    source = original.decode("utf-8")
    replacements = {
        "EXPECTED_ROOT": f"EXPECTED_ROOT = Path({str(generation_root)!r})",
        "VIEWER_COMMIT": f'VIEWER_COMMIT = "{viewer_head}"',
        "D2B_COMMIT": f'D2B_COMMIT = "{D2B_AUTHORITY_COMMIT}"',
        "PROTOTYPE_ALLOWLIST": prototype_allowlist_literal(CURRENT_PRODUCT_ALLOWLIST),
        "GRAPH_SOURCE": '    "graph/graph-core.js", "graph/waveform-canvas.js",',
    }
    patterns = {
        "EXPECTED_ROOT": re.compile(r"^EXPECTED_ROOT = Path\([^\r\n]+\)$", re.MULTILINE),
        "VIEWER_COMMIT": re.compile(r'^VIEWER_COMMIT = "[0-9a-f]{40}"$', re.MULTILINE),
        "D2B_COMMIT": re.compile(r'^D2B_COMMIT = "[0-9a-f]{40}"$', re.MULTILINE),
        # The historical builder's own allowlist is a multi-line block
        # (`PROTOTYPE_ALLOWLIST = frozenset(P1_PROFESSIONAL + (` ... `))`),
        # not a single line like the three constants above.
        "PROTOTYPE_ALLOWLIST": re.compile(
            r"^PROTOTYPE_ALLOWLIST = frozenset\(P1_PROFESSIONAL \+ \($\n(?:^.*$\n)*?^\)\)$",
            re.MULTILINE,
        ),
        "GRAPH_SOURCE": re.compile(r'^    "graph/autoscale-policy\.js",$', re.MULTILINE),
    }
    adapted = source
    original_blocks: dict[str, str] = {}
    for name in ("EXPECTED_ROOT", "VIEWER_COMMIT", "D2B_COMMIT", "PROTOTYPE_ALLOWLIST", "GRAPH_SOURCE"):
        matches = list(patterns[name].finditer(adapted))
        if len(matches) != 1:
            raise CurrentBuildError(f"recovered builder {name} occurrence count mismatch")
        original_blocks[name] = matches[0].group(0)
        adapted = (
            adapted[: matches[0].start()]
            + replacements[name]
            + adapted[matches[0].end() :]
        )
    restored = adapted
    for name in ("EXPECTED_ROOT", "VIEWER_COMMIT", "D2B_COMMIT", "PROTOTYPE_ALLOWLIST", "GRAPH_SOURCE"):
        restored = restored.replace(replacements[name], original_blocks[name], 1)
    if restored.encode("utf-8") != original:
        raise CurrentBuildError("disposable builder adapter changed more than the five approved regions")

    diff = "".join(
        difflib.unified_diff(
            source.splitlines(keepends=True),
            adapted.splitlines(keepends=True),
            fromfile=BUILDER_RELATIVE.as_posix(),
            tofile="disposable/p2-builder.py",
        )
    )
    if not diff:
        raise CurrentBuildError("disposable builder adapter produced no diff")
    # A hardcoded expected removed/added line count is not a meaningful
    # invariant here: the allowlist block's size depends on how many files
    # are currently approved, and a line shared verbatim between the old and
    # new allowlist blocks (e.g. a lone trailing "))") is coalesced by
    # difflib's LCS matching into unchanged context rather than counted as a
    # remove+add pair. The two checks that actually matter are already
    # enforced above: each of the four named regions matched exactly once
    # (fail-closed on 0 or 2+ matches), and reversing all four substitutions
    # reproduces the tracked original byte-for-byte -- together these prove
    # the adapter touched exactly those four regions and nothing else.

    destination = generation_root / "p2-builder.py"
    destination.write_text(adapted, encoding="utf-8", newline="")
    (generation_root / "p2-builder.diff").write_text(diff, encoding="utf-8")
    return destination, diff


def representation(path: Path) -> dict[str, object]:
    payload = path.read_bytes()
    return {"path": path.name, "bytes": len(payload), "sha256": sha256(payload)}


def verify_candidate(
    repository: Path, generation_root: Path, viewer_head: str
) -> dict[str, object]:
    artifact = generation_root / "artifacts/05-p2-student-professional"
    marker = (artifact / "determinism-compare.txt").read_text(encoding="utf-8")
    if "P2 deterministic comparison=PASS" not in marker:
        raise CurrentBuildError("current builder two-run determinism marker missing")

    bundle_id = (artifact / "viewer-bundle-id.txt").read_text(encoding="utf-8").strip()
    manifest_path = artifact / "served/asset-manifest.json"
    manifest_raw = manifest_path.read_bytes()
    if sha256(manifest_raw) != bundle_id:
        raise CurrentBuildError("manifest SHA-256 does not equal Viewer bundle ID")
    manifest = json.loads(manifest_raw)
    if manifest.get("viewer_source_commit") != viewer_head:
        raise CurrentBuildError("candidate viewer_source_commit mismatch")
    if manifest.get("d2b_authority_commit") != D2B_AUTHORITY_COMMIT:
        raise CurrentBuildError("candidate d2b_authority_commit mismatch")

    by_role = {
        entry["logical_role"]: entry
        for entry in manifest.get("files", [])
        if isinstance(entry, dict) and "logical_role" in entry
    }
    if set(by_role) != {"entry_html", "app_css", "app_js"}:
        raise CurrentBuildError(f"unexpected manifest roles: {sorted(by_role)}")
    paths: dict[str, Path] = {
        role: artifact / "served" / str(entry["physical_filename"])
        for role, entry in by_role.items()
    }
    for role, path in paths.items():
        payload = path.read_bytes()
        entry = by_role[role]
        if len(payload) != entry.get("bytes") or sha256(payload) != entry.get("sha256"):
            raise CurrentBuildError(f"candidate manifest representation mismatch: {role}")

    raw_css = (artifact / "raw/app.css").read_bytes()
    committed_css = blob(
        repository,
        viewer_head,
        PurePosixPath("src/product/p2-sp/app.css"),
    )
    if raw_css != committed_css or b"\r\n" in raw_css:
        raise CurrentBuildError("current app.css is not the exact committed LF representation")

    index = representation(paths["entry_html"])
    manifest_info = representation(manifest_path)
    css = representation(paths["app_css"])
    js = representation(paths["app_js"])
    stored_bytes = sum(int(item["bytes"]) for item in (index, manifest_info, css, js))
    return {
        "bundle_id": bundle_id,
        "index": index,
        "manifest": manifest_info,
        "css_gzip": css,
        "js_gzip": js,
        "stored_bytes": stored_bytes,
        "two_run_determinism": "PASS",
        "viewer_source_commit": manifest["viewer_source_commit"],
        "d2b_authority_commit": manifest["d2b_authority_commit"],
    }


def main() -> int:
    evidence_root: Path | None = None
    try:
        repository = repository_root()
        viewer_head = clean_head(repository)
        observed_d2b_reference_tree_oid = verify_d2b_reference_tree(
            repository, viewer_head
        )
        verify_commit(repository, BASE_VIEWER_COMMIT)
        observed_current_product_files = verify_current_product_file_scope(repository, viewer_head)
        evidence_root = Path(tempfile.mkdtemp(prefix="device-to-browser-viewer-current-product-"))
        generation_root = evidence_root / "viewer"
        prototype = generation_root / "prototype"
        source_export = generation_root / "source-export/viewer"

        write_blobs(prototype, tree_blobs(repository, viewer_head, PRODUCT_PREFIX))
        package_payload = blob(repository, viewer_head, PurePosixPath("package.json"))
        (generation_root / "package.json").parent.mkdir(parents=True, exist_ok=True)
        (generation_root / "package.json").write_bytes(package_payload)
        composite, overlay_file_count = composite_source_export(repository, viewer_head)
        write_blobs(source_export, composite)
        (source_export / "package.json").write_bytes(
            blob(repository, BASE_VIEWER_COMMIT, PurePosixPath("package.json"))
        )

        for name in (
            "02-presentation-measurement",
            "04-p2-student",
            "05-p2-student-professional",
        ):
            (generation_root / "artifacts" / name).mkdir(parents=True)

        builder, builder_diff = adapt_builder(repository, generation_root, viewer_head)
        result = subprocess.run(
            [sys.executable, str(builder), str(generation_root)],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        (evidence_root / "builder.stdout.txt").write_text(result.stdout, encoding="utf-8")
        (evidence_root / "builder.stderr.txt").write_text(result.stderr, encoding="utf-8")
        if result.returncode != 0:
            raise CurrentBuildError(f"current product builder failed with exit {result.returncode}")

        candidate = verify_candidate(repository, generation_root, viewer_head)
        if sha256((repository / BUILDER_RELATIVE).read_bytes()) != BUILDER_SHA256:
            raise CurrentBuildError("tracked recovered builder changed during current build")
        summary = {
            "result": "PASS",
            "evidence_root": str(evidence_root),
            "viewer_source_commit": viewer_head,
            "d2b_authority_commit": D2B_AUTHORITY_COMMIT,
            "d2b_reference_tree_oid": D2B_REFERENCE_TREE_OID,
            "observed_d2b_reference_tree_oid": observed_d2b_reference_tree_oid,
            "historical_source_export_base": BASE_VIEWER_COMMIT,
            "recovered_builder_sha256": BUILDER_SHA256,
            "builder_adapter_changed_constants": [
                "EXPECTED_ROOT",
                "VIEWER_COMMIT",
                "D2B_COMMIT",
                "PROTOTYPE_ALLOWLIST",
                "GRAPH_SOURCE",
            ],
            "builder_adapter_diff_sha256": sha256(builder_diff.encode("utf-8")),
            "current_product_allowlist": sorted(CURRENT_PRODUCT_ALLOWLIST),
            "current_product_file_count": len(observed_current_product_files),
            "d2b_overlay_file_count": overlay_file_count,
            "candidate": candidate,
        }
        (evidence_root / "current-product-summary.json").write_text(
            json.dumps(summary, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(json.dumps(summary, sort_keys=True))
        return 0
    except (
        CurrentBuildError,
        OSError,
        UnicodeDecodeError,
        ValueError,
        KeyError,
        json.JSONDecodeError,
        subprocess.SubprocessError,
    ) as error:
        print(
            json.dumps(
                {
                    "result": "FAIL",
                    "error": str(error),
                    "evidence_root": str(evidence_root) if evidence_root else None,
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
