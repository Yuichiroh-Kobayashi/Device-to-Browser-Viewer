import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CURRENT_SCALES, VOLTAGE_SCALES, Y_PRESENTATION_STATES, constructGraphFrame, makeTimeDomain, viewportAutoScaleIndex } from "../graph/graph-core.js";
import { plotGeometry } from "../graph/waveform-canvas.js";
import { createStoppedHistoryCsv } from "../history-csv.js";
import { fixture } from "./history-fixture.mjs";

// The fixture canvas is 640x288, so the plot is 542x218 with its floor at
// client y = pad.top + ph = 254. A vertical drag of ph pixels therefore moves
// the origin by exactly nine divisions.
const { ph, pad } = plotGeometry({ width: 640, height: 288 });
const PLOT_FLOOR = pad.top + ph;

/** Two records inside the default 60 s window, so the graph has a real path. */
async function stopped(f, options = {}) {
  await f.start();
  f.data(0n, { voltage: 1, current: 0.1, ...options });
  f.data(1_000_000n, { voltage: 1, current: 0.1, ...options });
  f.flush();
  await f.stop();
  f.flush();
}

const dragY = (f, channel, pixels) => {
  f.pointer(channel, "down", 1, 100, 100);
  f.pointer(channel, "move", 1, 100, 100 + pixels);
  f.pointer(channel, "up", 1);
  f.flush();
};

test("normal Stop latches zero origin and the last live scale, and X review never moves Y", async () => {
  const f = fixture();
  try {
    await f.start();
    f.data(0n, { voltage: 1, current: 0.1 }); f.data(1_000_000n, { voltage: 1, current: 0.1 }); f.flush();
    for (const channel of ["voltage", "current"]) assert.equal(f.yState(channel).mode, "LIVE_AUTO_ZERO");
    const live = { voltage: f.yState("voltage").scale, current: f.yState("current").scale };
    await f.stop(); f.flush();
    for (const channel of ["voltage", "current"]) {
      assert.equal(f.yState(channel).mode, "STOPPED_LATCHED_ZERO");
      assert.equal(f.yState(channel).origin, 0);
      assert.equal(f.yState(channel).scale, live[channel], "the last live frame's scale is latched, per channel");
    }
    for (const position of [0, 250, 500, 1000]) {
      f.position(position); f.flush();
      for (const channel of ["voltage", "current"]) {
        assert.equal(f.yState(channel).mode, "STOPPED_LATCHED_ZERO");
        assert.equal(f.yState(channel).origin, 0);
        assert.equal(f.yState(channel).scale, live[channel]);
      }
    }
    for (const seconds of [1, 10, 60]) {
      f.window(seconds); f.flush();
      assert.equal(f.yState("voltage").scale, live.voltage, "an X window change alone never re-evaluates a latched Y scale");
    }
  } finally { f.dispose(); }
});

test("every manual Y route enters STOPPED_MANUAL_FREE for that channel alone", async () => {
  const f = fixture();
  try {
    await stopped(f);
    const routes = [
      ["vertical pan", (channel) => dragY(f, channel, 60)],
      ["scale dropdown", (channel) => { f.scale(channel, channel === "voltage" ? VOLTAGE_SCALES[3] : CURRENT_SCALES[3]); f.flush(); }],
      ["zoom in button", (channel) => { f.zoom(channel, "in"); f.flush(); }],
      ["zoom out button", (channel) => { f.zoom(channel, "out"); f.flush(); }],
      ["Y pinch", (channel) => {
        f.pointer(channel, "down", 1, 100, 100); f.pointer(channel, "down", 2, 150, 140);
        f.pointer(channel, "move", 2, 150, 270); f.pointer(channel, "up", 1); f.pointer(channel, "up", 2); f.flush();
      }],
    ];
    for (const [name, act] of routes) {
      for (const [channel, other] of [["voltage", "current"], ["current", "voltage"]]) {
        f.auto(channel); f.auto(other); f.flush();
        assert.equal(f.yState(other).mode, "STOPPED_AUTO_ZERO");
        act(channel);
        assert.equal(f.yState(channel).mode, "STOPPED_MANUAL_FREE", `${name} on ${channel}`);
        assert.equal(f.yState(other).mode, "STOPPED_AUTO_ZERO", `${name} on ${channel} leaves ${other} alone`);
      }
    }
  } finally { f.dispose(); }
});

