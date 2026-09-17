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

test("viewportAutoScaleIndex is a pure function of the visible values and holds when nothing positive is visible", () => {
  for (const scales of [VOLTAGE_SCALES, CURRENT_SCALES]) {
    const peak = scales[Math.floor(scales.length / 2)];
    const expected = viewportAutoScaleIndex(scales, 0, [peak]);
    for (let start = 0; start < scales.length; start += 1) {
      assert.equal(viewportAutoScaleIndex(scales, start, [peak]), expected, "the result never depends on the index it started from");
    }
    assert.equal(viewportAutoScaleIndex(scales, 2, []), 2, "an empty viewport holds the current scale");
    assert.equal(viewportAutoScaleIndex(scales, 2, [null, -1]), 2, "so does a viewport with no positive peak");
    assert.ok(scales[expected] * 9 >= peak, "the selected scale contains the visible peak in nine divisions");
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
