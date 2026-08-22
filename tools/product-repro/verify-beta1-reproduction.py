#!/usr/bin/env python3
"""Reproduce and verify the accepted beta.1 device-hosted Viewer bundle."""

from __future__ import annotations

import difflib
import gzip
import hashlib
import io
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath


QUALIFIED_PRODUCT_COMMIT = "105bca2616ef372fe23ac0797f58b5c7383ee20c"
SOURCE_EXPORT_COMMIT = "80a9cd308cb3c6c5a1ccc27241cd645803675921"
D2B_AUTHORITY_COMMIT = "5411ba59a12882345d32218eda367bd6ba35ef5d"
BUILDER_SHA256 = "616e1e4aff16d21b49f4d0b8f3c8bda46a5f47ad09d4a2eb9a0b0227ca06c5aa"
BUILDER_LINES = 368
ACCEPTED_BUNDLE_ID = "cbcbd7eab111b49c0c6119b22a7f50ae55981933fd799abfd98d92d0dc5d96e5"
CSS_GIT_BLOB_SHA256 = "4801cc833dc751d8ddc78b3c8e37a27d7744cbe1932e3aad6bbed64075282a34"
CSS_HISTORICAL_INPUT_SHA256 = "9307bb0aefc010bb5ad00d22fa596b19341061782f91806a5918df6b79363f93"
IDENTITY_RELATIVE = Path("docs/provenance/beta1-accepted-viewer-identity.json")
BUILDER_RELATIVE = Path("tools/p2-builder/p2-builder.py")


class VerificationError(RuntimeError):
    """Raised when an exact historical reproduction check fails."""


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
        raise VerificationError(f"git {' '.join(arguments)} failed: {detail}")
    return result.stdout


def repository_root() -> Path:
    candidate = Path(__file__).resolve().parents[2]
    root = Path(run_git(candidate, "rev-parse", "--show-toplevel").decode().strip()).resolve()
    if root != candidate:
        raise VerificationError("tool must run from its own Device-to-Browser-Viewer repository")
    return root


def verify_commit(repository: Path, commit: str) -> None:
    resolved = run_git(repository, "rev-parse", "--verify", f"{commit}^{{commit}}").decode().strip()
    if resolved != commit:
        raise VerificationError(f"Git commit did not resolve exactly: {commit}")


def tree_entries(
    repository: Path, commit: str, prefix: PurePosixPath
) -> list[tuple[PurePosixPath, str, bytes]]:
    output = run_git(repository, "ls-tree", "-r", "-z", commit, "--", prefix.as_posix())
    entries: list[tuple[PurePosixPath, str, bytes]] = []
    for record in output.split(b"\0"):
        if not record:
            continue
        metadata, separator, encoded_path = record.partition(b"\t")
        if not separator:
            raise VerificationError("unexpected git ls-tree record")
        fields = metadata.decode("ascii").split()
        if len(fields) != 3:
            raise VerificationError("unexpected git ls-tree metadata")
        mode, object_type, object_id = fields
        if mode != "100644" or object_type != "blob":
            raise VerificationError(
                f"unsupported Git entry mode/type {mode} {object_type}: "
                f"{encoded_path.decode('utf-8', errors='replace')}"
            )
        try:
            path = PurePosixPath(encoded_path.decode("utf-8"))
            relative = path.relative_to(prefix)
        except (UnicodeDecodeError, ValueError) as error:
            raise VerificationError("invalid Git tree path") from error
        if not relative.parts or any(part in ("", ".", "..") for part in relative.parts):
            raise VerificationError(f"unsafe Git tree path: {relative}")
        payload = run_git(repository, "cat-file", "blob", object_id)
        entries.append((relative, object_id, payload))
    if not entries:
        raise VerificationError(f"Git tree is empty: {commit}:{prefix}")
    return entries


def blob(repository: Path, commit: str, path: PurePosixPath) -> bytes:
    output = run_git(repository, "ls-tree", "-z", commit, "--", path.as_posix())
    records = [record for record in output.split(b"\0") if record]
    if len(records) != 1:
        raise VerificationError(f"expected exactly one Git blob: {commit}:{path}")
    metadata, separator, encoded_path = records[0].partition(b"\t")
    fields = metadata.decode("ascii").split()
    if not separator or len(fields) != 3 or encoded_path.decode("utf-8") != path.as_posix():
        raise VerificationError(f"unexpected Git blob record: {commit}:{path}")
    mode, object_type, object_id = fields
    if mode != "100644" or object_type != "blob":
        raise VerificationError(f"unsupported Git blob mode/type: {commit}:{path}")
    return run_git(repository, "cat-file", "blob", object_id)


