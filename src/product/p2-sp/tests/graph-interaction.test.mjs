import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CURRENT_SCALES, DISPLAY_WINDOWS, VOLTAGE_SCALES } from "../graph/graph-core.js";
import { GraphInteractionController, PINCH_AXIS_LOCK_THRESHOLD, pinchAxis, quantizePinch } from "../presentation/graph-interaction.js";
import { fixture } from "./history-fixture.mjs";

test("axis threshold is normalized to graph dimensions, jitter and ties wait, near-zero separations are safe", () => {
  assert.equal(PINCH_AXIS_LOCK_THRESHOLD, 0.04);
  assert.equal(pinchAxis({ x: 0, y: 0 }, { x: 3, y: 3 }, 500, 200), null);
  assert.equal(pinchAxis({ x: 0, y: 0 }, { x: 20, y: 8 }, 500, 200), null);
  assert.equal(pinchAxis({ x: 0, y: 0 }, { x: 21, y: 8 }, 500, 200), "x");
  assert.equal(pinchAxis({ x: 0, y: 0 }, { x: 20, y: 9 }, 500, 200), "y");
});

test("pinch ratio quantizes only to ladder values, supports multi-step, clamps endpoints and resists jitter", () => {
  for (const scales of [DISPLAY_WINDOWS, VOLTAGE_SCALES, CURRENT_SCALES]) {
    for (let i = 0; i < scales.length; i++) {
      assert.equal(quantizePinch(scales, i, 1), i);
      assert.equal(quantizePinch(scales, i, 1e6), 0);
      assert.equal(quantizePinch(scales, i, 1e-6), scales.length - 1);
      if (i > 0) {
        const midpointRatio = Math.sqrt(scales[i] / scales[i - 1]);
        assert.equal(quantizePinch(scales, i, midpointRatio * 1.01), i);
        assert.equal(quantizePinch(scales, i, midpointRatio * 1.1), i - 1);
        assert.equal(quantizePinch(scales, i, midpointRatio * 0.99, i - 1), i - 1);
      }
    }
  }
});

test("axis remains locked through dominance reversal and single-pointer remainder; cancel/lost capture/destroy clean up", () => {
  const surface = { getBoundingClientRect: () => ({ width: 640, height: 288 }), captured: new Set(),
    setPointerCapture(id) { this.captured.add(id); }, hasPointerCapture(id) { return this.captured.has(id); }, releasePointerCapture(id) { this.captured.delete(id); } };
  let x = 10; let y = 1; let pans = 0;
  const c = new GraphInteractionController(surface, { channel: "voltage", getState: () => ({ windowSeconds: x, yScale: y, review: { enabled: true, rightEdge: 10_000_000n } }), changeWindow: value => { x = value; }, changeScale: (_, value) => { y = value; }, panTo: () => { pans++; } });
  const event = (id, x, y) => ({ pointerId: id, clientX: x, clientY: y, button: 0 });
  for (const axis of ["x", "y"]) {
    x = 10; y = 1;
    surface.onpointerdown(event(1, 100, 100)); surface.onpointerdown(event(2, 200, 140));
    surface.onpointermove(axis === "x" ? event(2, 400, 140) : event(2, 200, 260));
    assert.equal(c.axis, axis);
    const xAfter = x; const yAfter = y;
    surface.onpointermove(axis === "x" ? event(2, 400, 2000) : event(2, 2000, 260));
    assert.equal(c.axis, axis);
    if (axis === "x") { assert.ok(xAfter < 10); assert.equal(y, 1); }
    else { assert.ok(yAfter < 1); assert.equal(x, 10); }
    surface.onpointerup(event(2)); surface.onpointermove(event(1, 500, 500));
    assert.equal(pans, 0); assert.equal(c.axis, axis);
    surface.onpointercancel(event(1)); assert.equal(c.axis, null); assert.equal(c.pointers.size, 0);
  }
  surface.onpointerdown(event(3, 100, 100)); surface.onlostpointercapture(event(3));
  assert.equal(c.pointers.size, 0);
  surface.onpointerdown(event(4, 100, 100)); c.destroy();
  assert.equal(c.pointers.size, 0); assert.equal(surface.captured.size, 0); assert.equal(surface.onpointermove, null);
});

