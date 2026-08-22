import assert from "node:assert/strict";
import { autoscale, AUTOSCALE_HYPOTHESIS } from "../graph/autoscale-policy.js";

const CASE_RESULTS = [];
const H = {
  ...AUTOSCALE_HYPOTHESIS,
  candidateVisibleWindowMs: 60_000,
  candidateGapBreakMs: 500,
};
const sample = (timestampMs, value, extra = {}) => ({
  sessionId: "S1",
  timebaseId: "T1",
  timestampMs,
  value,
  ...extra,
});
const span = (result) => result.bounds.max - result.bounds.min;
const containsAll = (result) => result.metadata.displayRecords
  .filter(({ record }) => record.valid !== false && Number.isFinite(record.value))
  .every(({ record }) => result.bounds.min <= record.value && record.value <= result.bounds.max);
const evidence = (result) => ({
  kind: result.kind,
  mode: result.mode,
  bounds: result.bounds,
  validCount: result.validCount ?? 0,
  timeDomain: result.metadata.timeDomain,
  breaks: result.metadata.breaks,
  segments: result.metadata.segments,
  evicted: result.metadata.evicted,
  hardBoundaries: result.metadata.hardBoundaries,
  hysteresis: result.hysteresis ?? null,
});
function execute(id, name, input, assertion) {
  const observed = assertion();
  CASE_RESULTS.push({ id, name, executed: true, result: "PASS", input, observed });
}

execute("G01", "all zero", [
  { timestampMs: 0, value: 0 }, { timestampMs: 10, value: 0 },
], () => {
  const result = autoscale([sample(0, 0), sample(10, 0)], H);
  assert.equal(result.kind, "scaled");
  assert.ok(containsAll(result));
  assert.ok(span(result) >= H.candidateMinimumSpan);
  return evidence(result);
});

execute("G02", "one valid sample", [{ timestampMs: 0, value: 3.25 }], () => {
  const result = autoscale([sample(0, 3.25)], H);
  assert.equal(result.validCount, 1);
  assert.ok(containsAll(result));
  assert.ok(span(result) >= H.candidateMinimumSpan);
  return evidence(result);
});

execute("G03", "constant tiny nonzero", [
  { timestampMs: 0, value: 0.000001 }, { timestampMs: 5, value: 0.000001 },
], () => {
  const result = autoscale([sample(0, 0.000001), sample(5, 0.000001)], H);
  assert.ok(containsAll(result));
  assert.ok(span(result) >= H.candidateMinimumSpan);
  assert.notEqual(result.bounds.min, result.bounds.max);
  return evidence(result);
});

execute("G04", "positive step", [
  { timestampMs: 0, value: 1 }, { timestampMs: 10, value: 5 },
], () => {
  const result = autoscale([sample(0, 1), sample(10, 5)], H);
  assert.ok(containsAll(result));
  assert.ok(result.bounds.min < 1 && result.bounds.max > 5);
  return evidence(result);
});

execute("G05", "negative step", [
  { timestampMs: 0, value: -1 }, { timestampMs: 10, value: -5 },
], () => {
  const result = autoscale([sample(0, -1), sample(10, -5)], H);
  assert.ok(containsAll(result));
  assert.ok(result.bounds.min < -5 && result.bounds.max > -1);
  return evidence(result);
});

execute("G06", "crosses zero", [
  { timestampMs: 0, value: -2 }, { timestampMs: 10, value: 3 },
], () => {
  const result = autoscale([sample(0, -2), sample(10, 3)], H);
  assert.ok(containsAll(result));
  assert.ok(result.bounds.min < 0 && result.bounds.max > 0);
  return evidence(result);
});

execute("G07", "extreme spike expands immediately", [
  { timestampMs: 0, value: 1 }, { timestampMs: 10, value: 1_000_000 },
], () => {
  const result = autoscale(
    [sample(0, 1), sample(10, 1_000_000)],
    { ...H, previousBounds: { min: -1, max: 2, stableCount: 1 } },
  );
  assert.ok(containsAll(result));
  assert.equal(result.hysteresis.action, "expanded");
  assert.ok(result.bounds.max > 1_000_000);
  return evidence(result);
});

execute("G08", "invalid-only", [
  { timestampMs: 0, value: 7, valid: false }, { timestampMs: 10, value: null },
], () => {
  const result = autoscale([sample(0, 7, { valid: false }), sample(10, null)], H);
  assert.equal(result.kind, "no-valid-data");
  assert.equal(result.bounds, null);
  assert.equal(result.validCount, 0);
  assert.equal(result.metadata.breaks.filter(({ kind }) => kind === "invalid-sample").length, 2);
  return evidence(result);
});

