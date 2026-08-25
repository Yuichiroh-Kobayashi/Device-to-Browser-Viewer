import assert from "node:assert/strict";
import test from "node:test";
import {
  CURRENT_SCALES, GraphPolicyController, VOLTAGE_SCALES, clipLineToRectangle,
  constructGraphFrame, formatScaleReadout, formatStudentValue, formatYAxisTick, makeTimeDomain, makeXAxisTicks,
  timePrecision, updateStagedScale,
} from "../graph/graph-core.js";
import { formatMarkerLabel } from "../graph/waveform-canvas.js";
import { qualityFor, runtimeValueState } from "../presentation/view-state.js";

const record = (seconds, voltage, current, extra = {}) => Object.freeze({
  stream_id: 1, sequence: BigInt(seconds + 1), timestamp_us: BigInt(seconds) * 1_000_000n,
  voltage_V: voltage, current_A: current, segment_id: 1,
  voltage_segment_id: 1, current_segment_id: 1,
  flags: Object.freeze({ gap_samples: 0n, discontinuity: false, timebase_reset: false }), ...extra,
});

test("every staged scale expands at its inclusive eight-division boundary", () => {
  for (const scales of [VOLTAGE_SCALES, CURRENT_SCALES]) {
    for (let index = 0; index < scales.length - 1; index += 1) {
      assert.equal(updateStagedScale(scales, index, [8 * scales[index] * (1 - 1e-12)]).scaleIndex, index);
      assert.ok(updateStagedScale(scales, index, [8 * scales[index]]).scaleIndex > index);
    }
    assert.equal(updateStagedScale(scales, scales.length - 1, [Infinity, 1e20]).scaleIndex, scales.length - 1);
  }
});

test("multi-stage expansion, strict one-stage shrink, invalid hold, and negative-only hold", () => {
  assert.equal(updateStagedScale(VOLTAGE_SCALES, 0, [40]).scaleIndex, VOLTAGE_SCALES.length - 1);
  assert.deepEqual(updateStagedScale(VOLTAGE_SCALES, 4, [3.9]), { scaleIndex: 3, transition: "shrunk", positivePeak: 3.9 });
  assert.equal(updateStagedScale(VOLTAGE_SCALES, 4, [4]).scaleIndex, 4);
  assert.equal(updateStagedScale(CURRENT_SCALES, 8, [-0.2, -0.01]).transition, "held-no-nonnegative");
  assert.equal(updateStagedScale(CURRENT_SCALES, 8, [null, NaN]).transition, "held-no-valid");
});

test("device-time domain covers early, exact-window, and sliding acquisition", () => {
  assert.deepEqual(makeTimeDomain(1_000_000n, 5_000_000n, 10), { minimum: 0, maximum: 10 });
  assert.deepEqual(makeTimeDomain(1_000_000n, 11_000_000n, 10), { minimum: 0, maximum: 10 });
  assert.deepEqual(makeTimeDomain(1_000_000n, 13_500_000n, 10), { minimum: 2.5, maximum: 12.5 });
  assert.equal(timePrecision(10), 1); assert.equal(timePrecision(30), 0); assert.equal(timePrecision(60), 0);
});

test("responsive ticks are deterministic and fit required viewport widths", () => {
  for (const width of [1366, 1024, 768]) for (const window of [10, 30, 60]) {
    const precision = timePrecision(window); const ticks = makeXAxisTicks({ minimum: 0, maximum: window }, precision, width - 98);
    assert.ok(ticks.length >= 2); assert.ok(ticks.length <= Math.floor((width - 98) / (precision ? 58 : 46)));
    assert.ok(ticks.every((tick) => tick.label === tick.value.toFixed(precision)));
  }
});