def materialize_tree(
    repository: Path, commit: str, prefix: PurePosixPath, destination: Path
) -> None:
    for relative, _, payload in tree_entries(repository, commit, prefix):
        output = destination.joinpath(*relative.parts)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(payload)
        output.chmod(0o644)


def write_blob(
    repository: Path, commit: str, source: PurePosixPath, destination: Path
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(blob(repository, commit, source))
    destination.chmod(0o644)


def load_identity(repository: Path) -> dict[str, object]:
    identity = json.loads((repository / IDENTITY_RELATIVE).read_text(encoding="utf-8"))
    exact_fields = {
        "qualified_product_source_commit": QUALIFIED_PRODUCT_COMMIT,
        "frozen_source_export_commit": SOURCE_EXPORT_COMMIT,
        "d2b_authority_commit": D2B_AUTHORITY_COMMIT,
        "historical_builder_sha256": BUILDER_SHA256,
        "historical_builder_lines": BUILDER_LINES,
    }
    for key, expected in exact_fields.items():
        if identity.get(key) != expected:
            raise VerificationError(f"accepted identity authority mismatch: {key}")
    bundle = identity.get("bundle")
    if not isinstance(bundle, dict) or bundle.get("viewer_bundle_id") != ACCEPTED_BUNDLE_ID:
        raise VerificationError("accepted Viewer bundle ID snapshot mismatch")
    return identity


def verify_toolchain(identity: dict[str, object]) -> dict[str, str]:
    expected = identity.get("historical_toolchain")
    if not isinstance(expected, dict):
        raise VerificationError("historical toolchain snapshot is missing")
    node = Path(str(expected.get("node_path", "")))
    if node != Path("/usr/bin/node") or not node.is_file():
        raise VerificationError("/usr/bin/node is unavailable")
    probe = (
        'process.stdout.write(JSON.stringify({'
        'node:process.version,'
        'webpack:require("webpack/package.json").version,'
        'terser_webpack_plugin:require("terser-webpack-plugin/package.json").version}))'
    )
    result = subprocess.run(
        [str(node), "-e", probe],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        raise VerificationError(f"historical Node toolchain probe failed: {result.stderr.strip()}")
    observed = json.loads(result.stdout)
    if observed.get("webpack") != expected.get("webpack_version"):
        raise VerificationError(f"webpack version mismatch: {observed.get('webpack')}")
    if observed.get("terser_webpack_plugin") != expected.get("terser_webpack_plugin_version"):
        raise VerificationError(
            f"terser-webpack-plugin version mismatch: {observed.get('terser_webpack_plugin')}"
        )
    return {
        "python": sys.version.split()[0],
        "node": str(observed["node"]),
        "webpack": str(observed["webpack"]),
        "terser-webpack-plugin": str(observed["terser_webpack_plugin"]),
    }


def deterministic_gzip(payload: bytes) -> bytes:
    output = io.BytesIO()
    with gzip.GzipFile(
        filename="", mode="wb", fileobj=output, compresslevel=9, mtime=0
    ) as stream:
        stream.write(payload)
    compressed = output.getvalue()
    if gzip.decompress(compressed) != payload:
        raise VerificationError("deterministic gzip round-trip failed")
    return compressed


def adapt_historical_css(prototype: Path, identity: dict[str, object]) -> dict[str, object]:
    rules = identity.get("historical_css_representation")
    if not isinstance(rules, dict):
        raise VerificationError("historical CSS representation snapshot is missing")
    css_path = prototype / "app.css"
    original = css_path.read_bytes()
    checks = {
        "path": "src/product/p2-sp/app.css",
        "git_blob_bytes": 1686,
        "git_blob_sha256": CSS_GIT_BLOB_SHA256,
        "git_blob_lf_count": 32,
        "git_blob_crlf_count": 0,
        "historical_input_bytes": 1718,
        "historical_input_sha256": CSS_HISTORICAL_INPUT_SHA256,
        "transform": "LF_TO_CRLF_ONLY_FOR_HISTORICAL_BETA1_REPRODUCTION",
        "reverse_byte_equivalence_required": True,
    }
    for key, expected in checks.items():
        if rules.get(key) != expected:
            raise VerificationError(f"historical CSS snapshot mismatch: {key}")
    if len(original) != 1686 or sha256(original) != CSS_GIT_BLOB_SHA256:
        raise VerificationError("qualified app.css Git blob identity mismatch")
    if original.count(b"\n") != 32 or original.count(b"\r\n") != 0:
        raise VerificationError("qualified app.css line-ending precondition mismatch")

    historical = original.replace(b"\n", b"\r\n")
    if historical.replace(b"\r\n", b"\n") != original:
        raise VerificationError("historical app.css reverse-byte-equivalence failed")
    if len(historical) != 1718 or sha256(historical) != CSS_HISTORICAL_INPUT_SHA256:
        raise VerificationError("historical app.css representation identity mismatch")

    bundle = identity.get("bundle")
    if not isinstance(bundle, dict):
        raise VerificationError("accepted bundle snapshot is missing")
    css_bundle = bundle.get("css_gzip")
    if not isinstance(css_bundle, dict):
        raise VerificationError("accepted CSS gzip identity is missing")
    compressed = deterministic_gzip(historical)
    if len(compressed) != css_bundle.get("bytes") or sha256(compressed) != css_bundle.get("sha256"):
        raise VerificationError("historical app.css deterministic gzip identity mismatch")

    css_path.write_bytes(historical)
    return {
        "git_blob_bytes": len(original),
        "git_blob_sha256": sha256(original),
        "git_blob_lf_count": original.count(b"\n"),
        "git_blob_crlf_count": original.count(b"\r\n"),
        "historical_input_bytes": len(historical),
        "historical_input_sha256": sha256(historical),
        "transform": str(rules["transform"]),
        "reverse_byte_equivalence": "PASS",
        "historical_gzip_bytes": len(compressed),
        "historical_gzip_sha256": sha256(compressed),
    }


def adapt_builder(repository: Path, reproduction_root: Path) -> tuple[Path, str]:
    tracked_path = repository / BUILDER_RELATIVE
    original = tracked_path.read_bytes()
    if sha256(original) != BUILDER_SHA256 or original.count(b"\n") != BUILDER_LINES:
        raise VerificationError("tracked historical builder identity mismatch")
    text = original.decode("utf-8")
    pattern = re.compile(r'^EXPECTED_ROOT = Path\([^\r\n]+\)$', re.MULTILINE)
    matches = list(pattern.finditer(text))
    if len(matches) != 1:
        raise VerificationError("historical builder EXPECTED_ROOT occurrence count mismatch")
    original_line = matches[0].group(0)
    replacement = f"EXPECTED_ROOT = Path({str(reproduction_root)!r})"
    adapted = text[: matches[0].start()] + replacement + text[matches[0].end() :]
    restored = adapted.replace(replacement, original_line, 1)
    if restored.encode("utf-8") != original:
        raise VerificationError("historical builder adapter changed more than EXPECTED_ROOT")

    destination = reproduction_root / "p2-builder.py"
    destination.write_text(adapted, encoding="utf-8", newline="")
    diff = "".join(
        difflib.unified_diff(
            text.splitlines(keepends=True),
            adapted.splitlines(keepends=True),
            fromfile=BUILDER_RELATIVE.as_posix(),
            tofile="disposable/p2-builder.py",
        )
    )
    (reproduction_root / "p2-builder.diff").write_text(diff, encoding="utf-8")
    return destination, diff


def verify_output(reproduction_root: Path, identity: dict[str, object]) -> dict[str, object]:
    artifact = reproduction_root / "artifacts/05-p2-student-professional"
    bundle = identity.get("bundle")
    if not isinstance(bundle, dict):
        raise VerificationError("accepted bundle snapshot is missing")
    actual_bundle_id = (artifact / "viewer-bundle-id.txt").read_text(encoding="utf-8").strip()
    if actual_bundle_id != bundle.get("viewer_bundle_id"):
        raise VerificationError(
            f"Viewer bundle ID mismatch expected={bundle.get('viewer_bundle_id')} "
            f"actual={actual_bundle_id}"
        )

    compared: dict[str, dict[str, object]] = {}
    stored_bytes = 0
    for role in ("entry_html", "asset_manifest", "css_gzip", "js_gzip"):
        expected = bundle.get(role)
        if not isinstance(expected, dict):
            raise VerificationError(f"accepted bundle role is missing: {role}")
        relative = PurePosixPath(str(expected.get("path", "")))
        if not relative.parts or any(part in ("", ".", "..") for part in relative.parts):
            raise VerificationError(f"unsafe accepted bundle path: {role}")
        path = artifact.joinpath(*relative.parts)
        payload = path.read_bytes()
        observed = {"bytes": len(payload), "sha256": sha256(payload), "path": relative.as_posix()}
        if observed["bytes"] != expected.get("bytes") or observed["sha256"] != expected.get("sha256"):
            raise VerificationError(
                f"accepted bundle role mismatch {role}: expected={expected} actual={observed}"
            )
        compared[role] = observed
        stored_bytes += len(payload)

    if stored_bytes != bundle.get("stored_bytes"):
        raise VerificationError(
            f"stored payload byte mismatch expected={bundle.get('stored_bytes')} actual={stored_bytes}"
        )
    if compared["asset_manifest"]["sha256"] != actual_bundle_id:
        raise VerificationError("manifest SHA-256 does not equal Viewer bundle ID")

    raw_css = (artifact / "raw/app.css").read_bytes()
    if len(raw_css) != 1718 or sha256(raw_css) != CSS_HISTORICAL_INPUT_SHA256:
        raise VerificationError("builder raw app.css did not retain historical representation")
    determinism = (artifact / "determinism-compare.txt").read_text(encoding="utf-8")
    if "P2 deterministic comparison=PASS" not in determinism:
        raise VerificationError("historical builder two-run determinism marker missing")
    return {
        "viewer_bundle_id": actual_bundle_id,
        "stored_bytes": stored_bytes,
        "representations": compared,
        "builder_two_run_determinism": "PASS",
    }


def main() -> int:
    evidence_root: Path | None = None
    try:
        repository = repository_root()
        identity = load_identity(repository)
        for commit in (QUALIFIED_PRODUCT_COMMIT, SOURCE_EXPORT_COMMIT):
            verify_commit(repository, commit)
        toolchain = verify_toolchain(identity)

        evidence_root = Path(tempfile.mkdtemp(prefix="device-to-browser-viewer-beta1-repro-"))
        reproduction = evidence_root / "viewer"
        prototype = reproduction / "prototype"
        source_export = reproduction / "source-export/viewer"
        materialize_tree(
            repository, QUALIFIED_PRODUCT_COMMIT, PurePosixPath("src/product/p2-sp"), prototype
        )
        write_blob(
            repository,
            QUALIFIED_PRODUCT_COMMIT,
            PurePosixPath("package.json"),
            reproduction / "package.json",
        )
        materialize_tree(
            repository, SOURCE_EXPORT_COMMIT, PurePosixPath("src"), source_export / "src"
        )
        write_blob(
            repository,
            SOURCE_EXPORT_COMMIT,
            PurePosixPath("package.json"),
            source_export / "package.json",
        )

        css_proof = adapt_historical_css(prototype, identity)
        builder, builder_diff = adapt_builder(repository, reproduction)
        removed = [
            line for line in builder_diff.splitlines()
            if line.startswith("-") and not line.startswith("---")
        ]
        added = [
            line for line in builder_diff.splitlines()
            if line.startswith("+") and not line.startswith("+++")
        ]
        if len(removed) != 1 or len(added) != 1:
            raise VerificationError("historical builder diff is not exactly one replaced line")
        for name in (
            "02-presentation-measurement",
            "04-p2-student",
            "05-p2-student-professional",
        ):
            (reproduction / "artifacts" / name).mkdir(parents=True)

        result = subprocess.run(
            [sys.executable, str(builder), str(reproduction)],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        (evidence_root / "builder.stdout.txt").write_text(result.stdout, encoding="utf-8")
        (evidence_root / "builder.stderr.txt").write_text(result.stderr, encoding="utf-8")
        if result.returncode != 0:
            raise VerificationError(f"historical builder failed with exit {result.returncode}")

        bundle = verify_output(reproduction, identity)
        tracked_builder = (repository / BUILDER_RELATIVE).read_bytes()
        if sha256(tracked_builder) != BUILDER_SHA256:
            raise VerificationError("tracked historical builder changed during verification")

        summary = {
            "result": "PASS",
            "evidence_root": str(evidence_root),
            "authorities": {
                "qualified_product_source_commit": QUALIFIED_PRODUCT_COMMIT,
                "frozen_source_export_commit": SOURCE_EXPORT_COMMIT,
                "d2b_authority_commit": D2B_AUTHORITY_COMMIT,
                "historical_builder_sha256": BUILDER_SHA256,
            },
            "toolchain": toolchain,
            "historical_css_representation": css_proof,
            "bundle": bundle,
            "gates": {
                "R1R_CSS_REPRESENTATION_CAUSE_PROVEN": "YES",
                "R1R_H1_SOURCE_EXPORT_PROVEN": "YES",
                "R1R_H2_CSS_HISTORICAL_REPRESENTATION_PROVEN": "YES",
                "R1R_BETA1_BUNDLE_IDENTITY_EXACT": "YES",
                "R1R_HISTORICAL_BUILDER_TRACKED_BYTES_UNCHANGED": "YES",
            },
        }
        (evidence_root / "verification-summary.json").write_text(
            json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        print(json.dumps(summary, sort_keys=True))
        return 0
    except (
        VerificationError,
        OSError,
        UnicodeDecodeError,
        ValueError,
        KeyError,
        subprocess.SubprocessError,
    ) as error:
        failure = {
            "result": "FAIL",
            "error": str(error),
            "evidence_root": str(evidence_root) if evidence_root else None,
        }
        print(json.dumps(failure, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
