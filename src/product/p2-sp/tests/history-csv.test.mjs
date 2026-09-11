import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createLocalCsvDownload, createStoppedHistoryCsv, csvExportState, formatElapsedMilliseconds, historyCsvFilename } from "../history-csv.js";
import { fixture } from "./history-fixture.mjs";

test("exact header, numeric/blank cells, signed current, real sub-ms delta and gap timing", async () => {
  const f = fixture();
  try {
    await f.start(); const origin = 9_007_199_254_740_993n;
    f.data(origin, { voltage: 2.5, current: -0.03125 });
    f.data(origin + 1001n, { voltage: 0, current: 9, validMask: 1 });
    f.data(origin + 1999n, { voltage: 9, current: 0.125, validMask: 2 });
    f.data(origin + 9_876_543n, { sequence: 9n, flags: 4, validMask: 0 });
    await f.stop();
    const csv = createStoppedHistoryCsv(f.owner.model, f.owner.stoppedHistoryReady);
    assert.equal(csv, "voltage,current,elapsed_ms\r\n2.5,-0.03125,0\r\n0,,1.001\r\n,0.125,1.999\r\n,,9876.543\r\n");
    assert.equal(csv.split("\r\n").length, 6, "no fabricated missing rows");
    assert.equal(f.owner.model.records.size, 4);
    assert.equal(f.owner.model.records.peek().current_A, -0.03125);
  } finally { f.dispose(); }
});

test("BigInt milliseconds preserve every microsecond even beyond safe Number range", () => {
  const cases = [[0n, "0"], [1n, "0.001"], [10n, "0.01"], [100n, "0.1"], [999n, "0.999"], [1000n, "1"], [1001n, "1.001"], [0xffffffffffffffffn, "18446744073709551.615"]];
  for (const [input, expected] of cases) assert.equal(formatElapsedMilliseconds(input), expected);
  for (const input of [-1n, 40, "1000"]) assert.throws(() => formatElapsedMilliseconds(input));
});

test("export is unavailable before normal Stop, at STREAM_END alone and for empty history", async () => {
  const f = fixture();
  try {
    assert.equal(f.root.querySelector("[data-history-export]").disabled, true);
    await f.start(); f.data(0n);
    assert.throws(() => createStoppedHistoryCsv(f.owner.model, f.owner.stoppedHistoryReady));
    await f.owner.actions.stop(); f.end();
    assert.equal(f.root.querySelector("[data-history-export]").disabled, true);
    f.stopped(); assert.equal(f.root.querySelector("[data-history-export]").disabled, false);
    await f.start(2); await f.stop();
    assert.equal(f.root.querySelector("[data-history-export]").disabled, true);
    assert.match(f.root.querySelector("[data-history-export-reason]").textContent, /No measurements/);
  } finally { f.dispose(); }
});

test("mounted Student/Professional export is identical, full retained history, no WS or review mutation", async () => {
  const saved = []; let disposed = 0;
  const f = fixture({ csvDownload: { save(csv, filename) { saved.push({ csv, filename }); }, dispose() { disposed++; } } });
  try {
    await f.start(); f.data(1_000_000n); f.data(1_040_001n); f.data(81_000_000n);
    await f.stop(); f.window(10); f.position(0); f.flush();
    const before = { counts: { ...f.counts }, model: f.owner.model, adapter: f.owner.adapter, source: f.owner.source, decoder: f.owner.adapter.decoderState,
      latest: f.owner.model.latest, records: f.owner.model.recordSnapshot(), markers: f.owner.model.markerSnapshot(), summary: f.owner.model.summary(), cursor: f.state() };
    for (const mode of ["student", "professional"]) {
      f.app.controller.setMode(mode);
      const button = f.root.querySelector("[data-history-export]");
      assert.equal(button.tag, "button"); assert.equal(button.disabled, false);
      assert.ok(f.root.innerHTML.indexOf("data-student-primary-action") < f.root.innerHTML.indexOf("data-history-export"));
      button.onclick(); f.flush();
      assert.match(f.root.querySelector("[data-history-export-result]").textContent, /Download requested/);
    }
    assert.equal(saved.length, 2); assert.equal(saved[0].csv, saved[1].csv);
    assert.equal(saved[0].csv, "voltage,current,elapsed_ms\r\n1,0.125,0\r\n1,0.125,40.001\r\n1,0.125,80000\r\n");
    assert.match(saved[0].filename, /^vameter-viewer-\d{8}-\d{6}\.csv$/);
    assert.deepEqual(f.counts, before.counts); assert.deepEqual(f.state(), before.cursor);
    for (const key of ["model", "adapter", "source"]) assert.strictEqual(f.owner[key], before[key]);
    assert.strictEqual(f.owner.adapter.decoderState, before.decoder); assert.strictEqual(f.owner.model.latest, before.latest);
    assert.deepEqual(f.owner.model.recordSnapshot(), before.records); assert.deepEqual(f.owner.model.markerSnapshot(), before.markers);
    assert.deepEqual(f.owner.model.summary(), before.summary);
  } finally { f.dispose(); }
  assert.equal(disposed, 1);
});