test("vertical pan moves origin by the dragged fraction of nine divisions and never the scale", async () => {
  const f = fixture();
  try {
    await stopped(f);
    for (const channel of ["voltage", "current"]) {
      const before = f.yState(channel);
      dragY(f, channel, ph);
      const after = f.yState(channel);
      assert.equal(after.scale, before.scale, "pan alone never changes the discrete scale");
      assert.ok(Math.abs(after.origin - (before.origin + 9 * before.scale)) < 1e-12, "a full-plot drag is exactly nine divisions");
      dragY(f, channel, -ph / 2);
      assert.ok(Math.abs(f.yState(channel).origin - (after.origin - 4.5 * before.scale)) < 1e-12, "dragging back is symmetric");
      assert.equal(f.yState(channel).scale, before.scale);
    }
  } finally { f.dispose(); }
});

test("the numeric Y axis and the waveform consume the same origin, so the trace and the labels move together", async () => {
  const f = fixture();
  try {
    await stopped(f);
    const scale = f.yState("voltage").scale;
    const beforeTicks = f.ticks("voltage");
    const beforePoints = f.waveform("voltage");
    assert.ok(beforePoints.length >= 2, "the stopped voltage graph draws a real path");
    assert.equal(beforeTicks.length, 10, "ten labelled divisions");

    dragY(f, "voltage", 109);
    const origin = f.yState("voltage").origin;
    assert.ok(Math.abs(origin - 4.5 * scale) < 1e-12);
    const afterTicks = f.ticks("voltage");
    const afterPoints = f.waveform("voltage");
    assert.equal(f.yState("voltage").scale, scale);
    assert.equal(afterTicks.length, beforeTicks.length);
    assert.notDeepEqual(afterTicks, beforeTicks, "the numeric axis is relabelled from the new origin");
    assert.equal(afterPoints.length, beforePoints.length);
    for (const [index, point] of afterPoints.entries()) {
      assert.ok(Math.abs(point.x - beforePoints[index].x) < 1e-9, "a vertical pan never moves the trace horizontally");
      assert.ok(Math.abs(point.y - (beforePoints[index].y + 109)) < 1e-9, "the trace follows the pointer by exactly the dragged pixels");
    }
    // The axis labels are the same nine divisions counted up from the origin,
    // which is what makes a visually shifted waveform against a fixed axis
    // impossible rather than merely unintended.
    assert.equal(afterTicks[0], "0.9 V");
    assert.equal(afterTicks.at(-1), "2.7 V");
  } finally { f.dispose(); }
});

test("Y Auto zeroes the origin and fits the current visible X viewport from the existing ladder", async () => {
  const f = fixture();
  try {
    await f.start();
    f.data(0n, { voltage: 3, current: 0.1 });
    f.data(500_000n, { voltage: 3, current: 0.1 });
    f.data(4_000_000n, { voltage: 0.05, current: 0.1 });
    f.data(4_500_000n, { voltage: 0.05, current: 0.1 });
    f.flush(); await f.stop(); f.window(1); f.flush();

    dragY(f, "voltage", 80); f.scale("voltage", VOLTAGE_SCALES.at(-1)); f.flush();
    assert.equal(f.yState("voltage").mode, "STOPPED_MANUAL_FREE");
    assert.notEqual(f.yState("voltage").origin, 0);

    f.auto("voltage"); f.flush();
    assert.equal(f.yState("voltage").mode, "STOPPED_AUTO_ZERO");
    assert.equal(f.yState("voltage").origin, 0, "Auto returns the origin to exactly zero");
    assert.equal(f.state().domain.maximum, 4.5);
    assert.equal(f.yState("voltage").scale, VOLTAGE_SCALES[viewportAutoScaleIndex(VOLTAGE_SCALES, 0, [0.05, 0.05])]);
    assert.equal(f.yState("voltage").scale, 0.1, "the 0.05 V tail viewport selects the ladder minimum");

    f.position(0); f.flush();
    assert.equal(f.state().domain.maximum, 1);
    assert.equal(f.yState("voltage").mode, "STOPPED_AUTO_ZERO");
    assert.equal(f.yState("voltage").scale, 0.5, "AUTO_ZERO re-fits deterministically to the 3 V head viewport");
    assert.equal(f.yState("voltage").origin, 0);

    f.position(1000); f.flush();
    assert.equal(f.yState("voltage").scale, 0.1, "and back again, with no dependence on the path taken");

    // A manual operation after Auto takes the channel out of AUTO_ZERO, and X
    // review then stops re-evaluating the scale at all.
    f.scale("voltage", 2); f.flush();
    assert.equal(f.yState("voltage").mode, "STOPPED_MANUAL_FREE");
    for (const position of [0, 500, 1000]) {
      f.position(position); f.flush();
      assert.equal(f.yState("voltage").scale, 2, "manual scale survives every X viewport change");
      assert.equal(f.yState("voltage").origin, 0);
    }
    f.window(10); f.flush();
    assert.equal(f.yState("voltage").scale, 2, "and every X window change");
  } finally { f.dispose(); }
});