test("native zoom buttons traverse exactly one adjacent step, dropdown/readout synchronize, disabled endpoints remain mounted", async () => {
  const f = fixture();
  try {
    await f.start(); f.data(0n); f.data(80_000_000n); f.flush(); await f.stop();
    for (const [axis, scales] of [["x", DISPLAY_WINDOWS], ["voltage", VOLTAGE_SCALES], ["current", CURRENT_SCALES]]) {
      if (axis === "x") f.window(scales.at(-1)); else f.scale(axis, scales.at(-1));
      const select = () => f.root.querySelector(axis === "x" ? "[data-display-window]" : `[data-y-scale="${axis}"]`);
      const out = f.root.querySelector(`[data-zoom-out="${axis}"]`);
      assert.equal(out.disabled, true); assert.equal(out.hidden, false);
      for (let i = scales.length - 2; i >= 0; i--) { f.zoom(axis, "in"); f.flush(); assert.equal(select().value, String(scales[i])); }
      const into = f.root.querySelector(`[data-zoom-in="${axis}"]`);
      assert.equal(into.disabled, true); f.zoom(axis, "in"); assert.equal(select().value, String(scales[0]));
      for (let i = 1; i < scales.length; i++) { f.zoom(axis, "out"); assert.equal(select().value, String(scales[i])); }
      assert.strictEqual(f.root.querySelector(`[data-zoom-in="${axis}"]`), into);
    }
  } finally { f.dispose(); }
});

test("mounted X and Y pinches share controls; live Y and pan cannot override autoscale/follow-latest", async () => {
  const f = fixture();
  try {
    await f.start(); f.data(0n); f.data(80_000_000n); f.window(10); f.flush();
    const scales = { ...f.app.graphPolicy.scaleIndices }; const latest = f.state().rightEdge;
    f.pointer("current", "down", 1, 100, 50); f.pointer("current", "down", 2, 150, 100);
    f.pointer("current", "move", 2, 150, 270);
    assert.deepEqual(f.app.graphPolicy.scaleIndices, scales);
    f.pointer("current", "up", 2); f.pointer("current", "move", 1, 900, 50); f.pointer("current", "up", 1);
    assert.equal(f.state().rightEdge, latest);
    f.pointer("voltage", "down", 1, 100, 100); f.pointer("voltage", "down", 2, 200, 140);
    f.pointer("voltage", "move", 2, 400, 140); f.flush();
    assert.ok(f.app.graphPolicy.windowSeconds < 10);
    assert.equal(f.state().domain.maximum, 80);
    f.pointer("voltage", "up", 1); f.pointer("voltage", "up", 2);
    await f.stop(); f.scale("current", 0.1);
    const voltage = f.app.graphPolicy.scaleIndices.voltage;
    f.pointer("current", "down", 1, 100, 50); f.pointer("current", "down", 2, 150, 100);
    f.pointer("current", "move", 2, 150, 270); f.flush();
    const current = CURRENT_SCALES[f.app.graphPolicy.scaleIndices.current];
    assert.ok(current < 0.1); assert.equal(f.app.graphPolicy.scaleIndices.voltage, voltage);
    assert.equal(f.root.querySelector('[data-y-scale="current"]').value, String(current));
    assert.ok(f.root.querySelector('[data-scale-readout="current"]').textContent.includes(`${current} A/目盛`));
  } finally { f.dispose(); }
});