test("new stream/TIMEBASE_RESET export has one epoch and elapsed origin zero", async () => {
  const f = fixture();
  try {
    await f.start(); f.data(99_000_000n, { voltage: 9 }); await f.stop();
    assert.match(createStoppedHistoryCsv(f.owner.model, true), /9,0.125,0/);
    await f.owner.actions.close(); await f.start(2);
    assert.throws(() => createStoppedHistoryCsv(f.owner.model, f.owner.stoppedHistoryReady));
    f.data(900n, { flags: 0x45, voltage: 2 }); f.data(901n, { voltage: 3 }); await f.stop();
    assert.equal(createStoppedHistoryCsv(f.owner.model, f.owner.stoppedHistoryReady), "voltage,current,elapsed_ms\r\n2,0.125,0\r\n3,0.125,0.001\r\n");
  } finally { f.dispose(); }
});

test("truncation policy A disables export and displays reason; new epoch restores eligibility", async () => {
  const saved = [];
  const f = fixture({ csvDownload: { save(...args) { saved.push(args); }, dispose() {} } });
  try {
    await f.start();
    for (let i = 0; i < 4097; i++) f.data(BigInt(i) * 40_000n);
    await f.stop(); const counts = { ...f.counts };
    for (const mode of ["student", "professional"]) {
      f.app.controller.setMode(mode);
      assert.equal(f.root.querySelector("[data-history-export]").disabled, true);
      assert.match(f.root.querySelector("[data-history-export-reason]").textContent, /complete export is unavailable/);
      assert.throws(() => createStoppedHistoryCsv(f.owner.model, true));
      f.root.querySelector("[data-history-export]").onclick();
    }
    assert.deepEqual(saved, []); assert.deepEqual(f.counts, counts);
    await f.start(2); f.data(1n); await f.stop();
    assert.equal(f.root.querySelector("[data-history-export]").disabled, false);
    assert.equal(csvExportState(f.owner.model.historySummary(), true).enabled, true);
  } finally { f.dispose(); }
});

test("CSV accepts only finite numbers/blank cells and never coerces hostile strings or objects", () => {
  const base = { stream_id: 1, timestamp_us: 1n, valid_mask: 3, voltage_V: 1, current_A: -0.125 };
  const model = (records) => ({ historySummary: () => ({ count: records.length, truncated: false, originTimestampUs: 1n }), recordSnapshot: () => records });
  for (const hostile of ["=1+1", "+SUM(A1:A2)", "-1+1", "@SUM(1)", "\t=1", "1,2\r\n=3", NaN, Infinity, { toString() { throw new Error("must never coerce"); } }]) {
    assert.throws(() => createStoppedHistoryCsv(model([{ ...base, voltage_V: hostile }]), true), /finite numeric/);
    assert.throws(() => createStoppedHistoryCsv(model([{ ...base, current_A: hostile }]), true), /finite numeric/);
    assert.equal(createStoppedHistoryCsv(model([{ ...base, voltage_V: hostile, valid_mask: 2 }]), true), "voltage,current,elapsed_ms\r\n,-0.125,0\r\n");
  }
  assert.equal(createStoppedHistoryCsv(model([{ ...base, voltage_V: null, current_A: undefined }]), true), "voltage,current,elapsed_ms\r\n,,0\r\n");
  assert.throws(() => createStoppedHistoryCsv(model([{ ...base, timestamp_us: "=1" }]), true));
  assert.throws(() => createStoppedHistoryCsv(model([{ ...base, valid_mask: "3" }]), true));
  assert.throws(() => createStoppedHistoryCsv(model([base, { ...base, stream_id: 2 }]), true));
  assert.throws(() => createStoppedHistoryCsv(model([{ ...base, timestamp_us: 0n }]), true));
});