test("viewportAutoScaleIndex derives from the visible values when a non-negative peak exists, and otherwise retains the current scale", () => {
  for (const scales of [VOLTAGE_SCALES, CURRENT_SCALES]) {
    const peak = scales[Math.floor(scales.length / 2)];
    const expected = viewportAutoScaleIndex(scales, 0, [peak]);
    for (let start = 0; start < scales.length; start += 1) {
      assert.equal(viewportAutoScaleIndex(scales, start, [peak]), expected, "with a qualifying peak the result never depends on the index it started from");
    }
    assert.ok(scales[expected] * 9 >= peak, "the selected scale contains the visible peak in nine divisions");
    // No qualifying non-negative peak: the retained scale is the answer, so
    // here the result does depend on the current index by design.
    for (const values of [[], [null, -1], [null, null], [-0.5, -0.01]]) {
      for (const start of [0, 2, scales.length - 1]) {
        assert.equal(viewportAutoScaleIndex(scales, start, values), start, "nothing to fit, so the existing stopped scale is retained");
      }
    }
    assert.equal(viewportAutoScaleIndex(scales, 3, [0, 0]), 0, "an exactly-zero peak still qualifies and fits the ladder minimum");
  }
});

test("Y pinch quantizes to the existing ladder and keeps the gesture midpoint value fixed", async () => {
  const f = fixture();
  try {
    await stopped(f);
    f.scale("voltage", 1); f.flush();
    const fraction = (PLOT_FLOOR - 120) / ph;
    const anchorValue = f.yState("voltage").origin + fraction * 9 * f.yState("voltage").scale;
    f.pointer("voltage", "down", 1, 100, 100);
    f.pointer("voltage", "down", 2, 150, 140);
    f.pointer("voltage", "move", 2, 150, 270);
    f.flush();
    const { scale, origin, mode } = f.yState("voltage");
    assert.equal(mode, "STOPPED_MANUAL_FREE");
    assert.ok(VOLTAGE_SCALES.includes(scale), "the pinch result is always a ladder value");
    assert.ok(scale < 1, "pinching apart vertically selects a finer scale");
    assert.ok(Math.abs((origin + fraction * 9 * scale) - anchorValue) < 1e-9, "the value under the gesture midpoint is preserved across the scale step");
    f.pointer("voltage", "cancel", 1); f.pointer("voltage", "cancel", 2);
    assert.equal(f.root.querySelector('[data-waveform="voltage"]').captured.size, 0);
  } finally { f.dispose(); }
});

test("one pointer locks to a single axis and keeps it through dominance reversal", async () => {
  const f = fixture();
  try {
    await f.start();
    for (const seconds of [0, 1, 2, 3, 4]) f.data(BigInt(seconds) * 1_000_000n, { voltage: 1, current: 0.1 });
    f.flush(); await f.stop(); f.window(1); f.flush();
    assert.notEqual(f.state().earliest, f.state().latest, "the review range must be pannable for this test to mean anything");

    const horizontalStart = { cursor: f.state().rightEdge, origin: f.yState("voltage").origin };
    f.pointer("voltage", "down", 1, 300, 100);
    f.pointer("voltage", "move", 1, 380, 104);
    f.flush();
    assert.notEqual(f.state().rightEdge, horizontalStart.cursor, "horizontal dominance pans the review cursor");
    assert.equal(f.yState("voltage").origin, horizontalStart.origin, "and never the Y origin");
    assert.equal(f.yState("voltage").mode, "STOPPED_LATCHED_ZERO", "an X pan is not a manual Y operation");
    const lockedCursor = f.state().rightEdge;
    f.pointer("voltage", "move", 1, 380, 260);
    f.flush();
    assert.equal(f.yState("voltage").origin, horizontalStart.origin, "reversing to vertical dominance does not switch axis");
    f.pointer("voltage", "up", 1);

    const verticalStart = { cursor: f.state().rightEdge, origin: f.yState("voltage").origin };
    assert.equal(verticalStart.cursor, lockedCursor);
    f.pointer("voltage", "down", 2, 300, 100);
    f.pointer("voltage", "move", 2, 304, 180);
    f.flush();
    assert.notEqual(f.yState("voltage").origin, verticalStart.origin, "vertical dominance pans Y");
    assert.equal(f.state().rightEdge, verticalStart.cursor, "and never the review cursor");
    assert.equal(f.yState("voltage").mode, "STOPPED_MANUAL_FREE");
    f.pointer("voltage", "move", 2, 900, 180);
    f.flush();
    assert.equal(f.state().rightEdge, verticalStart.cursor, "reversing to horizontal dominance does not switch axis");
    f.pointer("voltage", "cancel", 2);
    f.flush();

    // Below the lock threshold neither axis is chosen and nothing moves.
    const still = { cursor: f.state().rightEdge, origin: f.yState("voltage").origin };
    f.pointer("voltage", "down", 3, 300, 100);
    f.pointer("voltage", "move", 3, 303, 103);
    f.flush();
    assert.equal(f.state().rightEdge, still.cursor);
    assert.equal(f.yState("voltage").origin, still.origin);
    f.pointer("voltage", "up", 3);
  } finally { f.dispose(); }
});