test("horizontal pan uses plot width and same cursor, clamps both ends, ignores Y, leaves transport/model unchanged", async () => {
  const f = fixture();
  try {
    await f.start(); f.data(0n); f.data(80_000_000n); f.flush(); await f.stop(); f.window(10);
    const records = f.owner.model.recordSnapshot(); const summary = f.owner.model.summary(); const counts = { ...f.counts };
    const indices = { ...f.app.graphPolicy.scaleIndices }; const decoder = f.owner.adapter.decoderState;
    f.pointer("voltage", "down", 1, 100, 100); f.pointer("voltage", "move", 1, 371, 200);
    assert.equal(f.state().rightEdge, 75_000_000n, "271 px = half the 542 px plot = five device seconds");
    assert.equal(f.root.querySelector("[data-history-position]").value, String(f.state().position));
    f.pointer("voltage", "move", 1, 371, 400);
    assert.equal(f.state().rightEdge, 75_000_000n, "vertical movement does not pan");
    f.pointer("voltage", "move", 1, 100000, 400); assert.equal(f.state().rightEdge, 10_000_000n);
    f.pointer("voltage", "move", 1, -100000, 400); assert.equal(f.state().rightEdge, 80_000_000n);
    f.pointer("voltage", "up", 1);
    for (const mode of ["professional", "student"]) {
      f.app.controller.setMode(mode); f.scale("current", 0.02); f.zoom("x", "in"); f.zoom("x", "out");
      f.pointer("current", "down", 1, 100, 100); f.pointer("current", "down", 2, 200, 140);
      f.pointer("current", "move", 2, 500, 140); f.pointer("current", "cancel", 1); f.pointer("current", "cancel", 2);
    }
    assert.equal(f.app.graphPolicy.scaleIndices.voltage, indices.voltage);
    assert.strictEqual(f.owner.adapter.decoderState, decoder);
    assert.deepEqual(f.owner.model.recordSnapshot(), records); assert.deepEqual(f.owner.model.summary(), summary); assert.deepEqual(f.counts, counts);
  } finally { f.dispose(); }
});

test("different surfaces never pair pointers; remount/new epoch/destroy release capture and abandon stale gestures", async () => {
  const f = fixture();
  try {
    await f.start(); f.data(0n); f.data(80_000_000n); f.flush(); await f.stop(); f.window(10);
    f.pointer("voltage", "down", 1); f.pointer("current", "down", 2);
    f.pointer("voltage", "move", 1, 400, 100); f.pointer("current", "move", 2, 100, 400);
    assert.equal(f.app.graphPolicy.windowSeconds, 10);
    const old = f.root.querySelector('[data-waveform="voltage"]');
    f.app.controller.toggle(); assert.equal(old.captured.size, 0); assert.equal(old.onpointermove, null);
    const canvas = f.root.querySelector('[data-waveform="current"]');
    f.pointer("current", "down", 3); await f.start(2);
    assert.equal(canvas.captured.size, 0);
    f.pointer("current", "move", 3, 800, 100); assert.equal(f.app.historyReview.rightEdgeTimestampUs, null);
    f.pointer("current", "down", 4); f.app.destroy(); assert.equal(canvas.captured.size, 0); assert.equal(canvas.onpointermove, null);
  } finally { f.dispose(); }
});

test("standard gestures and touch-action are graph scoped; readout and native controls remain accessible", () => {
  const source = readFileSync(new URL("../presentation/graph-interaction.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
  assert.doesNotMatch(source, /WebSocket|SessionAdapter|decode|gesturestart|gesturechange|userAgent|document\.|preventDefault/);
  assert.match(css, /\.graph-panel canvas\s*\{ touch-action: none; \}/);
  assert.equal((css.match(/touch-action:/g) ?? []).length, 1);
  assert.match(css, /\.scale-readout[^}]*text-align: center[^}]*pointer-events: none/);
  assert.match(css, /\.axis-controls[^}]*flex-wrap: wrap/);
  assert.match(css, /button:disabled[^}]*opacity:[^}]*border-style: dashed/);
});
