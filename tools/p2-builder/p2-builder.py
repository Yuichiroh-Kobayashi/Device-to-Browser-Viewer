#!/usr/bin/env python3
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

EXPECTED_ROOT = Path("/home/yu-ichirou/LabData/VAMeter-Edu/20260814-1407-g1-ms-r2/viewer")
VIEWER_COMMIT = "80a9cd308cb3c6c5a1ccc27241cd645803675921"
D2B_COMMIT = "5411ba59a12882345d32218eda367bd6ba35ef5d"
P1_STUDENT = (
    "index.html", "app.css", "app.js", "runtime-owner.js",
    "presentation/mode-controller.js", "presentation/student-view.js",
    "presentation/view-state.js", "presentation/deployment-context.js",
    "graph/autoscale-policy.js",
)
P1_PROFESSIONAL = P1_STUDENT + ("presentation/professional-view.js",)
PROTOTYPE_ALLOWLIST = frozenset(P1_PROFESSIONAL + (
    "tests/one-runtime.test.mjs", "tests/lifecycle-ui.test.mjs",
    "tests/autoscale-policy.test.mjs", "tests/deployment-context.test.mjs",
    "tests/responsive-static.test.mjs", "README.measurement.md",
))
MIME_HTML = "text/html; charset=utf-8"
MIME_CSS = "text/css; charset=utf-8"
MIME_JS = "application/javascript; charset=utf-8"

NODE_DRIVER = r'''
"use strict";
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const webpack = require("webpack");
const TerserPlugin = require("terser-webpack-plugin");
const entry = path.resolve(process.argv[2]);
const outputPath = path.resolve(process.argv[3]);
const includeProfessional = process.argv[4] === "1";
const HELPERS_SHIM = `export const DEFAULT_VI_PARAMETERS = Object.freeze({sample_format:"vi-f32le",channel_count:2,channel_mask:3,sample_rate:Object.freeze({numerator:0,denominator:0})});\nexport function makeHelloText() { return JSON.stringify({type:"hello",protocol:"d2b-stream",versions:["0.1"],client_name:"d2b-viewer-prototype"}); }\n`;

(async () => {
  if (require("webpack/package.json").version !== "5.76.1") throw new Error("webpack version mismatch");
  fs.mkdirSync(outputPath, { recursive: true });
  const frozenHelpers = path.resolve(path.dirname(entry), "../source-export/viewer/src/sources/synthetic-source.js");
  const shimPath = path.resolve(outputPath, "..", "g1-websocket-helpers-shim.mjs");
  fs.writeFileSync(shimPath, HELPERS_SHIM, "utf8");
  const frozen = await import(pathToFileURL(frozenHelpers).href);
  const shim = await import(pathToFileURL(shimPath).href);
  if (JSON.stringify(frozen.DEFAULT_VI_PARAMETERS) !== JSON.stringify(shim.DEFAULT_VI_PARAMETERS) || frozen.makeHelloText() !== shim.makeHelloText()) {
    throw new Error("websocket helpers shim differs from frozen exports");
  }
  console.log("PASS websocket helpers shim equivalence against frozen exports");
  const config = {
    mode: "production", target: ["web", "es2020"], context: path.dirname(entry), entry,
    devtool: false, cache: false, performance: false,
    infrastructureLogging: { level: "error" }, stats: "errors-warnings",
    output: { path: outputPath, filename: "app.js", pathinfo: false, hashFunction: "sha256", clean: false },
    plugins: [
      new webpack.NormalModuleReplacementPlugin(/synthetic-source\.js$/, shimPath),
      new webpack.DefinePlugin({
        __DEPLOYMENT_TARGET__: JSON.stringify("device-hosted"),
        __INCLUDE_PROFESSIONAL__: includeProfessional ? "true" : "false",
      }),
    ],
    optimization: {
      minimize: true, moduleIds: "deterministic", chunkIds: "deterministic",
      mangleExports: "deterministic", concatenateModules: true,
      splitChunks: false, runtimeChunk: false,
      minimizer: [new TerserPlugin({ extractComments: false, terserOptions: { format: { comments: false } } })],
    },
  };
  webpack(config, (error, stats) => {
    if (error) { console.error(error.stack || String(error)); process.exitCode = 1; return; }
    const info = stats.toJson({ all: false, assets: true, errors: true, warnings: true });
    if (stats.hasErrors()) { console.error(JSON.stringify(info.errors, null, 2)); process.exitCode = 1; return; }
    if (stats.hasWarnings()) { console.error(JSON.stringify(info.warnings, null, 2)); process.exitCode = 1; return; }
    const names = (info.assets || []).map((asset) => asset.name).sort();
    if (names.length !== 1 || names[0] !== "app.js") { console.error("unexpected webpack output: " + JSON.stringify(names)); process.exitCode = 1; }
  });
})().catch((error) => { console.error(error.stack || String(error)); process.exitCode = 1; });
'''