test("literal Student unit table boundaries, signs, negative zero, and no post-rounding reselection", () => {
  assert.equal(formatStudentValue(0, "voltage"), "0.0 µV"); assert.equal(formatStudentValue(-0, "current"), "0.0 µA");
  assert.equal(formatStudentValue(0.000999, "voltage"), "999.0 µV"); assert.equal(formatStudentValue(0.001, "voltage"), "1.0 mV");
  assert.equal(formatStudentValue(0.99999, "voltage"), "1000.0 mV"); assert.equal(formatStudentValue(1, "voltage"), "1.00 V");
  assert.equal(formatStudentValue(-0.000999, "current"), "-999.0 µA"); assert.equal(formatStudentValue(0.001, "current"), "1.0 mA");
  assert.equal(formatStudentValue(0.99999, "current"), "1000.0 mA"); assert.equal(formatStudentValue(1, "current"), "1.000 A");
});

test("Liang-Barsky clips both crossing directions without rewriting measurements", () => {
  const rectangle = { xMin: 0, xMax: 2, yMin: 0, yMax: 1 };
  const descending = clipLineToRectangle({ x: 0, y: 1 }, { x: 1, y: -1 }, rectangle);
  const ascending = clipLineToRectangle({ x: 1, y: -1 }, { x: 2, y: 1 }, rectangle);
  assert.deepEqual(descending.end, { x: 0.5, y: 0 }); assert.equal(descending.clippedEnd, true);
  assert.deepEqual(ascending.start, { x: 1.5, y: 0 }); assert.equal(ascending.clippedStart, true);
});

test("positive-negative-positive creates two paths and no fabricated zero run", () => {
  const records = [record(0, 1, 0.1), record(1, 1, -0.1), record(2, 1, 0.1)];
  const frame = constructGraphFrame({ records, channel: "current", scale: 0.1, domain: { minimum: 0, maximum: 10 }, originTimestampUs: 0n });
  assert.equal(frame.measurementState, "valid"); assert.equal(frame.plotState, "visible"); assert.equal(frame.paths.length, 2);
  assert.deepEqual(frame.paths.map((path) => path.map((point) => point.y)), [[0.1, 0], [0, 0.1]]);
  assert.deepEqual(records.map((entry) => entry.current_A), [0.1, -0.1, 0.1]);
});

test("invalid, gap, segment, and channel-segment boundaries break paths", () => {
  const variants = [
    [record(0, 1, 0.1), record(1, 1, null), record(2, 1, 0.1)],
    [record(0, 1, 0.1), record(1, 1, 0.2, { flags: { gap_samples: 1n } })],
    [record(0, 1, 0.1), record(1, 1, 0.2, { segment_id: 2 })],
    [record(0, 1, 0.1), record(1, 1, 0.2, { current_segment_id: 2 })],
  ];
  for (const records of variants) {
    const frame = constructGraphFrame({ records, channel: "current", scale: 0.1, domain: { minimum: 0, maximum: 10 }, originTimestampUs: 0n });
    assert.equal(frame.paths.length, 0);
  }
});

test("negative-only stays valid but clipped-out; one isolated valid sample is empty", () => {
  const negative = constructGraphFrame({ records: [record(0, 1, -0.1), record(1, 1, -0.2)], channel: "current", scale: 0.1, domain: { minimum: 0, maximum: 10 }, originTimestampUs: 0n });
  assert.equal(negative.measurementState, "valid"); assert.equal(negative.plotState, "clipped-out");
  assert.deepEqual(negative.reverseObservation, { observedInWindow: true, mostNegative: -0.2 });
  const isolated = constructGraphFrame({ records: [record(0, 1, 0.1)], channel: "current", scale: 0.1, domain: { minimum: 0, maximum: 10 }, originTimestampUs: 0n });
  assert.equal(isolated.measurementState, "valid"); assert.equal(isolated.plotState, "empty");
});

test("controller is presentation-independent and mode/window changes preserve scale state", () => {
  const controller = new GraphPolicyController({ windowSeconds: 10 }); controller.observeLifecycle({ controlState: "STREAMING", streamId: 1 });
  const records = [record(0, 1, 0.1), record(1, 4, 0.8)]; const first = controller.update(records);
  const studentVoltage = first.voltage; const professionalVoltage = first.voltage; assert.strictEqual(studentVoltage, professionalVoltage);
  const voltageIndex = controller.scaleIndices.voltage; controller.setWindowSeconds(30); const both = controller.update(records);
  assert.equal(controller.scaleIndices.voltage, voltageIndex); assert.deepEqual(both.voltage.paths, studentVoltage.paths);
});

