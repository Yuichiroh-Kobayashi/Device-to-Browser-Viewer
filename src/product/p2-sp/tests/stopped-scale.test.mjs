import test from "node:test";
import assert from "node:assert/strict";
import { CURRENT_SCALES, DISPLAY_WINDOWS, VOLTAGE_SCALES, makeTimeDomain, makeXAxisGrid, makeXAxisTicks, timePrecision } from "../graph/graph-core.js";
import { plotGeometry } from "../graph/waveform-canvas.js";
import { fixture } from "./history-fixture.mjs";

test("Stop latches the last LIVE frame even with later unpainted records; review path never autoscales", async () => {
  const f = fixture();
  try {
    await f.start(); f.window(10);
    f.data(0n, { voltage: 30, current: 3 }); f.data(40_000n, { voltage: 30, current: 3 }); f.flush();
    const lastLive = { ...f.app.graphPolicy.scaleIndices };
    f.data(80_000_000n, { voltage: 0.01, current: 0.00001 });
    await f.stop(); f.flush();
    assert.deepEqual(f.app.graphPolicy.scaleIndices, lastLive);
    const records = f.owner.model.recordSnapshot(); const counts = { ...f.counts };
    for (const mode of ["student", "professional"]) {
      f.app.controller.setMode(mode);
      for (const seconds of DISPLAY_WINDOWS) {
        f.window(seconds); f.position(0); f.flush();
        const domainA = f.state().domain;
        f.position(1000); f.position(500);
        f.pointer("voltage", "down", 1); f.pointer("voltage", "move", 1, 100000); f.pointer("voltage", "up", 1);
        f.flush();
        assert.deepEqual(f.state().domain, domainA);
        assert.deepEqual(f.app.graphPolicy.scaleIndices, lastLive);
      }
    }
    assert.deepEqual(f.owner.model.recordSnapshot(), records); assert.deepEqual(f.counts, counts);
  } finally { f.dispose(); }
});

test("manual Y uses each existing ladder independently, persists across navigation/remount, resets at accepted epoch", async () => {
  const f = fixture();
  try {
    await f.start(); f.data(0n); f.data(80_000_000n); f.flush(); await f.stop(); f.window(10); f.position(300);
    const records = f.owner.model.recordSnapshot(); const counts = { ...f.counts }; const cursor = f.state().rightEdge;
    for (const [channel, scales, other] of [["voltage", VOLTAGE_SCALES, "current"], ["current", CURRENT_SCALES, "voltage"]]) {
      const otherIndex = f.app.graphPolicy.scaleIndices[other];
      for (const value of scales) {
        f.scale(channel, value); f.flush();
        assert.equal(scales[f.app.graphPolicy.scaleIndices[channel]], value);
        assert.equal(f.app.graphPolicy.scaleIndices[other], otherIndex);
        assert.equal(f.state().rightEdge, cursor);
        assert.equal(f.root.querySelector(`[data-y-scale="${channel}"]`).value, String(value));
      }
    }
    const selected = { ...f.app.graphPolicy.scaleIndices };
    f.position(500); f.window(30); f.app.controller.toggle(); f.flush();
    assert.deepEqual(f.app.graphPolicy.scaleIndices, selected);
    assert.deepEqual(f.owner.model.recordSnapshot(), records); assert.deepEqual(f.counts, counts);
    await f.start(2);
    assert.deepEqual(f.app.graphPolicy.scaleIndices, { voltage: 0, current: 0 });
    assert.equal(f.app.historyReview.rightEdgeTimestampUs, null);
    assert.equal(f.app.graphPolicy.windowSeconds, 30, "display preference survives sessions");
    f.data(5_000_000n, { flags: 0x45, voltage: 30, current: 3 }); f.flush();
    assert.ok(f.app.graphPolicy.scaleIndices.voltage > 0, "live autoscale resumes");
  } finally { f.dispose(); }
});

test("live Y controls stay mounted and disabled; all six X windows follow latest and sync endpoints", async () => {
  const f = fixture();
  try {
    await f.start(); f.data(0n); f.data(12_500_000n); f.flush();
    const scales = { ...f.app.graphPolicy.scaleIndices };
    for (const channel of ["voltage", "current"]) {
      const select = f.root.querySelector(`[data-y-scale="${channel}"]`);
      assert.equal(select.disabled, true); assert.equal(select.hidden, false);
      f.scale(channel, 5); f.zoom(channel, "in"); f.zoom(channel, "out");
      for (const direction of ["in", "out"]) assert.equal(f.root.querySelector(`[data-zoom-${direction}="${channel}"]`).disabled, true);
    }
    assert.deepEqual(f.app.graphPolicy.scaleIndices, scales);
    for (const seconds of DISPLAY_WINDOWS) {
      f.window(seconds); f.flush();
      assert.deepEqual(f.state().domain, makeTimeDomain(0n, 12_500_000n, seconds));
      assert.equal(f.root.querySelector("[data-display-window]").value, String(seconds));
      assert.equal(f.root.querySelector('[data-zoom-in="x"]').disabled, seconds === 1);
      assert.equal(f.root.querySelector('[data-zoom-out="x"]').disabled, seconds === 60);
    }
  } finally { f.dispose(); }
});