class BuilderError(RuntimeError):
    pass

def fail(message):
    raise BuilderError(message)

def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()

def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

def write_bytes(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)

def write_text(path, text):
    if not text.endswith("\n"):
        text += "\n"
    write_bytes(path, text.encode("utf-8"))

def relative_files(root):
    return sorted(path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file())

def canonical_json_bytes(value):
    return (json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")

def tsv(rows):
    return "\n".join("\t".join(str(item) for item in row) for row in rows) + "\n"

def validate_root(argv):
    if len(argv) != 2:
        fail("usage: build_g1_p1_p2.py <exact-generation-viewer-root>")
    supplied = Path(argv[1])
    try:
        actual = supplied.resolve(strict=True)
        expected = EXPECTED_ROOT.resolve(strict=True)
    except FileNotFoundError as error:
        fail("generation root does not exist: " + str(error))
    if actual != expected:
        fail("generation root mismatch")
    if supplied.is_symlink() or actual.is_symlink():
        fail("generation root must not be a symlink")
    return actual

def validate_prototype(prototype, source_export):
    if not prototype.is_dir() or prototype.is_symlink():
        fail("prototype is missing or is a symlink")
    for path in prototype.rglob("*"):
        if path.is_symlink():
            fail("prototype symlink prohibited: " + str(path))
    actual = frozenset(relative_files(prototype))
    if actual != PROTOTYPE_ALLOWLIST:
        fail("SCRATCH_FILE_SCOPE_APPROVAL_REQUIRED missing=" + repr(sorted(PROTOTYPE_ALLOWLIST - actual)) + " extra=" + repr(sorted(actual - PROTOTYPE_ALLOWLIST)))
    for rel in ("src/model/stream-model.js", "src/protocol/session-adapter.js", "src/sources/websocket-source.js"):
        candidate = source_export / rel
        if not candidate.is_file() or candidate.is_symlink():
            fail("required frozen runtime file missing: " + str(candidate))
    source_text = (prototype / "app.js").read_text(encoding="utf-8") + "\n" + (prototype / "presentation/deployment-context.js").read_text(encoding="utf-8")
    for marker in (
        "__DEPLOYMENT_TARGET__", "__INCLUDE_PROFESSIONAL__", "bootstrapDeviceHosted", "sha256RawBytes",
        '"/viewer/asset-manifest.json"', '"/viewer/device.json"', '"/d2b/v0/capabilities"', '"/d2b/v0/status"',
        "Viewerの更新状態が一致しません", "機器情報を確認できません",
    ):
        if marker not in source_text:
            fail("required source marker missing: " + marker)

def validate_tools(stage):
    node = Path("/usr/bin/node")
    if not node.is_file() or not os.access(node, os.X_OK):
        fail("/usr/bin/node unavailable")
    probe = 'const w=require("webpack/package.json").version;const t=require("terser-webpack-plugin/package.json").version;if(w!=="5.76.1")throw new Error("webpack="+w);process.stdout.write("webpack="+w+" terser-webpack-plugin="+t+"\\n");'
    result = subprocess.run([str(node), "-e", probe], check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    write_text(stage / "tool-probe.txt", result.stdout + result.stderr)
    if result.returncode != 0 or "webpack=5.76.1" not in result.stdout:
        fail("webpack API probe failed")

def write_p1_artifacts(prototype, destination):
    destination.mkdir(parents=True, exist_ok=True)
    def inventory(name, paths):
        rows = [("path", "bytes", "SHA-256")]
        total = 0
        for rel in paths:
            payload = (prototype / rel).read_bytes()
            total += len(payload)
            rows.append((rel, len(payload), sha256_bytes(payload)))
        rows.append(("total", total, ""))
        write_bytes(destination / name, tsv(rows).encode("utf-8"))
        return total
    student_total = inventory("p1-student-inventory.tsv", P1_STUDENT)
    professional_total = inventory("p1-student-professional-inventory.tsv", P1_PROFESSIONAL)
    pdata = (prototype / "presentation/professional-view.js").read_bytes()
    write_bytes(destination / "professional-increment-source.tsv", tsv((("path", "bytes", "SHA-256", "reason"), ("presentation/professional-view.js", len(pdata), sha256_bytes(pdata), "Professional diagnostics presentation only"))).encode("utf-8"))
    if professional_total - student_total != len(pdata):
        fail("P1 increment inconsistent")
    return {"student_total": student_total, "professional_total": professional_total, "professional_increment": len(pdata)}

def run_webpack(node_driver, prototype, work, include_professional):
    bundle_dir = work / "webpack-output"
    result = subprocess.run(["/usr/bin/node", str(node_driver), str(prototype / "app.js"), str(bundle_dir), "1" if include_professional else "0"], check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    write_text(work / "webpack.log", result.stdout + result.stderr)
    if result.returncode != 0:
        fail("webpack bundle failed")
    if relative_files(bundle_dir) != ["app.js"]:
        fail("unexpected webpack output")
    payload = (bundle_dir / "app.js").read_bytes()
    if b"sourceMappingURL=" in payload:
        fail("source map reference prohibited")
    if not include_professional and b"Professional diagnostics" in payload:
        fail("student bundle retained professional")
    if include_professional and b"Professional diagnostics" not in payload:
        fail("professional bundle missing professional")
    for marker in (b"SyntheticSource", b"buildSyntheticPlan", b"synthetic-d2b-source", b"producer-gap", b"output-drop", b"invalid-frame", b"S1 Stable"):
        if marker in payload:
            fail("device-hosted bundle retained synthetic scenario/module marker: " + marker.decode())
    for marker in (
        b"/viewer/asset-manifest.json", b"/viewer/device.json", b"/d2b/v0/capabilities", b"/d2b/v0/status",
        "Viewerの更新状態が一致しません".encode(), "機器情報を確認できません".encode(), b"crypto.subtle.digest", b"arrayBuffer",
    ):
        if marker not in payload:
            fail("bundle marker missing: " + marker.decode(errors="replace"))
    return payload

def deterministic_gzip(raw, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as output:
        with gzip.GzipFile(filename="", mode="wb", fileobj=output, compresslevel=9, mtime=0) as stream:
            stream.write(raw)
    data = path.read_bytes()
    if len(data) < 10 or data[:3] != b"\x1f\x8b\x08" or data[3] & 0x08 or data[4:8] != b"\0\0\0\0" or gzip.decompress(data) != raw:
        fail("gzip contract failed")
    return data

def html_for_hashed_assets(source, css_hash, js_hash):
    if source.count('href="./app.css"') != 1 or source.count('src="./app.js"') != 1:
        fail("index local refs mismatch")
    return source.replace('href="./app.css"', f'href="/viewer/assets/app.{css_hash}.css"').replace('src="./app.js"', f'src="/viewer/assets/app.{js_hash}.js"').encode()

def representation_rows(index_raw, css_raw, js_raw, css_gzip, js_gzip, manifest_raw):
    ch, jh = sha256_bytes(css_gzip), sha256_bytes(js_gzip)
    return (
        ("entry_html", "index.html", "raw", "YES", "/viewer/", MIME_HTML, "identity", len(index_raw), sha256_bytes(index_raw)),
        ("asset_manifest", "asset-manifest.json", "raw", "YES", "/viewer/asset-manifest.json", "application/json; charset=utf-8", "identity", len(manifest_raw), sha256_bytes(manifest_raw)),
        ("app_css", f"assets/app.{ch}.css.gz", "gzip", "YES", f"/viewer/assets/app.{ch}.css", MIME_CSS, "gzip", len(css_gzip), ch),
        ("app_js", f"assets/app.{jh}.js.gz", "gzip", "YES", f"/viewer/assets/app.{jh}.js", MIME_JS, "gzip", len(js_gzip), jh),
        ("raw_app_css", "raw/app.css", "raw", "NO", "", MIME_CSS, "identity", len(css_raw), sha256_bytes(css_raw)),
        ("raw_app_js", "raw/app.js", "raw", "NO", "", MIME_JS, "identity", len(js_raw), sha256_bytes(js_raw)),
    )

def verify_manifest(raw, bundle_id):
    if raw.startswith(b"\xef\xbb\xbf") or not raw.endswith(b"\n") or raw.endswith(b"\n\n"):
        fail("manifest LF/BOM contract failed")
    manifest = json.loads(raw.decode())
    if list(manifest) != ["schema_version", "deployment_target", "viewer_source_commit", "d2b_authority_commit", "files"] or raw != canonical_json_bytes(manifest):
        fail("manifest canonical contract failed")
    if manifest["deployment_target"] != "device-hosted" or manifest["viewer_source_commit"] != VIEWER_COMMIT or manifest["d2b_authority_commit"] != D2B_COMMIT:
        fail("manifest identity failed")
    if any(e["logical_role"] == "asset_manifest" for e in manifest["files"]):
        fail("manifest self inclusion")
    if [e["served_url"] for e in manifest["files"]] != sorted(e["served_url"] for e in manifest["files"]):
        fail("manifest sort failed")
    keys = ["logical_role", "physical_filename", "served_url", "representation", "stored_on_device", "mime", "content_encoding", "bytes", "sha256"]
    if any(list(e) != keys for e in manifest["files"]):
        fail("manifest entry order failed")
    if sha256_bytes(raw) != bundle_id:
        fail("bundle id failed")

def write_sha256sums(root):
    names = [n for n in relative_files(root) if n != "SHA256SUMS"]
    write_text(root / "SHA256SUMS", "\n".join(sha256_file(root / n) + "  " + n for n in names))

def build_one_run(prototype, node_driver, run_root, variant):
    include_professional = variant == "student-professional"
    raw_js = run_webpack(node_driver, prototype, run_root, include_professional)
    raw_css = (prototype / "app.css").read_bytes()
    source_html = (prototype / "index.html").read_text()
    ctemp, jtemp = run_root / "served/assets/app.css.gz", run_root / "served/assets/app.js.gz"
    cg, jg = deterministic_gzip(raw_css, ctemp), deterministic_gzip(raw_js, jtemp)
    ch, jh = sha256_bytes(cg), sha256_bytes(jg)
    index_raw = html_for_hashed_assets(source_html, ch, jh)
    files = [
        {"logical_role":"entry_html","physical_filename":"index.html","served_url":"/viewer/","representation":"raw","stored_on_device":"YES","mime":MIME_HTML,"content_encoding":"identity","bytes":len(index_raw),"sha256":sha256_bytes(index_raw)},
        {"logical_role":"app_css","physical_filename":f"assets/app.{ch}.css.gz","served_url":f"/viewer/assets/app.{ch}.css","representation":"gzip","stored_on_device":"YES","mime":MIME_CSS,"content_encoding":"gzip","bytes":len(cg),"sha256":ch},
        {"logical_role":"app_js","physical_filename":f"assets/app.{jh}.js.gz","served_url":f"/viewer/assets/app.{jh}.js","representation":"gzip","stored_on_device":"YES","mime":MIME_JS,"content_encoding":"gzip","bytes":len(jg),"sha256":jh},
    ]
    files.sort(key=lambda e: e["served_url"].encode())
    manifest_raw = canonical_json_bytes({"schema_version":"1","deployment_target":"device-hosted","viewer_source_commit":VIEWER_COMMIT,"d2b_authority_commit":D2B_COMMIT,"files":files})
    bid = sha256_bytes(manifest_raw)
    verify_manifest(manifest_raw, bid)
    for rel, data in (("raw/index.html", index_raw), ("raw/app.css", raw_css), ("raw/app.js", raw_js), ("served/index.html", index_raw), ("served/asset-manifest.json", manifest_raw)):
        write_bytes(run_root / rel, data)
    os.replace(ctemp, run_root / f"served/assets/app.{ch}.css.gz")
    os.replace(jtemp, run_root / f"served/assets/app.{jh}.js.gz")
    rows = representation_rows(index_raw, raw_css, raw_js, cg, jg, manifest_raw)
    write_bytes(run_root / "representation-inventory.tsv", tsv((("logical_role","physical_filename","representation","stored_on_device","served_url","MIME","Content-Encoding","bytes","SHA-256"), *rows)).encode())
    write_text(run_root / "viewer-bundle-id.txt", bid)
    return {"bundle_id":bid,"raw_bytes":len(index_raw)+len(raw_css)+len(raw_js),"raw_css_bytes":len(raw_css),"raw_js_bytes":len(raw_js),"gzip_bytes":len(cg)+len(jg),"gzip_css_bytes":len(cg),"gzip_js_bytes":len(jg),"stored_bytes":sum(r[7] for r in rows if r[3]=="YES"),"manifest_bytes":len(manifest_raw),"css_hash":ch,"js_hash":jh}

def compare_required_runs(left, right):
    for rel in ("raw", "served", "representation-inventory.tsv", "viewer-bundle-id.txt"):
        a, b = left / rel, right / rel
        if a.is_dir():
            if relative_files(a) != relative_files(b): fail("P2_NONDETERMINISTIC filenames")
            for child in relative_files(a):
                if (a/child).read_bytes() != (b/child).read_bytes(): fail("P2_NONDETERMINISTIC bytes " + child)
        elif a.read_bytes() != b.read_bytes():
            fail("P2_NONDETERMINISTIC " + rel)

def materialize_variant(dest, run1, run2, variant, result):
    compare_required_runs(run1, run2)
    dest.mkdir(parents=True, exist_ok=True)
    if variant == "student":
        write_text(dest / "scope.txt", "DIFFERENTIAL_SIZING_ONLY\nNOT firmware candidate; NOT AssetPool candidate; NOT G2 candidate.\n")
    for rel in ("raw", "served"):
        shutil.copytree(run1 / rel, dest / rel)
    for rel in ("representation-inventory.tsv", "viewer-bundle-id.txt"):
        shutil.copy2(run1 / rel, dest / rel)
    for number in (1, 2):
        write_text(dest / f"determinism-run-{number}.txt", "\n".join((f"variant={variant}",f"run={number}",f"viewer_bundle_id={result['bundle_id']}",f"raw_representation_bytes={result['raw_bytes']}",f"gzip_asset_bytes={result['gzip_bytes']}",f"stored_on_device_bytes={result['stored_bytes']}",f"manifest_bytes={result['manifest_bytes']}")))
    write_text(dest / "determinism-compare.txt", "P2 deterministic comparison=PASS\nall required raw/gzip/index/manifest/inventory/bundle-id filenames byte-identical across two independent clean runs\ngzip=m=0 filename=absent Python standard library compresslevel=9\n")
    write_sha256sums(dest)

def install_recoverably(artifacts, stage):
    names = ("02-presentation-measurement", "04-p2-student", "05-p2-student-professional")
    for name in names:
        if not (artifacts/name).is_dir() or not (stage/name).is_dir(): fail("artifact directory missing " + name)
    backup = artifacts / (".p2-builder-backup-" + uuid.uuid4().hex)
    backup.mkdir()
    moved, installed = [], []
    try:
        for name in names: os.replace(artifacts/name, backup/name); moved.append(name)
        for name in names: os.replace(stage/name, artifacts/name); installed.append(name)
    except BaseException:
        for name in reversed(installed):
            if (artifacts/name).exists(): os.replace(artifacts/name, stage/name)
        for name in reversed(moved):
            if (backup/name).exists(): os.replace(backup/name, artifacts/name)
        raise
    shutil.rmtree(backup)
    shutil.rmtree(stage)

def main():
    root = validate_root(sys.argv)
    prototype, source_export, artifacts = root/"prototype", root/"source-export/viewer", root/"artifacts"
    validate_prototype(prototype, source_export)
    stage = Path(tempfile.mkdtemp(prefix=".p2-builder-stage-", dir=artifacts))
    try:
        validate_tools(stage)
        driver = stage / "webpack-5.76.1-driver.cjs"
        write_text(driver, NODE_DRIVER)
        p1 = write_p1_artifacts(prototype, stage / "02-presentation-measurement")
        results = {}
        for variant, target in (("student","04-p2-student"),("student-professional","05-p2-student-professional")):
            run1, run2 = stage/"runs"/variant/"run-1", stage/"runs"/variant/"run-2"
            r1, r2 = build_one_run(prototype, driver, run1, variant), build_one_run(prototype, driver, run2, variant)
            if r1 != r2: fail("P2_NONDETERMINISTIC summaries")
            materialize_variant(stage/target, run1, run2, variant, r1)
            results[variant] = r1
        install_recoverably(artifacts, stage)
    except BaseException:
        print("FAIL staged artifacts retained: " + str(stage), file=sys.stderr)
        raise
    print("PASS G1 P1/P2 artifact regeneration")
    print(f"P1-S modular source bytes={p1['student_total']}")
    print(f"P1-SP modular source bytes={p1['professional_total']}")
    print(f"P1 professional source increment bytes={p1['professional_increment']}")
    for variant in ("student", "student-professional"):
        r = results[variant]
        label = "S" if variant == "student" else "SP"
        print(f"P2-{label} raw_bytes={r['raw_bytes']} gzip_bytes={r['gzip_bytes']} stored_on_device_bytes={r['stored_bytes']} viewer_bundle_id={r['bundle_id']}")
        print(f"  css_gzip_bytes={r['gzip_css_bytes']} css_gzip_sha256={r['css_hash']} js_gzip_bytes={r['gzip_js_bytes']} js_gzip_sha256={r['js_hash']}")
    print("PASS P2-S differential-only marker, raw-manifest SHA bundle IDs, and run1/run2 byte determinism")

if __name__ == "__main__":
    try:
        main()
    except (BuilderError, subprocess.SubprocessError, OSError, ValueError, json.JSONDecodeError) as error:
        print("FAIL: " + str(error), file=sys.stderr)
        sys.exit(1)