test("new STREAMING epoch, TIMEBASE_RESET, and stream change reset graph state while mode does not", () => {
  const controller = new GraphPolicyController(); controller.observeLifecycle({ controlState: "READY" }); controller.observeLifecycle({ controlState: "STREAMING", streamId: 1 });
  controller.update([record(0, 40, 0.8), record(1, 40, 0.8)]); assert.ok(controller.scaleIndices.voltage > 0);
  controller.observeLifecycle({ controlState: "STREAMING", streamId: 1 }); assert.ok(controller.scaleIndices.voltage > 0);
  assert.equal(controller.observeLifecycle({ controlState: "READY", streamId: 1 }), false);
  assert.equal(controller.observeLifecycle({ controlState: "STREAMING", streamId: 1 }), true); assert.equal(controller.scaleIndices.voltage, 0); assert.equal(controller.originTimestampUs, null);
  controller.update([record(0, 40, 0.8), record(1, 40, 0.8)]); assert.equal(controller.observeLifecycle({ controlState: "STREAMING", streamId: 1, timebaseReset: true }), true); assert.equal(controller.scaleIndices.current, 0);
  controller.update([record(0, 40, 0.8), record(1, 40, 0.8)]); assert.equal(controller.observeLifecycle({ controlState: "STREAMING", streamId: 2 }), true); assert.equal(controller.originTimestampUs, null);
});

test("scale evaluation occurs once per authoritative identity, never per repaint", () => {
  const controller = new GraphPolicyController({ windowSeconds: 10 }); controller.observeLifecycle({ controlState: "STREAMING", streamId: 1 });
  controller.update([record(0, 40, 0.8), record(1, 40, 0.8)]); const expanded = controller.scaleIndices.voltage;
  const low = [record(2, 0.1, 0.0001), record(3, 0.1, 0.0001)]; controller.update(low); const afterMeasurement = controller.scaleIndices.voltage;
  assert.equal(afterMeasurement, expanded - 1);
  controller.update(low); assert.equal(controller.scaleIndices.voltage, afterMeasurement, "presentation repaint preserves scale");
  controller.update(low); assert.equal(controller.scaleIndices.voltage, afterMeasurement, "mode-switch repaint preserves scale");
  controller.update(low); assert.equal(controller.scaleIndices.voltage, afterMeasurement, "resize repaint preserves scale");
  const next = [...low, record(4, 0.1, 0.0001)]; controller.update(next); assert.equal(controller.scaleIndices.voltage, afterMeasurement - 1, "new sequence permits one shrink");
  controller.setWindowSeconds(30); const beforeWindow = controller.scaleIndices.voltage; controller.update(next); assert.equal(controller.scaleIndices.voltage, beforeWindow - 1, "window change recalculates once");
  controller.update(next); assert.equal(controller.scaleIndices.voltage, beforeWindow - 1, "window repaint cannot shrink again");
});