test("a pinch remainder never becomes a Y pan, and cancel/remount/destroy leave no gesture state", async () => {
  const f = fixture();
  try {
    await stopped(f);
    f.pointer("voltage", "down", 1, 100, 100);
    f.pointer("voltage", "down", 2, 150, 140);
    f.pointer("voltage", "move", 2, 150, 200); f.flush();
    const afterPinch = f.yState("voltage");
    f.pointer("voltage", "up", 2);
    f.pointer("voltage", "move", 1, 100, 400); f.flush();
    assert.deepEqual(f.yState("voltage"), afterPinch, "the surviving finger cannot continue as a one-pointer Y pan");
    f.pointer("voltage", "up", 1);

    f.pointer("current", "down", 5, 100, 100);
    f.app.controller.toggle();
    const remounted = f.root.querySelector('[data-waveform="current"]');
    assert.equal(remounted.captured.size, 0);
    const preserved = f.yState("current");
    f.pointer("current", "move", 5, 100, 400); f.flush();
    assert.deepEqual(f.yState("current"), preserved, "a gesture abandoned by a remount cannot resume against the new canvas");

    f.pointer("current", "down", 6, 100, 100);
    f.app.destroy();
    assert.equal(remounted.captured.size, 0);
    assert.equal(remounted.onpointermove, null);
  } finally { f.dispose(); }
});

test("LIVE stays zero-origin with manual Y refused and both lower bounds exactly zero", async () => {
  const f = fixture();
  try {
    await f.start();
    f.data(0n, { voltage: 1, current: 0.1 }); f.data(1_000_000n, { voltage: 1, current: 0.1 }); f.flush();
    for (const channel of ["voltage", "current"]) {
      const before = f.yState(channel);
      dragY(f, channel, 120);
      f.pointer(channel, "down", 1, 100, 100); f.pointer(channel, "down", 2, 150, 140);
      f.pointer(channel, "move", 2, 150, 270); f.pointer(channel, "up", 1); f.pointer(channel, "up", 2);
      f.scale(channel, channel === "voltage" ? VOLTAGE_SCALES.at(-1) : CURRENT_SCALES.at(-1));
      f.zoom(channel, "in"); f.zoom(channel, "out"); f.flush();
      assert.deepEqual(f.yState(channel), before, "no LIVE route reaches manual Y origin or scale");
      assert.equal(f.yState(channel).mode, "LIVE_AUTO_ZERO");
      assert.equal(f.yState(channel).origin, 0);
      const auto = f.root.querySelector(`[data-y-auto="${channel}"]`);
      assert.equal(auto.disabled, true, "Auto is disabled in LIVE");
      assert.equal(auto.hidden, false, "but stays mounted");
      assert.equal(auto.getAttribute("aria-pressed"), "true", "and reads as already current");
      assert.equal(auto.dataset.yMode, "LIVE_AUTO_ZERO");
      f.auto(channel); f.flush();
      assert.equal(f.yState(channel).mode, "LIVE_AUTO_ZERO");
    }
    assert.equal(f.ticks("voltage")[0], "0 V", "LIVE voltage lower bound is exactly 0 V");
    assert.equal(f.ticks("current")[0], "0 A", "LIVE current lower bound is exactly 0 A");
  } finally { f.dispose(); }
});

test("Auto controls are enabled, per channel and state-labelled during stopped review", async () => {
  const f = fixture();
  try {
    await stopped(f);
    const auto = (channel) => f.root.querySelector(`[data-y-auto="${channel}"]`);
    for (const channel of ["voltage", "current"]) {
      assert.equal(auto(channel).disabled, false);
      assert.equal(auto(channel).dataset.yMode, "STOPPED_LATCHED_ZERO");
      assert.equal(auto(channel).getAttribute("aria-pressed"), "false");
    }
    f.auto("voltage"); f.flush();
    assert.equal(auto("voltage").dataset.yMode, "STOPPED_AUTO_ZERO");
    assert.equal(auto("voltage").getAttribute("aria-pressed"), "true");
    assert.equal(auto("current").dataset.yMode, "STOPPED_LATCHED_ZERO", "Auto is per channel");
    dragY(f, "voltage", 60);
    assert.equal(auto("voltage").dataset.yMode, "STOPPED_MANUAL_FREE");
    assert.equal(auto("voltage").getAttribute("aria-pressed"), "false");
    assert.equal(f.root.querySelector('[data-y-scale="voltage"]').value, String(f.yState("voltage").scale), "the dropdown stays synchronized with pan/pinch state");
  } finally { f.dispose(); }
});