execute("G09", "V invalid / I valid separate channels", {
  voltage: [{ timestampMs: 0, value: 2, valid: false }],
  current: [{ timestampMs: 0, value: 0.4 }],
}, () => {
  const voltage = autoscale([sample(0, 2, { valid: false })], H);
  const current = autoscale([sample(0, 0.4)], H);
  assert.equal(voltage.kind, "no-valid-data");
  assert.equal(current.kind, "scaled");
  assert.ok(containsAll(current));
  return { voltage: evidence(voltage), current: evidence(current) };
});

execute("G10", "sequence gap retains device time and break metadata", [
  { timestampMs: 0, value: 1 },
  { timestampMs: 100, value: 2 },
  { timestampMs: 2000, value: 3 },
], () => {
  const result = autoscale(
    [sample(0, 1), sample(100, 2), sample(2000, 3)],
    { ...H, candidateVisibleWindowMs: 3_000 },
  );
  assert.deepEqual(
    result.metadata.displayRecords.map(({ timestampMs }) => timestampMs),
    [0, 100, 2000],
  );
  assert.deepEqual(
    result.metadata.breaks.find(({ kind }) => kind === "device-time-gap"),
    {
      kind: "device-time-gap",
      fromSourceIndex: 1,
      toSourceIndex: 2,
      fromTimestampMs: 100,
      toTimestampMs: 2000,
    },
  );
  assert.equal(result.metadata.timeDomain.durationMs, 2000);
  assert.ok(containsAll(result));
  return evidence(result);
});

execute("G11", "timebase reset is a hard boundary", [
  { timebaseId: "T1", timestampMs: 900, value: 9 },
  { timebaseId: "T2", timestampMs: 0, value: 1 },
  { timebaseId: "T2", timestampMs: 10, value: 2 },
], () => {
  const result = autoscale([
    sample(900, 9, { timebaseId: "T1" }),
    sample(0, 1, { timebaseId: "T2" }),
    sample(10, 2, { timebaseId: "T2" }),
  ], H);
  assert.deepEqual(result.metadata.displayRecords.map(({ record }) => record.value), [1, 2]);
  assert.equal(result.metadata.hardBoundaries[0].kind, "timebase-reset");
  assert.ok(containsAll(result));
  return evidence(result);
});

execute("G12", "new session is a hard boundary", [
  { sessionId: "S1", timestampMs: 0, value: 100 },
  { sessionId: "S2", timestampMs: 0, value: -1 },
  { sessionId: "S2", timestampMs: 10, value: 1 },
], () => {
  const result = autoscale([
    sample(0, 100, { sessionId: "S1" }),
    sample(0, -1, { sessionId: "S2" }),
    sample(10, 1, { sessionId: "S2" }),
  ], H);
  assert.deepEqual(result.metadata.displayRecords.map(({ record }) => record.value), [-1, 1]);
  assert.equal(result.metadata.hardBoundaries[0].kind, "session-change");
  assert.ok(containsAll(result));
  return evidence(result);
});

execute("G13", "visible-window eviction is device-time based", [
  { timestampMs: 0, value: -99 },
  { timestampMs: 40_000, value: 1 },
  { timestampMs: 61_000, value: 2 },
], () => {
  const result = autoscale([sample(0, -99), sample(40_000, 1), sample(61_000, 2)], H);
  assert.deepEqual(result.metadata.evicted, [{
    sourceIndex: 0,
    timestampMs: 0,
    reason: "outside-device-time-window",
  }]);
  assert.deepEqual(
    result.metadata.displayRecords.map(({ timestampMs }) => timestampMs),
    [40_000, 61_000],
  );
  assert.equal(result.metadata.timeDomain.durationMs, 21_000);
  assert.ok(containsAll(result));
  return evidence(result);
});

execute("G14", "expand then stable smaller range hysteresis", [
  { timestampMs: 0, value: 0 },
  { timestampMs: 10, value: 100 },
  { timestampMs: 20, value: 0 },
  { timestampMs: 30, value: 1 },
], () => {
  const expanded = autoscale(
    [sample(0, 0), sample(10, 100)],
    { ...H, previousBounds: { min: -1, max: 2, stableCount: 0 } },
  );
  const firstSmall = autoscale(
    [sample(20, 0), sample(30, 1)],
    { ...H, previousBounds: { ...expanded.bounds, stableCount: expanded.hysteresis.stableCount } },
  );
  const stableSmall = autoscale(
    [sample(20, 0), sample(30, 1)],
    { ...H, previousBounds: { ...firstSmall.bounds, stableCount: firstSmall.hysteresis.stableCount } },
  );
  assert.equal(expanded.hysteresis.action, "expanded");
  assert.equal(firstSmall.hysteresis.action, "awaiting-stable-shrink");
  assert.equal(stableSmall.hysteresis.action, "shrunk");
  assert.ok(span(stableSmall) < span(expanded));
  assert.ok(containsAll(stableSmall));
  return { expanded: evidence(expanded), firstSmall: evidence(firstSmall), stableSmall: evidence(stableSmall) };
});