test("channel-specific valid identities preserve the invalid channel scale", () => {
  const controller = new GraphPolicyController({ windowSeconds: 10 }); controller.observeLifecycle({ controlState: "STREAMING", streamId: 1 });
  controller.update([record(0, 40, 0.8), record(1, 40, 0.8)]);
  const low = [record(2, 0.1, 0.0001), record(3, 0.1, 0.0001)]; controller.update(low);
  const beforeVoltageOnly = { ...controller.scaleIndices }; const currentIdentity = controller.scaleEvaluationIdentity.current;
  const voltageOnly = [...low, record(4, 0.1, null)]; controller.update(voltageOnly);
  assert.equal(controller.scaleIndices.voltage, beforeVoltageOnly.voltage - 1); assert.equal(controller.scaleIndices.current, beforeVoltageOnly.current); assert.equal(controller.scaleEvaluationIdentity.current, currentIdentity);
  const beforeCurrentOnly = { ...controller.scaleIndices }; const voltageIdentity = controller.scaleEvaluationIdentity.voltage;
  const currentOnly = [...voltageOnly, record(5, null, 0.0001)]; controller.update(currentOnly);
  assert.equal(controller.scaleIndices.current, beforeCurrentOnly.current - 1); assert.equal(controller.scaleIndices.voltage, beforeCurrentOnly.voltage); assert.equal(controller.scaleEvaluationIdentity.voltage, voltageIdentity);
  const beforeInvalid = { ...controller.scaleIndices }; const invalidOnly = [...currentOnly, record(6, null, null), record(7, null, null)]; controller.update(invalidOnly); controller.update(invalidOnly);
  assert.deepEqual(controller.scaleIndices, beforeInvalid);
});

test("invalid annotation is timestamp-only, breaks the path, and does not affect scale", () => {
  const records = [record(0, 1, 0.1), record(1, null, 0.1), record(2, 1, 0.1)];
  const frame = constructGraphFrame({ records, channel: "voltage", scale: 0.5, domain: { minimum: 0, maximum: 10 }, originTimestampUs: 0n });
  assert.deepEqual(frame.invalid, [{ seconds: 1 }]); assert.equal("y" in frame.invalid[0], false); assert.equal(frame.paths.length, 0);
  assert.equal(updateStagedScale(VOLTAGE_SCALES, 1, records.map((entry) => entry.voltage_V)).positivePeak, 1);
});

test("engineering Y-axis labels, staged readouts, and bounded marker causes are preserved", () => {
  assert.equal(formatScaleReadout(0.5, "voltage"), "0.5V/div"); assert.equal(formatScaleReadout(0.01, "current"), "10mA/div"); assert.equal(formatScaleReadout(0.0001, "current"), "100µA/div");
  assert.equal(formatYAxisTick(0, "current", 0.01), "0 A"); assert.equal(formatYAxisTick(0.09, "current", 0.01), "90 mA"); assert.equal(formatYAxisTick(0.0002, "current", 0.0001), "200 µA"); assert.equal(formatYAxisTick(1, "voltage", 0.5), "1.0 V");
  assert.deepEqual(CURRENT_SCALES.map((scale) => formatScaleReadout(scale, "current")), ["100µA/div", "200µA/div", "500µA/div", "1mA/div", "2mA/div", "5mA/div", "10mA/div", "20mA/div", "50mA/div", "100mA/div", "0.2A/div", "0.5A/div", "1.0A/div"]);
  assert.equal(formatYAxisTick(1.8, "current", 0.2), "1.8 A"); assert.equal(formatYAxisTick(4.5, "current", 0.5), "4.5 A"); assert.equal(formatYAxisTick(9, "current", 1), "9.0 A");
  for (const [cause, text] of [["producerOverflow", "producer overflow"], ["outputQueueDrop", "output drop"], ["sourcePaused", "source paused"], ["timebaseReset", "timebase reset"]]) {
    const label = formatMarkerLabel({ kind: "sequence-gap", gap_samples: 3n, causes: { [cause]: true } }); assert.match(label, new RegExp(text)); assert.ok(label.length <= 56);
  }
});

test("data quality remains independent from runtime lifecycle", () => {
  const latest = record(0, 1, 0.1); const owner = { model: { latest }, adapter: { summary: () => ({ controlState: "READY" }) } };
  assert.deepEqual(qualityFor(owner), { overall: "normal", voltage: "normal", current: "normal", gap: false }); assert.equal(runtimeValueState(owner), "停止時の値");
  owner.adapter.summary = () => ({ controlState: "STREAMING" }); assert.deepEqual(qualityFor(owner), { overall: "normal", voltage: "normal", current: "normal", gap: false }); assert.equal(runtimeValueState(owner), "");
});