test("Y state survives Student/Professional remount and a failed next start, and resets on an accepted stream", async () => {
  const f = fixture();
  try {
    await stopped(f);
    dragY(f, "voltage", 90);
    f.auto("current"); f.flush();
    const panned = { voltage: f.yState("voltage"), current: f.yState("current") };
    assert.equal(panned.voltage.mode, "STOPPED_MANUAL_FREE");
    assert.notEqual(panned.voltage.origin, 0);

    const policy = f.app.graphPolicy;
    for (const mode of ["professional", "student", "professional"]) {
      f.app.controller.setMode(mode); f.flush();
      assert.strictEqual(f.app.graphPolicy, policy, "remount never creates a second Y state owner");
      assert.deepEqual(f.yState("voltage"), panned.voltage);
      assert.deepEqual(f.yState("current"), panned.current);
    }
    f.app.controller.setMode("student"); f.flush();

    // H-R1 shape: the next Start never reaches STREAMING, so the previously
    // accepted stopped review keeps its own Y authority intact.
    await f.owner.actions.start();
    f.timeout(); f.flush();
    assert.equal(f.owner.adapter.controlState, "CLOSED");
    assert.deepEqual(f.yState("voltage"), panned.voltage, "a failed next start does not discard stopped Y state");
    assert.deepEqual(f.yState("current"), panned.current);

    await f.start(2); f.flush();
    for (const channel of ["voltage", "current"]) {
      assert.equal(f.yState(channel).mode, "LIVE_AUTO_ZERO", "an accepted new stream returns both channels to LIVE");
      assert.equal(f.yState(channel).origin, 0);
    }
  } finally { f.dispose(); }
});

test("Y origin and scale operations leave measurement, history, CSV, transport and runtime identity untouched", async () => {
  const f = fixture();
  try {
    await f.start();
    f.data(0n, { voltage: 1, current: 0.1 });
    f.data(1_000_000n, { voltage: 1, current: -0.01 });
    f.data(2_000_000n, { voltage: 1, current: 0.1 });
    f.flush(); await f.stop(); f.flush();

    const records = f.owner.model.recordSnapshot();
    const summary = f.owner.model.summary();
    const history = f.owner.model.historySummary();
    const csv = createStoppedHistoryCsv(f.owner.model, f.owner.stoppedHistoryReady);
    const counts = { ...f.counts };
    const decoder = f.owner.adapter.decoderState;
    const owner = f.app.owner;
    const adapter = f.owner.adapter;
    const epoch = f.owner.model.historyEpoch;

    for (const channel of ["voltage", "current"]) {
      dragY(f, channel, 150); dragY(f, channel, -220);
      f.scale(channel, channel === "voltage" ? 2 : 0.05);
      f.zoom(channel, "in"); f.auto(channel);
      f.pointer(channel, "down", 1, 100, 100); f.pointer(channel, "down", 2, 150, 140);
      f.pointer(channel, "move", 2, 150, 250); f.pointer(channel, "up", 1); f.pointer(channel, "up", 2);
      f.flush();
    }
    assert.equal(f.yState("voltage").mode, "STOPPED_MANUAL_FREE");

    assert.deepEqual(f.owner.model.recordSnapshot(), records, "retained measurements are value-identical");
    assert.deepEqual(f.owner.model.summary(), summary);
    assert.deepEqual(f.owner.model.historySummary(), history);
    assert.equal(f.owner.model.historyEpoch, epoch);
    assert.equal(createStoppedHistoryCsv(f.owner.model, f.owner.stoppedHistoryReady), csv, "CSV bytes are unchanged by any Y operation");
    assert.deepEqual(f.counts, counts, "no Y operation constructs, sends on or closes a WebSocket");
    assert.strictEqual(f.app.owner, owner, "the sole RuntimeOwner identity is unchanged");
    assert.strictEqual(f.owner.adapter, adapter);
    assert.strictEqual(f.owner.adapter.decoderState, decoder);
  } finally { f.dispose(); }
});