execute("G15", "oscillation near shrink threshold does not flap", [
  { timestampMs: 0, value: 0 }, { timestampMs: 10, value: 100 },
], () => {
  const initial = autoscale([sample(0, 0), sample(10, 100)], H);
  const nearEligible = autoscale(
    [sample(0, 0), sample(10, 79)],
    { ...H, previousBounds: { ...initial.bounds, stableCount: 0 } },
  );
  const nearIneligible = autoscale(
    [sample(0, 0), sample(10, 81)],
    { ...H, previousBounds: { ...nearEligible.bounds, stableCount: nearEligible.hysteresis.stableCount } },
  );
  const oscillate = autoscale(
    [sample(0, 0), sample(10, 79)],
    { ...H, previousBounds: { ...nearIneligible.bounds, stableCount: nearIneligible.hysteresis.stableCount } },
  );
  assert.equal(nearEligible.hysteresis.action, "awaiting-stable-shrink");
  assert.equal(nearIneligible.hysteresis.action, "held");
  assert.equal(oscillate.hysteresis.action, "awaiting-stable-shrink");
  assert.deepEqual(oscillate.bounds, initial.bounds);
  assert.ok(containsAll(oscillate));
  return { initial: evidence(initial), nearEligible: evidence(nearEligible), nearIneligible: evidence(nearIneligible), oscillate: evidence(oscillate) };
});

execute("G16", "valid outlier after invalid expands", [
  { timestampMs: 0, value: 1 },
  { timestampMs: 10, value: 999, valid: false },
  { timestampMs: 20, value: 500 },
], () => {
  const result = autoscale(
    [sample(0, 1), sample(10, 999, { valid: false }), sample(20, 500)],
    { ...H, previousBounds: { min: 0, max: 2, stableCount: 1 } },
  );
  assert.ok(containsAll(result));
  assert.equal(result.hysteresis.action, "expanded");
  assert.ok(result.bounds.max > 500);
  assert.equal(result.metadata.breaks.filter(({ kind }) => kind === "invalid-sample").length, 1);
  return evidence(result);
});

execute("G17", "repeated valid invalid preserves breaks and never zeros", [
  { timestampMs: 0, value: 2 },
  { timestampMs: 10, value: 999, valid: false },
  { timestampMs: 20, value: -3 },
  { timestampMs: 30, value: null },
], () => {
  const result = autoscale([
    sample(0, 2),
    sample(10, 999, { valid: false }),
    sample(20, -3),
    sample(30, null),
  ], H);
  assert.ok(containsAll(result));
  assert.deepEqual(result.metadata.segments.map(({ timestampsMs }) => timestampsMs), [[0], [20]]);
  assert.equal(result.metadata.breaks.filter(({ kind }) => kind === "invalid-sample").length, 2);
  assert.equal(result.metadata.displayRecords[1].record.value, 999);
  assert.equal(result.metadata.displayRecords[3].record.value, null);
  assert.equal(result.validCount, 2);
  assert.ok(result.bounds.max < 10);
  return evidence(result);
});

execute("G18", "explicit zoom mode is validated and not auto", [
  { timestampMs: 0, value: -1 }, { timestampMs: 10, value: 1 },
], () => {
  const result = autoscale(
    [sample(0, -1), sample(10, 1)],
    { ...H, zoom: { min: -2, max: 2 } },
  );
  assert.equal(result.mode, "explicit-zoom");
  assert.deepEqual(result.bounds, { min: -2, max: 2 });
  assert.ok(containsAll(result));
  assert.throws(() => autoscale([sample(0, -1), sample(10, 1)], { ...H, zoom: true }), TypeError);
  assert.throws(
    () => autoscale([sample(0, -1), sample(10, 1)], { ...H, zoom: { min: -0.5, max: 0.5 } }),
    RangeError,
  );
  return evidence(result);
});

assert.equal(CASE_RESULTS.length, 18);
assert.equal(new Set(CASE_RESULTS.map(({ id }) => id)).size, 18);
assert.ok(CASE_RESULTS.every(({ executed, result, input, observed }) => (
  executed && result === "PASS" && input && observed
)));
console.log(JSON.stringify({
  result: "PASS",
  executedCaseCount: CASE_RESULTS.length,
  cases: CASE_RESULTS,
}));