test("filename uses only static prefix and host-local timestamp; date never enters measurement cells", () => {
  assert.equal(historyCsvFilename(new Date(2026, 8, 11, 1, 2, 3)), "vameter-viewer-20260911-010203.csv");
  assert.throws(() => historyCsvFilename(new Date(NaN)));
  const source = readFileSync(new URL("../history-csv.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|WebSocket|decodeBinary/);
});

test("local Blob download is bounded to one URL/timer and cleans up on repeat, timer, failure and dispose", async () => {
  const blobs = []; const revoked = []; const clicked = []; const anchors = []; const timers = new Map();
  let id = 0;
  const document = { createElement(tag) {
    assert.equal(tag, "a"); const a = { removeCalls: 0, click() { clicked.push(this.download); }, remove() { this.removeCalls++; } }; anchors.push(a); return a;
  }, body: { appendChild(a) { assert.equal(a.hidden, true); } } };
  const urls = { createObjectURL(blob) { blobs.push(blob); return `blob:${blobs.length}`; }, revokeObjectURL(url) { revoked.push(url); } };
  const scheduler = { setTimeout(fn, delay) { assert.equal(delay, 60000); timers.set(++id, fn); return id; }, clearTimeout(id) { timers.delete(id); } };
  const download = createLocalCsvDownload({ document, urls, scheduler });
  const csv = "voltage,current,elapsed_ms\r\n1,-0.125,0.001\r\n";
  download.save(csv, "vameter-viewer-20260911-010203.csv");
  assert.equal(await blobs[0].text(), csv); assert.equal(blobs[0].type, "text/csv;charset=utf-8");
  assert.equal(anchors[0].removeCalls, 1); assert.deepEqual(revoked, []);
  download.save(csv, "vameter-viewer-20260911-010204.csv");
  assert.deepEqual(revoked, ["blob:1"]); assert.equal(timers.size, 1);
  [...timers.values()][0](); assert.deepEqual(revoked, ["blob:1", "blob:2"]); assert.equal(timers.size, 0);
  download.save(csv, "vameter-viewer-20260911-010205.csv"); download.dispose(); download.dispose();
  assert.deepEqual(revoked, ["blob:1", "blob:2", "blob:3"]); assert.equal(timers.size, 0); assert.equal(clicked.length, 3);
  document.body.appendChild = () => { throw new Error("DOM failure"); };
  assert.throws(() => download.save(csv, "vameter-viewer-20260911-010206.csv"), /DOM failure/);
  assert.equal(revoked.at(-1), "blob:4"); assert.equal(anchors.at(-1).removeCalls, 1); assert.equal(timers.size, 0);
});

test("failed browser save leaves measurement review and transport unchanged", async () => {
  const f = fixture({ csvDownload: { save() { throw new Error("unavailable"); }, dispose() {} } });
  try {
    await f.start(); f.data(0n); f.data(20_000_000n); await f.stop(); f.window(10); f.position(0);
    const state = f.state(); const counts = { ...f.counts };
    f.root.querySelector("[data-history-export]").onclick();
    assert.match(f.root.querySelector("[data-history-export-result]").textContent, /CSV export unavailable/);
    assert.deepEqual(f.state(), state); assert.deepEqual(f.counts, counts);
  } finally { f.dispose(); }
});