test("path breaks, invalid samples and the reverse-current observation do not depend on the Y origin", async () => {
  const f = fixture();
  try {
    await f.start();
    f.data(0n); f.data(40_000n);
    f.data(200_000n, { sequence: 7n, flags: 4 });
    f.data(240_000n, { validMask: 1 });
    f.data(280_000n, { current: -0.01 });
    f.flush(); await f.stop(); f.flush();

    const records = f.owner.model.recordSnapshot();
    const domain = makeTimeDomain(0n, 280_000n, 60);
    const frameFor = (channel, origin, scale) => constructGraphFrame({ records, channel, scale, domain, originTimestampUs: 0n, origin });

    const shape = (frame) => frame.paths.map(path => path.map(point => Number(point.x.toFixed(9))));
    for (const channel of ["voltage", "current"]) {
      const reference = frameFor(channel, 0, 1);
      for (const origin of [-3, -2, -1, -0.25]) {
        const shifted = frameFor(channel, origin, 1);
        assert.deepEqual(shape(shifted), shape(reference), `${channel} segment/gap/timebase path breaks are origin independent`);
        assert.deepEqual(shifted.invalid, reference.invalid, `${channel} invalid samples stay where they are`);
        assert.equal(shifted.origin, origin);
      }
      // Clipping itself does follow the origin: a trace panned below the
      // viewport leaves the plot rather than being drawn against its floor.
      assert.deepEqual(frameFor(channel, 100, 1).paths, []);
      assert.equal(frameFor(channel, 100, 1).plotState, "clipped-out");
      assert.equal(frameFor(channel, 100, 1).measurementState, "valid", "clipped out is not the same as no data");
    }
    // A negative current stays an observation of the X window, so a future
    // reverse-current warning (Viewer #14) can be presented outside the
    // clipped plot and does not disappear when the viewer pans that value
    // off the visible Y viewport.
    const reverse = frameFor("current", 0, 1).reverseObservation;
    assert.equal(reverse.observedInWindow, true);
    // The wire value is float32, so compare against the decoded record rather
    // than the float64 literal the fixture was asked to send.
    assert.equal(reverse.mostNegative, records.at(-1).current_A);
    assert.ok(reverse.mostNegative < 0);
    for (const origin of [0.5, 5, 50]) {
      assert.deepEqual(frameFor("current", origin, 1).reverseObservation, reverse, "panning the negative value out of view does not erase the observation");
    }
    assert.deepEqual(f.owner.model.recordSnapshot(), records, "signed current remains model authority");
  } finally { f.dispose(); }
});

test("the Y presentation seam stays pure: no transport, protocol, DOM or proprietary gesture reference", () => {
  const core = readFileSync(new URL("../graph/graph-core.js", import.meta.url), "utf8");
  const interaction = readFileSync(new URL("../presentation/graph-interaction.js", import.meta.url), "utf8");
  const controls = readFileSync(new URL("../presentation/graph-controls.js", import.meta.url), "utf8");
  const code = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  for (const [name, source] of [["graph-core", core], ["graph-interaction", interaction], ["graph-controls", controls]]) {
    for (const line of source.split("\n").filter(entry => entry.startsWith("import "))) {
      assert.doesNotMatch(line, /source-export|d2b-reference|protocol|runtime-owner|history-csv/, `${name} imports no transport, protocol or measurement authority`);
    }
    assert.doesNotMatch(code(source), /WebSocket|SessionAdapter|RuntimeOwner|decodeVi|handleBinary|commitCandidate/, `${name} reaches no transport or measurement API`);
    assert.doesNotMatch(code(source), /gesturestart|gesturechange|webkit|userAgent/, `${name} uses no proprietary gesture API`);
  }
  assert.doesNotMatch(code(core), /document\.|window\.|getContext|getBoundingClientRect/, "the Y state model is DOM and canvas free");
  assert.deepEqual([...Y_PRESENTATION_STATES], ["LIVE_AUTO_ZERO", "STOPPED_LATCHED_ZERO", "STOPPED_AUTO_ZERO", "STOPPED_MANUAL_FREE"]);
  // The renderer must derive the axis labels and the waveform transform from
  // the one frame origin rather than from two independently computed values.
  const canvas = readFileSync(new URL("../graph/waveform-canvas.js", import.meta.url), "utf8");
  assert.match(canvas, /const origin = frame\.origin \?\? 0;/);
  assert.match(canvas, /const yOf = \(y\) => pad\.top \+ ph - \(y - origin\) \/ \(frame\.scale \* 9\) \* ph;/);
  assert.match(canvas, /formatYAxisTick\(origin \+ i \* frame\.scale, this\.channel, frame\.scale\)/);
  assert.equal((canvas.match(/const yOf =/g) ?? []).length, 1, "there is exactly one Y transform");
});

// --- Issue #25 review finding A-01 -------------------------------------
// Only an accepted new stream may discard the Y presentation authority of a
// previously accepted normal-Stop session. An open attempt, CONNECTING, a
// pending hello, a pending Start, a hello/start timeout, a transport failure
// or a force close must leave it byte-identical -- including across the
// renders that happen while the attempt is in flight, when review readiness
// is temporarily false and the frame is built against a different X domain.

/** Head: negative-only current. Tail: a large positive current at latest. */
async function splitPolaritySession(f) {
  await f.start();
  for (const step of [0, 1, 2]) f.data(BigInt(step) * 500_000n, { voltage: 1, current: -0.01 });
  for (const step of [6, 7, 8]) f.data(BigInt(step) * 500_000n, { voltage: 3, current: 0.5 });
  f.flush();
  await f.stop();
  f.flush();
}

