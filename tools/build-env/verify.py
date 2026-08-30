#!/usr/bin/env python3
"""Fail-closed checks for the qualified Viewer build environment and outputs."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PROVENANCE_PATH = ROOT / "docs/provenance/build-environment-v1.json"
DOCKERFILE_PATH = ROOT / "tools/build-env/Dockerfile"


class VerificationError(RuntimeError):
    pass


def load_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise VerificationError(f"expected JSON object: {path}")
    return value


def provenance() -> dict:
    return load_json(PROVENANCE_PATH)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(condition: bool, detail: str) -> None:
    if not condition:
        raise VerificationError(detail)


def verify_provenance() -> None:
    authority = provenance()
    require(authority.get("schema") == 1, "unsupported provenance schema")
    expected = authority["build_environment"]["dockerfile_sha256"]
    observed = sha256(DOCKERFILE_PATH)
    require(observed == expected, f"Dockerfile SHA-256 mismatch: {observed}")
    print("REPRO_BUILD_PROVENANCE_PASS")


def parse_inventory(path: Path) -> tuple[dict[str, str], dict[str, tuple[str, str]]]:
    fields: dict[str, str] = {}
    packages: dict[str, tuple[str, str]] = {}
    in_packages = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if line == "dpkg_inventory_begin":
            in_packages = True
            continue
        if line == "dpkg_inventory_end":
            in_packages = False
            continue
        if in_packages:
            parts = line.split("\t")
            require(len(parts) == 3, f"invalid dpkg inventory row: {line!r}")
            packages[parts[0]] = (parts[1], parts[2])
        elif "=" in line:
            key, value = line.split("=", 1)
            fields[key] = value
    return fields, packages


def verify_inventory(path: Path) -> None:
    authority = provenance()
    fields, packages = parse_inventory(path)
    for key, expected in authority["toolchain"].items():
        observed = fields.get(key)
        require(observed == expected, f"inventory mismatch for {key}: {observed!r}")
    for package, expected in authority["relevant_dpkg_packages"].items():
        observed = packages.get(package)
        require(observed == (expected["version"], expected["architecture"]),
                f"dpkg mismatch for {package}: {observed!r}")
    print("REPRO_BUILD_TOOLCHAIN_IDENTITY_PASS")


def verified_summary(authority_name: str, summary_path: Path) -> dict:
    authority = provenance()[authority_name]
    summary = load_json(summary_path)
    candidate = summary.get("candidate")
    require(isinstance(candidate, dict), "summary candidate is missing")
    require(summary.get("result") == "PASS", "builder summary result is not PASS")
    require(summary.get("viewer_source_commit") == authority["source"]["commit"],
            "Viewer source commit mismatch")
    require(summary.get("d2b_reference_tree_oid") == authority["d2b_reference_tree_oid"],
            "D2B authority tree mismatch")
    require(summary.get("observed_d2b_reference_tree_oid") == authority["d2b_reference_tree_oid"],
            "observed D2B tree mismatch")
    require(summary.get("recovered_builder_sha256") == authority["recovered_builder_sha256"],
            "recovered builder identity mismatch")

    expected = authority["product"]
    comparisons = {
        "bundle_id": candidate.get("bundle_id"),
        "index": candidate.get("index"),
        "manifest": candidate.get("manifest"),
        "css_gzip": candidate.get("css_gzip"),
        "js_gzip": candidate.get("js_gzip"),
        "stored_bytes": candidate.get("stored_bytes"),
        "two_run_determinism": candidate.get("two_run_determinism"),
    }
    for key, observed in comparisons.items():
        require(observed == expected[key], f"{authority_name} mismatch for {key}: {observed!r}")

    stable = {
        "authority": authority_name,
        "source_commit": authority["source"]["commit"],
        "source_tree": authority["source"]["tree"],
        "bundle_id": candidate["bundle_id"],
        "index": candidate["index"],
        "manifest": candidate["manifest"],
        "css_gzip": candidate["css_gzip"],
        "js_gzip": candidate["js_gzip"],
        "stored_bytes": candidate["stored_bytes"],
        "two_run_determinism": candidate["two_run_determinism"],
    }
    return stable


def verify_summary(authority_name: str, summary_path: Path) -> None:
    stable = verified_summary(authority_name, summary_path)
    print("REPRO_BUILD_CURRENT_PRODUCT_PASS")
    print("REPRO_BUILD_SUMMARY_JSON=" + json.dumps(stable, sort_keys=True, separators=(",", ":")))


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("provenance")
    inventory_parser = subparsers.add_parser("inventory")
    inventory_parser.add_argument("path", type=Path)
    summary_parser = subparsers.add_parser("summary")
    summary_parser.add_argument("authority", choices=("pr11", "pr12"))
    summary_parser.add_argument("path", type=Path)
    args = parser.parse_args()

    try:
        if args.command == "provenance":
            verify_provenance()
        elif args.command == "inventory":
            verify_inventory(args.path)
        else:
            verify_summary(args.authority, args.path)
    except (KeyError, OSError, ValueError, VerificationError) as error:
        print(f"REPRO_BUILD_VERIFY_FAIL: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
