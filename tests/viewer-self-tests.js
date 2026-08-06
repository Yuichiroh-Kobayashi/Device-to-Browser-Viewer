import { BoundedSegmentBuffer } from "../src/model/bounded-segment-buffer.js";
import { StreamModel } from "../src/model/stream-model.js";
import { SessionAdapter } from "../src/protocol/session-adapter.js";
import { relativeDeviceSeconds } from "../src/render/scale.js";
import { CaptureReplaySource, parseLiveCapture } from "../src/sources/capture-replay-source.js";
import {
  SyntheticSource, buildSyntheticPlan, makeHelloText, makeWelcomeText, makeStartText, makeStartedText,
  makeStoppedText, makeStreamEndFrame, makeViFrame,
} from "../src/sources/synthetic-source.js";

const results = document.getElementById("results");
const totals = document.getElementById("totals");
const BASE_SEQUENCE = 9_007_199_254_742_000n;
const SAMPLE_PERIOD_US = 40_000n;

function assert(condition, detail = "assertion failed") {
  if (!condition) throw new Error(detail);
}

function equal(actual, expected, detail = "") {
  assert(Object.is(actual, expected), detail + " expected " + String(expected) + ", got " + String(actual));
}

function assertClose(actual, expected, tolerance = 0.00001) {
  assert(Math.abs(actual - expected) <= tolerance, "expected " + expected + ", got " + actual);
}

function readyAdapter({ displayWindowSeconds = 60 } = {}) {
  const model = new StreamModel({ displayWindowSeconds });
  const adapter = new SessionAdapter(model);
  adapter.notifyTransportStatus({ state: "open" });
  assert(adapter.handleControl({ direction: "client_to_server", text: makeHelloText() }), "hello rejected");
  assert(adapter.handleControl({ direction: "server_to_client", text: makeWelcomeText() }), "welcome rejected");
  return { model, adapter };
}

function startVi(adapter, streamId = 1) {
  assert(adapter.handleControl({ direction: "client_to_server", text: makeStartText() }), "start rejected");
  assert(adapter.handleControl({ direction: "server_to_client", text: makeStartedText(streamId) }), "started rejected");
}

function firstFrame(adapter, options = {}) {
  return adapter.handleBinary(makeViFrame({
    streamId: 1,
    sequence: 9_007_199_254_742_000n,
    timestampUs: 1_000_000n,
    flags: 1,
    voltage: 3.3,
    current: 0.1,
    ...options,
  }));
}

function attach(source, adapter) {
  source.onStatus((status) => adapter.notifyTransportStatus(status));
  source.onControl((control) => adapter.handleControl(control));
  source.onBinary((buffer) => adapter.handleBinary(buffer));
  source.onError((error) => adapter.handleError(error));
}

function driveSyntheticScenario(scenario) {
  const { model, adapter } = readyAdapter();
  let rejectedBinaryCount = 0;
  for (const event of buildSyntheticPlan(scenario)) {
    if (event.kind === "transport") {
      adapter.notifyTransportStatus({ state: event.state });
    } else if (event.kind === "control") {
      assert(adapter.handleControl({ direction: event.direction, text: event.text }), scenario + " control rejected");
    } else if (!adapter.handleBinary(event.buffer)) {
      rejectedBinaryCount += 1;
    }
  }
  return { model, adapter, rejectedBinaryCount };
}

function dataFrames(scenario) {
  return buildSyntheticPlan(scenario).filter((event) => event.kind === "binary" && event.buffer.byteLength === 48);
}

function envelope(buffer) {
  const view = new DataView(buffer);
  return {
    flags: view.getUint8(7),
    sequence: view.getBigUint64(16, true),
    timestampUs: view.getBigUint64(24, true),
  };
}

async function waitFor(predicate, timeoutMs = 1800) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
}