// CSV is itself readiness-gated, so it is compared only while review is
// available; mid-flight it must be refused, not silently produced.
const ySnapshot = (f) => ({
  voltage: f.yState("voltage"),
  current: f.yState("current"),
  rightEdge: f.state().rightEdge,
  window: f.owner.model.displayWindowSeconds,
  domain: f.state().domain,
  history: f.owner.model.historySummary(),
});

for (const failure of ["start", "hello"]) {
  test(`A-01 negative-only AUTO_ZERO viewport survives a failed ${failure} with renders in flight`, async () => {
    const f = fixture();
    try {
      await splitPolaritySession(f);
      f.window(1); f.position(0); f.flush();
      assert.deepEqual(f.state().domain, { minimum: 0, maximum: 1 }, "review sits on the negative-only head");

      // Hold a scale that the tail viewport would not choose, then Auto. With
      // no qualifying non-negative peak in view, Auto retains that scale.
      f.scale("current", 0.001); f.flush();
      f.auto("current"); f.flush();
      assert.equal(f.yState("current").mode, "STOPPED_AUTO_ZERO");
      assert.equal(f.yState("current").scale, 0.001, "no non-negative peak in view, so the existing scale is retained");

      const before = ySnapshot(f);
      const beforeCsv = createStoppedHistoryCsv(f.owner.model, f.owner.stoppedHistoryReady);
      const constructed = f.counts.construct;
      const records = f.owner.model.recordSnapshot();
      // The attempt itself legitimately sends a control and its timeout force
      // closes, so transport counts are compared across the renders rather
      // than across the attempt: a repaint must generate no traffic at all.
      const renderCounts = (label) => {
        const counts = { ...f.counts };
        for (let render = 0; render < 3; render += 1) { f.app.presentation.update(); f.flush(); }
        assert.deepEqual(f.counts, counts, `renders ${label} generate no transport traffic`);
      };

      if (failure === "hello") {
        await f.owner.actions.close();
        const opening = f.owner.actions.open();
        assert.equal(f.owner.stoppedHistoryReady, false, "review is unavailable while the socket is connecting");
        renderCounts("while connecting");
        assert.deepEqual(ySnapshot(f), before, "a render while connecting must not re-evaluate stopped Y authority");
        f.socket().open(); await opening;
      } else {
        await f.owner.actions.start();
      }
      assert.equal(f.owner.stoppedHistoryReady, false, "review is unavailable while the attempt is pending");

      // Renders in flight: review is disabled, so the frame follows latest and
      // sees the positive tail instead of the reviewed head.
      renderCounts("during the pending attempt");
      assert.deepEqual(ySnapshot(f), before, "a render during the pending attempt must not re-evaluate stopped Y authority");
      assert.throws(() => createStoppedHistoryCsv(f.owner.model, f.owner.stoppedHistoryReady), "CSV stays refused while the attempt is pending");

      f.timeout(); f.flush();
      assert.equal(f.owner.adapter.controlState, "CLOSED");
      assert.equal(f.owner.stoppedHistoryReady, true, "the previously accepted stopped review is available again");
      renderCounts("after recovery");
      assert.deepEqual(ySnapshot(f), before, `a failed ${failure} leaves the stopped review authority byte-identical`);
      assert.equal(createStoppedHistoryCsv(f.owner.model, f.owner.stoppedHistoryReady), beforeCsv, "CSV content is restored unchanged");
      assert.deepEqual(f.owner.model.recordSnapshot(), records, "the retained measurements are untouched by the failed attempt");
      assert.equal(f.counts.construct, failure === "hello" ? constructed + 1 : constructed, "only an explicit reopen constructs a socket");
    } finally { f.dispose(); }
  });
}

