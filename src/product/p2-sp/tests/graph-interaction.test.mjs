import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CURRENT_SCALES, DISPLAY_WINDOWS, VOLTAGE_SCALES } from "../graph/graph-core.js";
import { GraphInteractionController, PINCH_AXIS_LOCK_THRESHOLD, pinchAxis, quantizePinch } from "../presentation/graph-interaction.js";
import { fixture } from "./history-fixture.mjs";

test("non-review pointerdown/move never registers, captures, starts a gesture or calls presentation callbacks", () => {
  let enabled = false; let captures = 0; let mutations = 0;
  const surface = { setAttribute(name, value) { this[name] = value; },
    setPointerCapture() { captures++; }, getBoundingClientRect: () => ({ width: 640, height: 288 }) };
  const c = new GraphInteractionController(surface, { channel: "voltage",
    getState: () => ({ windowSeconds: 10, yScale: 1, review: { enabled, rightEdge: 80_000_000n } }),
    changeWindow() { mutations++; }, changeScale() { mutations++; }, panTo() { mutations++; } });
  const event = id => ({ pointerId: id, clientX: id * 100, clientY: id * 100, button: 0 });
  for (const id of [1, 2]) { c.down(event(id)); c.move({ ...event(id), clientX: 900 }); }
  assert.equal(surface["data-graph-interaction"], "browser");
  assert.equal(c.pointers.size, 0); assert.equal(captures, 0); assert.equal(mutations, 0);
  assert.equal(c.mode, null); assert.equal(c.axis, null); assert.equal(c.baseline, null);
  enabled = true; c.syncOwnership(); c.move(event(1));
  assert.equal(c.pointers.size, 0); assert.equal(mutations, 0, "never adopt a browser gesture halfway through Stop");
  c.down(event(3)); assert.equal(c.pointers.size, 1); assert.equal(captures, 1);
  enabled = false; c.move(event(3));
  assert.equal(c.pointers.size, 0); assert.equal(c.mode, null); assert.equal(c.baseline, null);
  assert.equal(mutations, 0, "move also gates authority before a pending render");
});

for (const failure of ["start", "hello"]) test(`interaction ownership/capture follows review readiness through ${failure} timeout and accepted stream`, async () => {
  const f = fixture();
  const canvas = () => f.root.querySelector('[data-waveform="voltage"]');
  const ownership = expected => {
    for (const channel of ["voltage", "current"]) assert.equal(f.root.querySelector(`[data-waveform="${channel}"]`).getAttribute("data-graph-interaction"), expected);
  };
  try {
    ownership("browser"); await f.start(); f.data(0n); f.data(80_000_000n); f.flush();
    f.pointer("voltage", "down", 1); ownership("browser");
    await f.stop(); ownership("graph");
    const latest = f.state().rightEdge;
    f.pointer("voltage", "move", 1, 500); assert.equal(f.state().rightEdge, latest);
    f.position(500); f.scale("voltage", 1); f.scale("current", 0.1);
    const cursor = f.state().rightEdge; const scales = { ...f.app.graphPolicy.scaleIndices };
    const records = f.owner.model.recordSnapshot();
    f.pointer("voltage", "down", 2); assert.equal(canvas().captured.size, 1);
    if (failure === "hello") {
      await f.owner.actions.close();
      const opening = f.owner.actions.open(); ownership("browser"); f.socket().open(); await opening;
    } else await f.owner.actions.start();
    ownership("browser"); assert.equal(canvas().captured.size, 0, "capture is released immediately on pending start/open");
    f.pointer("voltage", "move", 2, 900); f.timeout(); ownership("graph");
    assert.equal(f.owner.adapter.controlState, "CLOSED");
    assert.equal(f.state().rightEdge, cursor); assert.deepEqual(f.app.graphPolicy.scaleIndices, scales);
    assert.deepEqual(f.owner.model.recordSnapshot(), records);
    const counts = { ...f.counts };
    f.pointer("voltage", "move", 2, 1000); assert.equal(f.state().rightEdge, cursor);
    f.pointer("voltage", "down", 3); f.pointer("voltage", "move", 3, 130);
    assert.notEqual(f.state().rightEdge, cursor); assert.deepEqual(f.counts, counts);
    await f.start(2); ownership("browser"); assert.equal(canvas().captured.size, 0);
    f.pointer("voltage", "move", 3, 900); assert.equal(f.app.historyReview.rightEdgeTimestampUs, null);
  } finally { f.dispose(); }
});

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
  const surface = { setAttribute() {}, getBoundingClientRect: () => ({ width: 640, height: 288 }), captured: new Set(),
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

test("LIVE canvas gestures are inactive; native X controls follow latest and STOPPED X/Y pinches share controls", async () => {
  const f = fixture();
  try {
    await f.start(); f.data(0n); f.data(80_000_000n); f.window(10); f.flush();
    const scales = { ...f.app.graphPolicy.scaleIndices }; const latest = f.state().rightEdge;
    const counts = { ...f.counts };
    f.pointer("current", "down", 1, 100, 50); f.pointer("current", "down", 2, 150, 100);
    f.pointer("current", "move", 2, 150, 270);
    assert.deepEqual(f.app.graphPolicy.scaleIndices, scales);
    f.pointer("current", "up", 2); f.pointer("current", "move", 1, 900, 50); f.pointer("current", "up", 1);
    assert.equal(f.state().rightEdge, latest);
    f.pointer("voltage", "down", 1, 100, 100); f.pointer("voltage", "down", 2, 200, 140);
    f.pointer("voltage", "move", 2, 400, 140); f.flush();
    assert.equal(f.app.graphPolicy.windowSeconds, 10);
    assert.deepEqual(f.app.graphPolicy.scaleIndices, scales);
    assert.deepEqual(f.counts, counts);
    for (const channel of ["voltage", "current"]) assert.equal(f.root.querySelector(`[data-waveform="${channel}"]`).captureCalls, 0);
    assert.equal(f.state().domain.maximum, 80);
    f.pointer("voltage", "up", 1); f.pointer("voltage", "up", 2);
    f.window(30); f.zoom("x", "in"); f.flush();
    assert.equal(f.app.graphPolicy.windowSeconds, 10); assert.equal(f.state().domain.maximum, 80);
    await f.stop();
    f.pointer("voltage", "down", 1, 100, 100); f.pointer("voltage", "down", 2, 200, 140);
    f.pointer("voltage", "move", 2, 400, 140); f.flush();
    assert.ok(f.app.graphPolicy.windowSeconds < 10);
    assert.equal(f.root.querySelector("[data-display-window]").value, String(f.app.graphPolicy.windowSeconds));
    f.pointer("voltage", "up", 1); f.pointer("voltage", "up", 2);
    f.scale("current", 0.1);
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
  assert.match(css, /\.graph-panel canvas\[data-graph-interaction="browser"\]\s*\{ touch-action: auto; \}/);
  assert.match(css, /\.graph-panel canvas\[data-graph-interaction="graph"\]\s*\{ touch-action: none; \}/);
  assert.equal((css.match(/touch-action:/g) ?? []).length, 2);
  assert.match(css, /\.scale-readout[^}]*text-align: center[^}]*pointer-events: none/);
  assert.match(css, /\.axis-controls[^}]*flex-wrap: wrap/);
  assert.match(css, /button:disabled[^}]*opacity: 1;[^}]*color: var\(--text-muted\)[^}]*border-style: dashed/);
});
