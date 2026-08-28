#!/usr/bin/env python3
"""Stage a compact, checksum-sealed CI review evidence package."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = ROOT / "tools/build-env/Dockerfile"
PROVENANCE = ROOT / "docs/provenance/build-environment-v1.json"


class StageError(RuntimeError):
    pass


def require(condition: bool, detail: str) -> None:
    if not condition:
        raise StageError(detail)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"expected JSON object: {path}")
    return value


def one(root: Path, pattern: str) -> Path:
    matches = sorted(root.glob(pattern))
    require(len(matches) == 1, f"expected one {pattern!r}, found {len(matches)}")
    path = matches[0]
    require(path.is_file() and not path.is_symlink(), f"not a regular file: {path}")
    return path


def copy_regular(source: Path, destination: Path) -> None:
    require(source.is_file() and not source.is_symlink(), f"not a regular file: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    require(not destination.exists(), f"destination collision: {destination}")
    shutil.copyfile(source, destination)


def write_text(destination: Path, payload: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    require(not destination.exists(), f"destination collision: {destination}")
    destination.write_text(payload, encoding="utf-8", newline="\n")


def write_json(destination: Path, value: dict) -> None:
    write_text(destination, json.dumps(value, indent=2, sort_keys=True) + "\n")


def stage(args: argparse.Namespace) -> None:
    evidence = args.evidence_root.resolve()
    output = args.output.resolve()
    require(evidence.is_dir() and not evidence.is_symlink(), "invalid evidence root")
    require(not output.exists(), f"output already exists: {output}")
    output.mkdir(parents=True)

    provenance = load_json(PROVENANCE)
    dockerfile_sha256 = sha256(DOCKERFILE)
    expected_dockerfile = provenance["build_environment"]["dockerfile_sha256"]
    require(dockerfile_sha256 == expected_dockerfile, "Dockerfile authority mismatch")

    beta_summary = one(evidence, "beta1/*/verification-summary.json")
    pr11_summary = one(evidence, "pr11/*/current-product-summary.json")
    pr12_summary = one(evidence, "pr12/*/current-product-summary.json")
    pr12_value = load_json(pr12_summary)
    pr12_candidate = pr12_value.get("candidate")
    require(isinstance(pr12_candidate, dict), "PR12 candidate summary missing")

    run_authority = {
        "schema": 1,
        "artifact": {
            "name": f"viewer-repro-build-evidence-{args.run_id}",
            "retention_days": 30,
            "role": "evidence transport / retention",
        },
        "workflow": {
            "run_id": int(args.run_id),
            "run_attempt": int(args.run_attempt),
            "name": args.workflow,
            "head_sha": args.head_sha,
            "repository": args.repository,
            "ref": args.ref,
        },
        "build_environment": {
            "dockerfile_sha256": dockerfile_sha256,
            "base_image": provenance["build_environment"]["base_image"],
            "qualified_image_digest": provenance["build_environment"]["qualified_image_digest"],
            "observed_ci_image_id": args.image_id,
            "architecture": args.architecture,
        },
        "authority_boundary": {
            "github_artifact": "evidence transport / retention",
            "internal_sha256sums": "artifact-content integrity",
            "tracked_provenance": "expected authority",
            "exact_viewer_representations": "built-byte authority",
        },
    }
    write_json(output / "authority/run.json", run_authority)
    copy_regular(DOCKERFILE, output / "authority/Dockerfile")
    copy_regular(PROVENANCE, output / "authority/build-environment-v1.json")
    write_text(output / "authority/Dockerfile.sha256", f"{dockerfile_sha256}  Dockerfile\n")

    copy_regular(evidence / "toolchain/inventory.txt", output / "toolchain/inventory.txt")

    groups = {
        "beta1": beta_summary,
        "pr11": pr11_summary,
        "pr12": pr12_summary,
    }
    summary_names = {
        "beta1": "verification-summary.json",
        "pr11": "current-product-summary.json",
        "pr12": "current-product-summary.json",
    }
    for name, summary in groups.items():
        copy_regular(summary, output / name / summary_names[name])
        copy_regular(summary.parent / "builder.stdout.txt", output / name / "builder.stdout.txt")
        copy_regular(summary.parent / "builder.stderr.txt", output / name / "builder.stderr.txt")
        copy_regular(evidence / f"{name}-run.txt", output / name / "run.txt")

    copy_regular(
        evidence / "pr11-verified-summary.txt",
        output / "pr11/verified-summary.txt",
    )
    copy_regular(
        evidence / "pr12-verified-summary.txt",
        output / "pr12/verified-summary.txt",
    )

    artifact_root = pr12_summary.parent / "viewer/artifacts/05-p2-student-professional"
    served = artifact_root / "served"
    representation_keys = ("index", "manifest", "css_gzip", "js_gzip")
    for key in representation_keys:
        value = pr12_candidate.get(key)
        require(isinstance(value, dict), f"PR12 {key} summary missing")
        relative = Path(value["path"])
        require(relative.name == str(relative), f"unsafe PR12 representation path: {relative}")
        served_relative = relative if key in ("index", "manifest") else Path("assets") / relative
        copy_regular(served / served_relative, output / "pr12/served" / served_relative)
    copy_regular(
        artifact_root / "viewer-bundle-id.txt",
        output / "pr12/viewer-bundle-id.txt",
    )

    write_text(
        output / "README.txt",
        "Viewer reproducible-build CI review evidence\n"
        "\n"
        "GitHub Actions Artifact is evidence transport with 30-day retention.\n"
        "It is not permanent archival storage and its ZIP identity is not a Viewer authority.\n"
        "The files inside this directory and SHA256SUMS provide content integrity.\n"
        "Tracked build-environment-v1.json provides expected authority.\n"
        "The exact files under pr12/served provide built-byte authority.\n"
        "\n"
        "Verify from this directory with: sha256sum -c SHA256SUMS\n",
    )

    files = sorted(
        path for path in output.rglob("*")
        if path.is_file() and path.name != "SHA256SUMS"
    )
    require(files, "staged evidence is empty")
    manifest_lines = []
    for path in files:
        require(not path.is_symlink(), f"symlink in staged evidence: {path}")
        relative = path.relative_to(output).as_posix()
        manifest_lines.append(f"{sha256(path)}  {relative}\n")
    write_text(output / "SHA256SUMS", "".join(manifest_lines))

    for line in manifest_lines:
        expected, relative = line.rstrip("\n").split("  ", 1)
        require(sha256(output / relative) == expected, f"checksum mismatch: {relative}")

    print(json.dumps({
        "artifact_name": run_authority["artifact"]["name"],
        "file_count": len(files),
        "pr12_bundle_id": pr12_candidate.get("bundle_id"),
        "result": "CI_EVIDENCE_STAGING_PASS",
        "sha256sums_sha256": sha256(output / "SHA256SUMS"),
    }, sort_keys=True))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--ref", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-attempt", required=True)
    parser.add_argument("--workflow", required=True)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--image-id", required=True)
    parser.add_argument("--architecture", default="linux/amd64")
    args = parser.parse_args()
    try:
        stage(args)
    except (KeyError, OSError, ValueError, StageError) as error:
        print(f"CI_EVIDENCE_STAGING_FAIL: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