test("all six windows retain axis grids/ticks without centered readouts at narrow/wide widths", async () => {
  const f = fixture();
  try {
    await f.start(); f.data(0n); f.data(80_000_000n); f.flush(); await f.stop(); f.scale("current", 0.02);
    for (const width of [240, 320, 768, 1366]) for (const seconds of DISPLAY_WINDOWS) {
      for (const channel of ["voltage", "current"]) f.root.querySelector(`[data-waveform="${channel}"]`).rect.width = width;
      f.window(seconds); f.flush();
      assert.deepEqual(makeTimeDomain(0n, 100_000n, seconds), { minimum: 0, maximum: seconds });
      const precision = timePrecision(seconds); const { pw } = plotGeometry({ width, height: 288 });
      const grid = makeXAxisGrid(f.state().domain, precision, pw);
      assert.deepEqual(grid.ticks, makeXAxisTicks(f.state().domain, precision, pw));
      for (let i = 1; i < grid.ticks.length; i++) assert.ok(Math.abs(grid.ticks[i].value - grid.ticks[i - 1].value - grid.step) < 1e-8);
      const readout = f.root.querySelector('[data-scale-readout="current"]');
      assert.equal(readout, null);
      const canvasText = f.root.querySelector('[data-waveform="current"]').context.text;
      assert.ok(grid.ticks.every(tick => canvasText.includes(tick.label)));
      assert.ok(canvasText.includes("0 A"), "current lower bound stays zero");
    }
  } finally { f.dispose(); }
});

test("new short windows preserve gaps and invalid channels with no fabricated points", async () => {
  const f = fixture();
  try {
    await f.start(); f.data(0n); f.data(40_000n);
    f.data(200_000n, { sequence: 7n, flags: 4 }); f.data(240_000n, { validMask: 1 }); f.data(280_000n);
    f.flush(); await f.stop();
    for (const seconds of DISPLAY_WINDOWS) {
      f.window(seconds); f.flush();
      const frame = f.app.graphPolicy.update(f.owner.model.recordSnapshot(), { originTimestampUs: 0n, autoscale: false });
      assert.deepEqual(frame.current.paths.map(path => path.map(point => point.x)), [[0, 0.04]]);
      assert.deepEqual(frame.current.invalid, [{ seconds: 0.24 }]);
      assert.deepEqual(frame.voltage.paths.map(path => path.map(point => point.x)), [[0, 0.04], [0.2, 0.24, 0.28]]);
    }
    assert.equal(f.owner.model.records.size, 5);
  } finally { f.dispose(); }
});

test("10 s canvas labels stay distinct and clear of the s unit at narrow/tablet/desktop widths", async () => {
  const f = fixture();
  try {
    await f.start(); f.data(0n); f.data(160_000_000n); await f.stop(); f.window(10);
    for (const width of [240, 320, 768, 1366]) for (const rightEdge of [10_000_000n, 12_500_000n, 160_000_000n]) {
      f.app.historyReview.panTo(rightEdge, f.owner.model.historySummary(), true, 10);
      for (const channel of ["voltage", "current"]) f.root.querySelector(`[data-waveform="${channel}"]`).rect.width = width;
      f.app.presentation.update(); f.flush();
      for (const channel of ["voltage", "current"]) {
        const text = f.root.querySelector(`[data-waveform="${channel}"]`).context.textPositions;
        const labels = text.filter(t => t.y >= 288-24 && /^\d+$/.test(t.text));
        assert.equal(labels.length, rightEdge === 12_500_000n ? 10 : 11);
        assert.equal(new Set(labels.map(t => t.text)).size, labels.length);
        for (const label of labels) {
          assert.ok(label.x >= 0 && label.x+label.width <= width-16);
          for (const other of labels) if (other.x > label.x && other.y === label.y) assert.ok(other.x >= label.x+label.width);
        }
      }
    }
  } finally { f.dispose(); }
});