const tests = [
  ["bounded buffer", () => {
    const ring = new BoundedSegmentBuffer(2);
    ring.append("a"); ring.append("b"); ring.append("c");
    equal(ring.size, 2); equal(ring.toArray()[0], "b");
  }],
  ["reference segment creation + large BigInt sequence", () => {
    const { model, adapter } = readyAdapter();
    startVi(adapter); assert(firstFrame(adapter), "first frame rejected");
    equal(model.summary().segmentCount, 1); equal(model.latest.sequence, 9_007_199_254_742_000n);
  }],
  ["sequence gap and producer cause", () => {
    const { model, adapter } = readyAdapter();
    startVi(adapter); assert(firstFrame(adapter));
    assert(adapter.handleBinary(makeViFrame({ streamId: 1, sequence: 9_007_199_254_742_004n, timestampUs: 1_040_000n, flags: 0x0c, voltage: 3.3, current: 0.1 })));
    equal(model.summary().sequenceGapCount, 1); equal(model.summary().producerOverflowCount, 1);
  }],
  ["new stream hard boundary", () => {
    const { model, adapter } = readyAdapter();
    startVi(adapter, 1); assert(firstFrame(adapter));
    assert(adapter.handleBinary(makeStreamEndFrame({ streamId: 1, sequence: 9_007_199_254_742_001n, timestampUs: 1_040_000n })));
    assert(adapter.handleControl({ direction: "server_to_client", text: makeStoppedText(1) }));
    startVi(adapter, 2);
    assert(adapter.handleBinary(makeViFrame({ streamId: 2, sequence: 9_007_199_254_742_000n, timestampUs: 2_000_000n, flags: 1, voltage: 3.3, current: 0.1 })));
    const records = model.recordSnapshot();
    assert(records[0].segment_id !== records[1].segment_id, "segments joined");
  }],
  ["invalid channel is null", () => {
    const { model, adapter } = readyAdapter();
    startVi(adapter); assert(firstFrame(adapter, { validMask: 2, voltage: 0 }));
    equal(model.latest.voltage_V, null); equal(model.summary().invalidVoltageCount, 1);
  }],
  ["exact relative timestamp conversion", () => {
    const origin = 18_446_744_073_709_000_000n;
    equal(relativeDeviceSeconds(origin + 123n, origin), 0.000123);
  }],
  ["parser rejection rollback", () => {
    const { model, adapter } = readyAdapter();
    startVi(adapter); assert(firstFrame(adapter));
    const before = adapter.decoderState;
    const invalid = makeViFrame({ streamId: 1, sequence: 9_007_199_254_742_001n, timestampUs: 1_040_000n, voltage: 3.3, current: 0.1 });
    new Uint8Array(invalid)[0] = 0x58;
    equal(adapter.handleBinary(invalid), false);
    equal(model.summary().sampleCount, 1); equal(adapter.decoderState, before);
  }],
  ["welcome/start consistency", () => {
    const { adapter } = readyAdapter();
    assert(adapter.handleControl({ direction: "client_to_server", text: makeStartText() }));
    const mismatch = JSON.parse(makeStartedText(1, "other-stream"));
    equal(adapter.handleControl({ direction: "server_to_client", text: JSON.stringify(mismatch) }), false);
    equal(adapter.controlState, "READY");
  }],
  ["display eviction remains distinct from device gap", () => {
    const { model, adapter } = readyAdapter({ displayWindowSeconds: 1 });
    startVi(adapter); assert(firstFrame(adapter));
    assert(adapter.handleBinary(makeViFrame({ streamId: 1, sequence: 9_007_199_254_742_001n, timestampUs: 3_000_000n, voltage: 3.3, current: 0.1 })));
    equal(model.summary().sequenceGapCount, 0); equal(model.summary().viewerWindowEvictionCount, 1);
  }],
  ["S3/S4 omit logical positions without compressing device time", () => {
    const cases = [
      { scenario: "producer-gap", retained: 245, delta: 6n, timestampDelta: 6n * SAMPLE_PERIOD_US, flag: 0x0c, gapSamples: "5" },
      { scenario: "output-drop", retained: 247, delta: 4n, timestampDelta: 4n * SAMPLE_PERIOD_US, flag: 0x14, gapSamples: "3" },
    ];
    for (const expectation of cases) {
      const frames = dataFrames(expectation.scenario);
      equal(frames.length, expectation.retained);
      const afterIndex = frames.findIndex((event) => (envelope(event.buffer).flags & 0x04) !== 0);
      assert(afterIndex > 0, "missing discontinuity frame");
      const before = envelope(frames[afterIndex - 1].buffer);
      const after = envelope(frames[afterIndex].buffer);
      equal(after.flags, expectation.flag);
      equal(after.sequence - before.sequence, expectation.delta);
      equal(after.timestampUs - before.timestampUs, expectation.timestampDelta);
      const binaryEvents = buildSyntheticPlan(expectation.scenario).filter((event) => event.kind === "binary");
      const end = binaryEvents[binaryEvents.length - 1];
      equal(envelope(end.buffer).sequence, BASE_SEQUENCE + 250n);
      equal(envelope(end.buffer).timestampUs, 10_000_000n);
      equal(driveSyntheticScenario(expectation.scenario).model.summary().sequenceGapSamples, expectation.gapSamples);
    }
  }],
  ["all S1-S7 synthetic scenarios retain their defined semantics", () => {
    const stable = driveSyntheticScenario("stable");
    equal(stable.model.summary().sampleCount, 250); equal(stable.model.summary().segmentCount, 1);

    const step = driveSyntheticScenario("step");
    const stepRecords = step.model.recordSnapshot();
    equal(step.model.summary().sampleCount, 250);
    assertClose(stepRecords[0].voltage_V, 0); assertClose(stepRecords[0].current_A, 0);
    assertClose(stepRecords[50].voltage_V, 5); assertClose(stepRecords[50].current_A, 0.2);
    assertClose(stepRecords[175].voltage_V, 5); assertClose(stepRecords[175].current_A, 0.08);

    const producer = driveSyntheticScenario("producer-gap");
    equal(producer.model.summary().sampleCount, 245); equal(producer.model.summary().segmentCount, 2);
    equal(producer.model.summary().producerOverflowCount, 1);

    const output = driveSyntheticScenario("output-drop");
    equal(output.model.summary().sampleCount, 247); equal(output.model.summary().segmentCount, 2);
    equal(output.model.summary().outputQueueDropCount, 1);

    const validity = driveSyntheticScenario("validity");
    equal(validity.model.summary().invalidVoltageCount, 126); equal(validity.model.summary().invalidCurrentCount, 125);

    const reconnect = driveSyntheticScenario("reconnect");
    equal(reconnect.model.summary().sampleCount, 250); equal(reconnect.model.summary().segmentCount, 2);
    equal([...new Set(reconnect.model.recordSnapshot().map((record) => record.stream_id))].join(","), "1,2");

    const invalid = driveSyntheticScenario("invalid-frame");
    equal(invalid.model.summary().sampleCount, 250); equal(invalid.model.summary().sequenceGapCount, 0);
    equal(invalid.rejectedBinaryCount, 1); equal(invalid.adapter.summary().lastError.code, "bad_magic");
  }],
  ["synthetic source start/stop lifecycle", async () => {
    const model = new StreamModel();
    const adapter = new SessionAdapter(model);
    const source = new SyntheticSource({ scenario: "stable", speed: "fast" });
    attach(source, adapter);
    try {
      await source.open(); await source.start();
      await waitFor(() => model.summary().sampleCount >= 2);
      await source.stop();
      equal(adapter.controlState, "READY");
    } finally { await source.close(); }
  }],
  ["exact VAMeter capture schema replays fractional received_ms and rejects legacy frames", async () => {
    const response = await fetch("../fixtures/capture/synthetic-live-capture.json", { cache: "no-store" });
    assert(response.ok, "fixture fetch failed");
    const text = await response.text();
    const events = parseLiveCapture(text);
    equal(events.length, 9);
    equal(events.map((event) => event.eventIndex).join(","), "0,1,2,3,4,5,6,7,8");
    equal(events[1].receivedMs, 1.25); equal(events[4].receivedMs, 10.5);
    equal(events.filter((event) => event.kind === "binary").length, 3);
    const legacy = JSON.parse(text);
    legacy.frames[0].frame_hex = legacy.frames[0].hex;
    legacy.frames[0].direction = "server_to_client";
    delete legacy.frames[0].hex;
    let legacyRejected = false;
    try { parseLiveCapture(JSON.stringify(legacy)); } catch { legacyRejected = true; }
    assert(legacyRejected, "legacy frame shape was accepted");
    const model = new StreamModel();
    const adapter = new SessionAdapter(model);
    const source = new CaptureReplaySource({ speed: "fast" });
    attach(source, adapter);
    try {
      source.loadText(text); await source.open(); await source.start();
      await waitFor(() => source.state === "stopped");
      equal(model.summary().sampleCount, 2);
    } finally { await source.close(); }
  }],
];

let passed = 0;
for (const [name, run] of tests) {
  const item = document.createElement("li");
  try {
    await run();
    passed += 1;
    item.className = "pass";
    item.dataset.result = "PASS";
    item.textContent = "PASS: " + name;
  } catch (error) {
    item.className = "fail";
    item.dataset.result = "FAIL";
    item.textContent = "FAIL: " + name + " — " + error.message;
  }
  results.append(item);
}
const failed = tests.length - passed;
totals.textContent = "TOTAL: " + tests.length + " PASS: " + passed + " FAIL: " + failed;
totals.dataset.total = String(tests.length);
totals.dataset.pass = String(passed);
totals.dataset.fail = String(failed);
window.__viewerSelfTests = Object.freeze({ total: tests.length, passed, failed });
