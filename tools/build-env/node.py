#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Kenta IDA <fuga@fugafuga.org>
# SPDX-License-Identifier: BSL-1.0
"""Install/check the project-local Node runtime or run a command in its environment."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
CONFIG = Path(__file__).with_name("node-toolchain.json")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch(url, destination):
    with urllib.request.urlopen(url, timeout=60) as response:
        with destination.open("xb") as output:
            while block := response.read(1024 * 1024):
                output.write(block)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "check", "exec"])
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    config = json.loads(CONFIG.read_text())
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "AMD64"):
        raise ValueError("This runtime path is qualified only on Linux x64")
    archive = config["platforms"]["linux-x64"]
    runtime = ROOT / ".tools" / archive["archive"].removesuffix(".tar.xz")
    if args.action == "install":
        if runtime.exists():
            raise ValueError("Runtime already exists; use check or a fresh worktree, never overwrite")
        (ROOT / ".tools").mkdir(exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix="node-download-", dir=ROOT / ".tools"))
        package = staging / archive["archive"]
        keyring = staging / "pubring.kbx"
        signature = staging / "SHASUMS256.txt.asc"
        verified = staging / "SHASUMS256.verified.txt"
        fetch(config["verification"]["keyring_url"], keyring)
        if digest(keyring) != config["verification"]["keyring_sha256"]:
            raise ValueError("Release keyring changed; review the verification input before updating")
        fetch(archive["url"].rsplit("/", 1)[0] + "/SHASUMS256.txt.asc", signature)
        with signature.open("rb") as signed:
            subprocess.run(["gpgv", "--keyring", str(keyring), "--output", str(verified)],
                           stdin=signed, check=True)
        checksums = dict(line.split(maxsplit=1)[::-1]
                         for line in verified.read_text().splitlines() if line.strip())
        if checksums.get(archive["archive"]) != archive["sha256"]:
            raise ValueError("Signed archive checksum differs from the reviewed setting")
        fetch(archive["url"], package)
        if digest(package) != archive["sha256"]:
            raise ValueError("Archive checksum mismatch")
        with tarfile.open(package) as source:
            source.extractall(ROOT / ".tools", filter="data")
    node = runtime / "bin/node"
    npm = runtime / "lib/node_modules/npm/bin/npm-cli.js"
    environment = os.environ.copy()
    environment["PATH"] = str(runtime / "bin") + os.pathsep + environment.get("PATH", "")
    observed_node = subprocess.check_output([str(node), "--version"], text=True).strip()
    observed_npm = subprocess.check_output([str(node), str(npm), "--version"],
                                           env=environment, text=True).strip()
    if observed_node != "v" + config["node"] or observed_npm != config["npm"]:
        raise ValueError("Node/npm runtime does not match node-toolchain.json")
    if args.action == "exec":
        command = args.command
        if command[:1] == ["--"]:
            command = command[1:]
        if not command:
            raise ValueError("exec requires a command")
        return subprocess.run(command, env=environment, check=False).returncode
    print(json.dumps({"node": observed_node, "npm": observed_npm,
                      "qualified_uses": config["qualified_uses"]}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError, tarfile.TarError) as error:
        raise SystemExit(f"Node toolchain unavailable: {error}") from error