test("A-01 a positive AUTO_ZERO viewport is equally untouched, and Auto still re-fits after recovery", async () => {
  const f = fixture();
  try {
    await f.start();
    for (const step of [0, 1, 2]) f.data(BigInt(step) * 500_000n, { voltage: 0.05, current: 0.0005 });
    for (const step of [6, 7, 8]) f.data(BigInt(step) * 500_000n, { voltage: 3, current: 0.5 });
    f.flush(); await f.stop(); f.flush();
    f.window(1); f.position(0); f.flush();
    assert.deepEqual(f.state().domain, { minimum: 0, maximum: 1 });

    f.auto("voltage"); f.auto("current"); f.flush();
    const fitted = ySnapshot(f);
    assert.equal(fitted.voltage.scale, 0.1, "the small head viewport fits the ladder minimum");
    assert.equal(fitted.current.scale, 0.0001);

    await f.owner.actions.start();
    assert.equal(f.owner.stoppedHistoryReady, false);
    for (let render = 0; render < 3; render += 1) {
      f.app.presentation.update(); f.flush();
      assert.deepEqual(ySnapshot(f), fitted, "the large tail viewport rendered in flight never reaches the retained state");
    }
    f.timeout(); f.flush();
    assert.equal(f.owner.adapter.controlState, "CLOSED");
    assert.deepEqual(ySnapshot(f), fitted);

    // The gate suppresses re-evaluation only while review is unavailable. The
    // reviewer's own X move must still re-fit, or Auto would be inert.
    f.position(1000); f.flush();
    assert.deepEqual(f.state().domain, { minimum: 3, maximum: 4 });
    assert.equal(f.yState("voltage").mode, "STOPPED_AUTO_ZERO");
    assert.equal(f.yState("voltage").scale, 0.5, "AUTO_ZERO still re-fits to the reviewer's new viewport");
    assert.equal(f.yState("current").scale, 0.1);
    assert.equal(f.yState("voltage").origin, 0);
  } finally { f.dispose(); }
});

test("A-01 an accepted new stream is the one thing that does discard the previous stopped Y authority", async () => {
  const f = fixture();
  try {
    await splitPolaritySession(f);
    f.window(1); f.position(0); f.flush();
    f.scale("current", 0.001); f.auto("current"); dragY(f, "voltage", 70); f.flush();
    const epoch = f.owner.model.historyEpoch;
    assert.equal(f.yState("current").mode, "STOPPED_AUTO_ZERO");
    assert.equal(f.yState("voltage").mode, "STOPPED_MANUAL_FREE");
    assert.notEqual(f.yState("voltage").origin, 0);

    f.pointer("voltage", "down", 9);
    assert.equal(f.gesture("voltage").pointers, 1);

    await f.start(2); f.flush();
    for (const channel of ["voltage", "current"]) {
      assert.equal(f.yState(channel).mode, "LIVE_AUTO_ZERO", `${channel} returns to LIVE`);
      assert.equal(f.yState(channel).origin, 0);
    }
    assert.notEqual(f.owner.model.historyEpoch, epoch, "a new epoch was accepted");
    assert.equal(f.app.historyReview.rightEdgeTimestampUs, null, "the review cursor resets to latest");
    assert.deepEqual(f.gesture("voltage"), { pointers: 0, mode: null, axis: null, baseline: null, captured: 0 });
  } finally { f.dispose(); }
});

test("losing one pointer of a pinch never leaves a usable gesture, by cancel or by lost capture", async () => {
  const f = fixture();
  try {
    await stopped(f);
    for (const [name, drop] of [["pointercancel", (id) => f.pointer("voltage", "cancel", id)], ["lostpointercapture", (id) => f.lostCapture("voltage", id)]]) {
      f.auto("voltage"); f.flush();
      f.pointer("voltage", "down", 1, 100, 100);
      f.pointer("voltage", "down", 2, 150, 140);
      f.pointer("voltage", "move", 2, 150, 240); f.flush();
      assert.equal(f.gesture("voltage").mode, "pinch");
      const afterPinch = f.yState("voltage");

      drop(2);
      assert.equal(f.gesture("voltage").pointers, 1, `${name} on one pointer leaves the other registered`);
      assert.equal(f.gesture("voltage").mode, "pinch", `${name} does not demote the gesture to a pan`);
      f.pointer("voltage", "move", 1, 100, 400); f.flush();
      assert.deepEqual(f.yState("voltage"), afterPinch, `the remainder after ${name} cannot pan`);
      f.pointer("voltage", "move", 1, 600, 100); f.flush();
      assert.deepEqual(f.yState("voltage"), afterPinch);

      drop(1);
      assert.deepEqual(f.gesture("voltage"), { pointers: 0, mode: null, axis: null, baseline: null, captured: 0 },
        `${name} on the last pointer clears mode, axis, baseline and capture`);
      f.pointer("voltage", "move", 1, 600, 400); f.flush();
      assert.deepEqual(f.yState("voltage"), afterPinch, "a move after the gesture ended is not adopted");
    }

    // A remount abandons any in-flight gesture; the new canvas requires a new
    // pointerdown rather than resuming the old stream.
    f.pointer("current", "down", 5, 100, 100);
    const beforeRemount = f.yState("current");
    f.app.controller.toggle(); f.flush();
    assert.deepEqual(f.gesture("current"), { pointers: 0, mode: null, axis: null, baseline: null, captured: 0 });
    f.pointer("current", "move", 5, 100, 400); f.flush();
    assert.deepEqual(f.yState("current"), beforeRemount, "the abandoned gesture does not revive against the new canvas");
  } finally { f.dispose(); }
});
