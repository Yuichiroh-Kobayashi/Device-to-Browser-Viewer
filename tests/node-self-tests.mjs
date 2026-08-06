import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { BoundedSegmentBuffer } from "../src/model/bounded-segment-buffer.js";
import { StreamModel } from "../src/model/stream-model.js";
import { SessionAdapter } from "../src/protocol/session-adapter.js";
import { relativeDeviceSeconds } from "../src/render/scale.js";
import { parseLiveCapture, CaptureReplaySource } from "../src/sources/capture-replay-source.js";
import { WebSocketSource } from "../src/sources/websocket-source.js";
import { liveActionAvailability } from "../src/ui/action-availability.js";
import {
  DEFAULT_VI_PARAMETERS, buildSyntheticPlan, makeHelloText, makeWelcomeText, makeStartText, makeStartedText, makeStopText,
  makeStoppedText, makeStreamEndFrame, makeViFrame, SyntheticSource,
} from "../src/sources/synthetic-source.js";

const BASE_SEQUENCE = 9_007_199_254_742_000n;
const SAMPLE_PERIOD_US = 40_000n;
const LIVE_STREAM = "live-vi";
const LIVE_SUPPORTED_STREAMS = Object.freeze([LIVE_STREAM]);

function readyAdapter({ capacity = 4096, displayWindowSeconds = 60 } = {}) {
  const model = new StreamModel({ capacity, displayWindowSeconds });
  const adapter = new SessionAdapter(model);
  adapter.notifyTransportStatus({ state: "open" });
  assert.equal(adapter.handleControl({ direction: "client_to_server", text: makeHelloText() }), true);
  assert.equal(adapter.handleControl({ direction: "server_to_client", text: makeWelcomeText() }), true);
  assert.equal(adapter.controlState, "READY");
  return { model, adapter };
}

function startVi(adapter, streamId = 1) {
  assert.equal(adapter.handleControl({ direction: "client_to_server", text: makeStartText() }), true);
  assert.equal(adapter.handleControl({ direction: "server_to_client", text: makeStartedText(streamId) }), true);
  assert.equal(adapter.controlState, "STREAMING");
}

function frame({ streamId = 1, sequence, timestampUs, flags = 0, validMask = 3, voltage = 3.3, current = 0.1 }) {
  return makeViFrame({ streamId, sequence, timestampUs, flags, validMask, voltage, current });
}

function emitFirst(adapter, options = {}) {
  return adapter.handleBinary(frame({ sequence: BASE_SEQUENCE, timestampUs: 1_000_000n, flags: 1, ...options }));
}

function decodedViFrame({
  streamId,
  sequence,
  timestampUs,
  flags = 0x01,
  validMask = 3,
  voltage = 3.3,
  current = 0.1,
  timebaseReset = Boolean(flags & 0x40),
  withSegment = true,
} = {}) {
  return {
    stream_id: streamId,
    flags,
    gap_samples: 0n,
    stream_start: Boolean(flags & 0x01),
    stream_end: false,
    discontinuity: Boolean(flags & 0x04),
    producer_overflow: Boolean(flags & 0x08),
    output_queue_drop: Boolean(flags & 0x10),
    source_paused: Boolean(flags & 0x20),
    timebase_reset: timebaseReset,
    records: [{
      sequence,
      timestampUs,
      validMask,
      measurements: { voltage, current },
    }],
    segment: withSegment ? {
      streamId,
      startSequence: sequence,
      startTimestampUs: timestampUs,
      gapSamples: 0n,
      causes: {
        producerOverflow: false,
        outputQueueDrop: false,
        sourcePaused: false,
        timebaseReset,
      },
    } : null,
  };
}

function commitDecodedViFrame(model, options = {}) {
  const candidate = model.prepareDecodedFrame(decodedViFrame(options));
  model.commitCandidate(candidate);
  return candidate;
}

function assertClose(actual, expected, tolerance = 0.00001) {
  assert.ok(Math.abs(actual - expected) <= tolerance, "expected " + expected + ", got " + actual);
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for source lifecycle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function attach(source, adapter) {
  source.onStatus((status) => adapter.notifyTransportStatus(status));
  source.onControl((control) => adapter.handleControl(control));
  source.onBinary((buffer) => adapter.handleBinary(buffer));
  source.onError((error) => adapter.handleError(error));
}

function makeLiveWebSocketSource({ endpoint = "ws://example.test/d2b/v0/stream" } = {}) {
  const model = new StreamModel();
  const adapter = new SessionAdapter(model);
  const source = new WebSocketSource({
    endpoint,
    stream: LIVE_STREAM,
    supportedStreams: LIVE_SUPPORTED_STREAMS,
    controlAuthority: adapter,
  });
  attach(source, adapter);
  return { model, adapter, source };
}

function driveSyntheticScenario(scenario) {
  const { model, adapter } = readyAdapter();
  let rejectedBinaryCount = 0;
  for (const event of buildSyntheticPlan(scenario)) {
    if (event.kind === "transport") {
      adapter.notifyTransportStatus({ state: event.state });
    } else if (event.kind === "control") {
      assert.equal(adapter.handleControl({ direction: event.direction, text: event.text }), true, scenario + " control rejected");
    } else {
      const accepted = adapter.handleBinary(event.buffer);
      if (!accepted) rejectedBinaryCount += 1;
    }
  }
  return { model, adapter, rejectedBinaryCount };
}

function flaggedDataFrames(scenario) {
  return buildSyntheticPlan(scenario).filter((event) => event.kind === "binary" && event.buffer.byteLength === 48);
}

function envelope(frameBuffer) {
  const view = new DataView(frameBuffer);
  return {
    flags: view.getUint8(7),
    sequence: view.getBigUint64(16, true),
    timestampUs: view.getBigUint64(24, true),
  };
}

class ControlledWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(endpoint) {
    this.endpoint = endpoint;
    this.readyState = ControlledWebSocket.CONNECTING;
    this.binaryType = "";
    this.sent = [];
    this.sendCalls = 0;
    this.closeCalls = 0;
    this.throwOnSend = null;
    this.throwOnClose = null;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    ControlledWebSocket.instances.push(this);
  }

  static reset() { ControlledWebSocket.instances = []; }

  send(text) {
    this.sendCalls += 1;
    if (this.throwOnSend) throw this.throwOnSend;
    if (this.readyState !== ControlledWebSocket.OPEN) throw new Error("mock send while not open");
    this.sent.push(text);
  }

  close() {
    this.closeCalls += 1;
    if (this.throwOnClose) throw this.throwOnClose;
    this.readyState = ControlledWebSocket.CLOSING;
  }

  open() {
    this.readyState = ControlledWebSocket.OPEN;
    this.onopen?.({});
  }

  message(data) { this.onmessage?.({ data }); }
  error() { this.onerror?.({}); }

  finishClose() {
    this.readyState = ControlledWebSocket.CLOSED;
    this.onclose?.({});
  }
}

async function withWebSocketClass(WebSocketClass, run) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = WebSocketClass;
  try {
    return await run();
  } finally {
    if (original === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = original;
  }
}

async function withControlledWebSocket(run) {
  ControlledWebSocket.reset();
  return withWebSocketClass(ControlledWebSocket, run);
}

test("fixed-capacity ring remains bounded", () => {
  const ring = new BoundedSegmentBuffer(3);
  ring.append("a"); ring.append("b"); ring.append("c");
  assert.equal(ring.append("d"), "a");
  assert.deepEqual(ring.toArray(), ["b", "c", "d"]);
  assert.throws(() => new BoundedSegmentBuffer(4097), /4096/);
});

test("reference segment metadata creates a segment and preserves large BigInt sequence", () => {
  const { model, adapter } = readyAdapter();
  startVi(adapter);
  assert.equal(emitFirst(adapter), true);
  assert.equal(model.summary().segmentCount, 1);
  assert.equal(model.latest.sequence, BASE_SEQUENCE);
  assert.equal(model.latest.timestamp_us, 1_000_000n);
});

test("sequence gap, producer overflow, and output queue drop are distinct", () => {
  const { model, adapter } = readyAdapter();
  startVi(adapter);
  assert.equal(emitFirst(adapter), true);
  assert.equal(adapter.handleBinary(frame({ sequence: BASE_SEQUENCE + 4n, timestampUs: 1_040_000n, flags: 0x0c })), true);
  assert.equal(adapter.handleBinary(frame({ sequence: BASE_SEQUENCE + 8n, timestampUs: 1_080_000n, flags: 0x14 })), true);
  const summary = model.summary();
  assert.equal(summary.sequenceGapCount, 2);
  assert.equal(summary.sequenceGapSamples, "6");
  assert.equal(summary.producerOverflowCount, 1);
  assert.equal(summary.outputQueueDropCount, 1);
  assert.equal(summary.segmentCount, 3);
});

test("new stream starts a fresh viewport with a distinct cumulative segment", () => {
  const { model, adapter } = readyAdapter();
  startVi(adapter, 1);
  assert.equal(emitFirst(adapter, { streamId: 1 }), true);
  const firstViewportRecord = model.recordSnapshot()[0];
  assert.equal(adapter.handleBinary(makeStreamEndFrame({ streamId: 1, sequence: BASE_SEQUENCE + 1n, timestampUs: 1_040_000n })), true);
  assert.equal(adapter.handleControl({ direction: "server_to_client", text: makeStoppedText(1) }), true);
  startVi(adapter, 2);
  assert.equal(emitFirst(adapter, { streamId: 2, timestampUs: 2_000_000n }), true);
  const records = model.recordSnapshot();
  assert.equal(records.length, 1);
  assert.deepEqual(records.map((record) => record.stream_id), [2]);
  assert.notEqual(firstViewportRecord.segment_id, records[0].segment_id);
  assert.equal(model.summary().sampleCount, 2, "clearing a viewport must not erase cumulative session samples");
  assert.equal(model.summary().segmentCount, 2, "clearing a viewport must not erase cumulative segment history");
});

test("invalid channel is retained as invalid, never as a numeric placeholder", () => {
  const { model, adapter } = readyAdapter();
  startVi(adapter);
  assert.equal(emitFirst(adapter, { validMask: 2, voltage: 0, current: 0.1 }), true);
  assert.equal(model.latest.voltage_V, null);
  assert.equal(model.latest.current_A !== null, true);
  assert.equal(model.summary().invalidVoltageCount, 1);
  assert.equal(model.summary().invalidCurrentCount, 0);
});

test("relative plotting conversion subtracts exact BigInt timestamps before Number conversion", () => {
  const origin = 18_446_744_073_709_000_000n;
  assert.equal(relativeDeviceSeconds(origin + 123n, origin), 0.000123);
});

test("reference parser rejection rolls back decoder and measurement model", () => {
  const { model, adapter } = readyAdapter();
  startVi(adapter);
  assert.equal(emitFirst(adapter), true);
  const beforeSummary = model.summary();
  const beforeState = adapter.decoderState;
  const invalid = frame({ sequence: BASE_SEQUENCE + 1n, timestampUs: 1_040_000n });
  new Uint8Array(invalid)[0] = 0x58;
  assert.equal(adapter.handleBinary(invalid), false);
  assert.equal(model.summary().sampleCount, beforeSummary.sampleCount);
  assert.equal(model.recordSnapshot().length, 1);
  assert.strictEqual(adapter.decoderState, beforeState);
  assert.equal(adapter.summary().lastError.code, "bad_magic");
});

test("orderly stream_stopped requires an accepted STREAM_END", () => {
  const { model, adapter } = readyAdapter();
  startVi(adapter);
  assert.equal(emitFirst(adapter), true);
  const beforeState = adapter.decoderState;
  const beforeSummary = model.summary();

  assert.equal(adapter.handleControl({ direction: "server_to_client", text: makeStoppedText(1) }), false);
  assert.equal(adapter.controlState, "STREAMING");
  assert.strictEqual(adapter.decoderState, beforeState);
  assert.equal(model.summary().sampleCount, beforeSummary.sampleCount);

  const malformedEnd = makeStreamEndFrame({ streamId: 1, sequence: BASE_SEQUENCE + 1n, timestampUs: 1_040_000n });
  new Uint8Array(malformedEnd)[0] = 0x58;
  assert.equal(adapter.handleBinary(malformedEnd), false);
  assert.equal(adapter.controlState, "STREAMING");
  assert.strictEqual(adapter.decoderState, beforeState);
  assert.equal(model.summary().sampleCount, beforeSummary.sampleCount);
  assert.equal(adapter.handleControl({ direction: "server_to_client", text: makeStoppedText(1) }), false);
  assert.equal(adapter.controlState, "STREAMING");

  assert.equal(adapter.handleBinary(makeStreamEndFrame({ streamId: 1, sequence: BASE_SEQUENCE + 1n, timestampUs: 1_040_000n })), true);
  assert.equal(adapter.decoderState.ended, true);
  assert.equal(adapter.handleControl({ direction: "server_to_client", text: makeStoppedText(1) }), true);
  assert.equal(adapter.controlState, "READY");
  assert.equal(adapter.decoderState, null);
  assert.equal(adapter.active, null);
});

test("welcome/start consistency state-machine rejects mismatched stream_started", () => {
  const { adapter } = readyAdapter();
  assert.equal(adapter.handleControl({ direction: "client_to_server", text: makeStartText("measurement-0") }), true);
  const malformed = JSON.parse(makeStartedText(1, "different-stream"));
  assert.equal(adapter.handleControl({ direction: "server_to_client", text: JSON.stringify(malformed) }), false);
  assert.equal(adapter.controlState, "READY");
  assert.equal(adapter.decoderState, null);
});

test("display-window eviction is a viewer condition, not a device sequence gap", () => {
  const { model, adapter } = readyAdapter({ displayWindowSeconds: 1 });
  startVi(adapter);
  assert.equal(emitFirst(adapter), true);
  assert.equal(adapter.handleBinary(frame({ sequence: BASE_SEQUENCE + 1n, timestampUs: 3_000_000n })), true);
  const summary = model.summary();
  assert.equal(summary.sequenceGapCount, 0);
  assert.equal(summary.viewerWindowEvictionCount, 1);
  assert.equal(summary.bufferUsage, 1);
});

test("reconnect keeps only the active device-time viewport while counters remain cumulative", () => {
  const model = new StreamModel({ capacity: 64, displayWindowSeconds: 60 });
  model.beginStream({ streamId: 1, profile: "vi-measurement" });
  commitDecodedViFrame(model, { streamId: 1, sequence: 1n, timestampUs: 0n });
  commitDecodedViFrame(model, { streamId: 1, sequence: 2n, timestampUs: 10_000_000n, flags: 0, withSegment: false });
  model.finishStream();

  model.beginStream({ streamId: 2, profile: "vi-measurement" });
  commitDecodedViFrame(model, { streamId: 2, sequence: 1n, timestampUs: 10_040_000n });
  commitDecodedViFrame(model, { streamId: 2, sequence: 2n, timestampUs: 80_000_000n, flags: 0, withSegment: false });

  const records = model.recordSnapshot();
  const markers = model.markerSnapshot();
  assert.deepEqual(records.map((record) => ({ streamId: record.stream_id, timestampUs: record.timestamp_us })), [
    { streamId: 2, timestampUs: 80_000_000n },
  ]);
  assert.deepEqual(markers, []);
  assert.ok(records.at(-1).timestamp_us - records[0].timestamp_us <= 60_000_000n);
  assert.deepEqual(model.summary().latest, {
    streamId: 2,
    sequence: "2",
    timestampUs: "80000000",
    voltageV: 3.3,
    currentA: 0.1,
    validMask: 3,
  });
  assert.equal(model.summary().sampleCount, 4);
  assert.equal(model.summary().segmentCount, 2);
  assert.equal(model.summary().viewerWindowEvictionCount, 1);
});

test("a new stream may reset device timestamps without retaining the prior stream viewport", () => {
  const model = new StreamModel();
  model.beginStream({ streamId: 1, profile: "vi-measurement" });
  commitDecodedViFrame(model, { streamId: 1, sequence: 90n, timestampUs: 80_000_000n });
  model.finishStream();

  model.beginStream({ streamId: 2, profile: "vi-measurement" });
  commitDecodedViFrame(model, { streamId: 2, sequence: 1n, timestampUs: 0n });

  assert.deepEqual(model.recordSnapshot().map((record) => ({ streamId: record.stream_id, timestampUs: record.timestamp_us })), [
    { streamId: 2, timestampUs: 0n },
  ]);
  assert.deepEqual(model.markerSnapshot().map((marker) => ({ streamId: marker.stream_id, timestampUs: marker.timestamp_us })), [
    { streamId: 2, timestampUs: 0n },
  ]);
  assert.equal(model.summary().sampleCount, 2);
  assert.equal(model.summary().segmentCount, 2);
});

test("an accepted TIMEBASE_RESET commits a fresh viewport epoch without losing counters", () => {
  const model = new StreamModel();
  model.beginStream({ streamId: 1, profile: "vi-measurement" });
  commitDecodedViFrame(model, { streamId: 1, sequence: 90n, timestampUs: 80_000_000n });
  const beforeReset = model.recordSnapshot()[0];

  const resetCandidate = model.prepareDecodedFrame(decodedViFrame({
    streamId: 1,
    sequence: 1n,
    timestampUs: 0n,
    flags: 0x45,
    timebaseReset: true,
  }));
  assert.deepEqual(model.recordSnapshot(), [beforeReset], "prepare must not clear a viewport");
  assert.equal(model.markerSnapshot().length, 1);

  model.commitCandidate(resetCandidate);
  const resetRecord = model.recordSnapshot()[0];
  const resetMarker = model.markerSnapshot()[0];
  assert.deepEqual(model.recordSnapshot().map((record) => record.timestamp_us), [0n]);
  assert.deepEqual(model.markerSnapshot().map((marker) => marker.timestamp_us), [0n]);
  assert.notEqual(resetRecord.segment_id, beforeReset.segment_id);
  assert.notEqual(resetRecord.voltage_segment_id, beforeReset.voltage_segment_id);
  assert.notEqual(resetRecord.current_segment_id, beforeReset.current_segment_id);
  assert.equal(resetMarker.causes.timebaseReset, true);

  commitDecodedViFrame(model, {
    streamId: 1,
    sequence: 2n,
    timestampUs: 1n,
    flags: 0,
    validMask: 0,
    withSegment: false,
  });
  const [first, invalid] = model.recordSnapshot();
  assert.equal(first.valid_mask, 3);
  assert.equal(invalid.voltage_V, null);
  assert.equal(invalid.current_A, null);
  assert.equal(model.summary().sampleCount, 3);
  assert.equal(model.summary().segmentCount, 2);
  assert.equal(model.summary().invalidVoltageCount, 1);
  assert.equal(model.summary().invalidCurrentCount, 1);
});

test("active-epoch window eviction cannot be blocked by stale FIFO entries", () => {
  const model = new StreamModel({ displayWindowSeconds: 1 });
  model.beginStream({ streamId: 7, profile: "vi-measurement" });
  model.records.append(Object.freeze({ stream_id: 6, timestamp_us: 0n }));
  model.records.append(Object.freeze({ stream_id: 7, timestamp_us: 0n }));
  model.markers.append(Object.freeze({ stream_id: 6, timestamp_us: 0n }));
  model.markers.append(Object.freeze({ stream_id: 7, timestamp_us: 0n }));

  commitDecodedViFrame(model, { streamId: 7, sequence: 1n, timestampUs: 3_000_000n });

  assert.deepEqual(model.recordSnapshot().map((record) => ({ streamId: record.stream_id, timestampUs: record.timestamp_us })), [
    { streamId: 7, timestampUs: 3_000_000n },
  ]);
  assert.deepEqual(model.markerSnapshot().map((marker) => ({ streamId: marker.stream_id, timestampUs: marker.timestamp_us })), [
    { streamId: 7, timestampUs: 3_000_000n },
  ]);
  assert.equal(model.summary().viewerWindowEvictionCount, 1);
});

test("S3 and S4 omit logical positions in both device time and sequence", () => {
  const cases = [
    { scenario: "producer-gap", retained: 245, delta: 6n, timestampDelta: 6n * SAMPLE_PERIOD_US, flag: 0x0c, gapSamples: "5" },
    { scenario: "output-drop", retained: 247, delta: 4n, timestampDelta: 4n * SAMPLE_PERIOD_US, flag: 0x14, gapSamples: "3" },
  ];
  for (const expectation of cases) {
    const data = flaggedDataFrames(expectation.scenario);
    assert.equal(data.length, expectation.retained);
    const afterIndex = data.findIndex((event) => (envelope(event.buffer).flags & 0x04) !== 0);
    assert.ok(afterIndex > 0);
    const before = envelope(data[afterIndex - 1].buffer);
    const after = envelope(data[afterIndex].buffer);
    assert.equal(after.flags, expectation.flag);
    assert.equal(after.sequence - before.sequence, expectation.delta);
    assert.equal(after.timestampUs - before.timestampUs, expectation.timestampDelta);
    const end = buildSyntheticPlan(expectation.scenario).filter((event) => event.kind === "binary").at(-1);
    assert.equal(envelope(end.buffer).sequence, BASE_SEQUENCE + 250n);
    assert.equal(envelope(end.buffer).timestampUs, 10_000_000n);
    const run = driveSyntheticScenario(expectation.scenario);
    assert.equal(run.model.summary().sequenceGapSamples, expectation.gapSamples);
  }
});

test("all S1-S7 synthetic scenarios preserve their stated semantics", () => {
  const stable = driveSyntheticScenario("stable");
  assert.equal(stable.model.summary().sampleCount, 250);
  assert.equal(stable.model.summary().segmentCount, 1);
  assert.equal(stable.model.summary().sequenceGapCount, 0);

  const step = driveSyntheticScenario("step");
  const stepRecords = step.model.recordSnapshot();
  assert.equal(step.model.summary().sampleCount, 250);
  assertClose(stepRecords[0].voltage_V, 0);
  assertClose(stepRecords[0].current_A, 0);
  assertClose(stepRecords[50].voltage_V, 5);
  assertClose(stepRecords[50].current_A, 0.2);
  assertClose(stepRecords[175].voltage_V, 5);
  assertClose(stepRecords[175].current_A, 0.08);

  const producer = driveSyntheticScenario("producer-gap");
  assert.equal(producer.model.summary().sampleCount, 245);
  assert.equal(producer.model.summary().segmentCount, 2);
  assert.equal(producer.model.summary().sequenceGapCount, 1);
  assert.equal(producer.model.summary().producerOverflowCount, 1);

  const output = driveSyntheticScenario("output-drop");
  assert.equal(output.model.summary().sampleCount, 247);
  assert.equal(output.model.summary().segmentCount, 2);
  assert.equal(output.model.summary().outputQueueDropCount, 1);

  const validity = driveSyntheticScenario("validity");
  assert.equal(validity.model.summary().sampleCount, 250);
  assert.equal(validity.model.summary().invalidVoltageCount, 126);
  assert.equal(validity.model.summary().invalidCurrentCount, 125);

  const reconnect = driveSyntheticScenario("reconnect");
  assert.equal(reconnect.model.summary().sampleCount, 250);
  assert.equal(reconnect.model.summary().segmentCount, 2);
  assert.deepEqual([...new Set(reconnect.model.recordSnapshot().map((record) => record.stream_id))], [2]);

  const invalid = driveSyntheticScenario("invalid-frame");
  assert.equal(invalid.model.summary().sampleCount, 250);
  assert.equal(invalid.model.summary().sequenceGapCount, 0);
  assert.equal(invalid.rejectedBinaryCount, 1);
  assert.equal(invalid.adapter.summary().lastError.code, "bad_magic");
});

test("synthetic source start/stop lifecycle is bounded and closes cleanly", async () => {
  const model = new StreamModel();
  const adapter = new SessionAdapter(model);
  const source = new SyntheticSource({ scenario: "stable", speed: "fast" });
  attach(source, adapter);
  try {
    await source.open();
    await source.start();
    await waitFor(() => model.summary().sampleCount >= 2);
    await source.stop();
    assert.equal(source.state, "stopped");
    assert.equal(adapter.controlState, "READY");
  } finally {
    await source.close();
  }
  assert.equal(source.state, "closed");
});

test("WebSocket stream selection is explicit, allowlisted, and wire-safe", { concurrency: false }, async () => {
  await withControlledWebSocket(async () => {
    const endpoint = "ws://example.test/d2b/v0/stream";
    const authority = new SessionAdapter(new StreamModel());
    const invalidSelections = [
      { supportedStreams: LIVE_SUPPORTED_STREAMS },
      { stream: "   ", supportedStreams: LIVE_SUPPORTED_STREAMS },
      { stream: " live-vi ", supportedStreams: LIVE_SUPPORTED_STREAMS },
      { stream: "unknown-stream", supportedStreams: LIVE_SUPPORTED_STREAMS },
      { stream: LIVE_STREAM, supportedStreams: [] },
      { stream: "not wire safe", supportedStreams: ["not wire safe"] },
    ];
    for (const options of invalidSelections) {
      assert.throws(() => new WebSocketSource({ endpoint, controlAuthority: authority, ...options }), /stream|supportedStreams/i);
      assert.equal(ControlledWebSocket.instances.length, 0, "invalid stream selection must not construct a WebSocket");
    }
    assert.throws(() => new WebSocketSource({ endpoint, stream: LIVE_STREAM, supportedStreams: LIVE_SUPPORTED_STREAMS }), /controlAuthority/i);
    assert.equal(ControlledWebSocket.instances.length, 0, "missing authority must not construct a WebSocket");

    const { adapter, source } = makeLiveWebSocketSource({ endpoint });
    const opening = source.open();
    const socket = ControlledWebSocket.instances[0];
    socket.open();
    await opening;
    socket.message(makeWelcomeText());
    assert.equal(adapter.controlState, "READY");
    await source.start();
    assert.deepEqual(JSON.parse(socket.sent.at(-1)), {
      type: "start_stream",
      stream: LIVE_STREAM,
      profile: "vi-measurement",
      parameters: DEFAULT_VI_PARAMETERS,
    });

    const closing = source.close();
    socket.finishClose();
    await closing;
  });
});

test("outbound authority tokens are opaque, single-use reservations", () => {
  const { adapter } = readyAdapter();
  const state = () => {
    const summary = adapter.summary();
    return {
      controlState: summary.controlState,
      streamId: summary.streamId,
      startPending: summary.startPending,
      stopPending: summary.stopPending,
    };
  };

  const ready = state();
  assert.throws(() => adapter.prepareOutboundControl(makeStopText(1)), /stop_stream/);
  assert.deepEqual(state(), ready, "a rejected prepare must not mutate control state");

  const token = adapter.prepareOutboundControl(makeStartText(LIVE_STREAM));
  assert.deepEqual(state(), { controlState: "READY", streamId: null, startPending: true, stopPending: false });
  const reserved = state();
  assert.throws(() => adapter.commitOutboundControl(Object.freeze(Object.create(null))), /invalid outbound control token/);
  assert.deepEqual(state(), reserved, "a foreign token must not mutate the reservation");

  adapter.rollbackOutboundControl(token);
  assert.deepEqual(state(), ready);
  assert.throws(() => adapter.rollbackOutboundControl(token), /invalid outbound control token/);
  assert.throws(() => adapter.commitOutboundControl(token), /invalid outbound control token/);
  assert.deepEqual(state(), ready, "a stale token must not mutate control state");

  const committedToken = adapter.prepareOutboundControl(makeStartText(LIVE_STREAM));
  adapter.commitOutboundControl(committedToken);
  assert.deepEqual(state(), { controlState: "READY", streamId: null, startPending: true, stopPending: false });
  assert.throws(() => adapter.prepareOutboundControl(makeStartText(LIVE_STREAM)), /already pending/);
  assert.equal(adapter.handleControl({ direction: "server_to_client", text: makeStartedText(41, "wrong-stream") }), false);
  assert.deepEqual(state(), { controlState: "READY", streamId: null, startPending: true, stopPending: false });
  assert.equal(adapter.handleControl({ direction: "server_to_client", text: makeStartedText(41, LIVE_STREAM) }), true);
  assert.deepEqual(state(), { controlState: "STREAMING", streamId: 41, startPending: false, stopPending: false });

  const stopToken = adapter.prepareOutboundControl(makeStopText(41));
  adapter.commitOutboundControl(stopToken);
  assert.deepEqual(state(), { controlState: "STREAMING", streamId: 41, startPending: false, stopPending: true });
  assert.throws(() => adapter.prepareOutboundControl(makeStopText(41)), /already pending/);
});

test("live source sends only authority-approved controls and forwards only raw server controls", { concurrency: false }, async () => {
  await withControlledWebSocket(async () => {
    const { adapter, source } = makeLiveWebSocketSource();
    const controls = [];
    source.onControl((control) => {
      controls.push(control);
      return adapter.handleControl(control);
    });
    const opening = source.open();
    const socket = ControlledWebSocket.instances[0];
    socket.open();
    await opening;
    assert.deepEqual(socket.sent.map((text) => JSON.parse(text).type), ["hello"]);
    assert.deepEqual(controls, [], "outbound hello must not be emitted through the server-control callback");

    const beforePrematureStart = socket.sent.length;
    await assert.rejects(source.start(), /start_stream/);
    assert.equal(socket.sent.length, beforePrematureStart, "a rejected start must not reach the wire");
    assert.equal(adapter.summary().startPending, false);

    socket.message(makeWelcomeText());
    assert.equal(adapter.controlState, "READY");
    assert.deepEqual(controls.map((control) => control.direction), ["server_to_client"]);
    await source.start();
    assert.equal(adapter.summary().startPending, true);
    assert.equal(socket.sent.filter((text) => JSON.parse(text).type === "start_stream").length, 1);
    await assert.rejects(source.start(), /already pending/);
    assert.equal(socket.sent.filter((text) => JSON.parse(text).type === "start_stream").length, 1);

    socket.message(makeStartedText(23, LIVE_STREAM));
    assert.equal(adapter.summary().streamId, 23);
    await source.stop();
    assert.deepEqual(JSON.parse(socket.sent.at(-1)), { type: "stop_stream", stream_id: 23, reason: "viewer stop" });
    await assert.rejects(source.stop(), /already pending/);

    const closing = source.close();
    socket.finishClose();
    await closing;
  });
});

test("a throwing start send rolls back exactly once and retry commits exactly once", { concurrency: false }, async () => {
  await withControlledWebSocket(async () => {
    const model = new StreamModel();
    const adapter = new SessionAdapter(model);
    const calls = { prepare: 0, commit: 0, rollback: 0 };
    const authority = {
      prepareOutboundControl(text) {
        calls.prepare += 1;
        return adapter.prepareOutboundControl(text);
      },
      commitOutboundControl(token) {
        calls.commit += 1;
        return adapter.commitOutboundControl(token);
      },
      rollbackOutboundControl(token) {
        calls.rollback += 1;
        return adapter.rollbackOutboundControl(token);
      },
      summary() { return adapter.summary(); },
    };
    const source = new WebSocketSource({
      endpoint: "ws://example.test/d2b/v0/stream",
      stream: LIVE_STREAM,
      supportedStreams: LIVE_SUPPORTED_STREAMS,
      controlAuthority: authority,
    });
    attach(source, adapter);
    const opening = source.open();
    const socket = ControlledWebSocket.instances[0];
    socket.open();
    await opening;
    socket.message(makeWelcomeText());
    assert.deepEqual(calls, { prepare: 1, commit: 1, rollback: 0 }, "hello must commit through the same authority transaction");

    socket.throwOnSend = new Error("mock start send failure");
    const sentBeforeFailure = socket.sent.length;
    await assert.rejects(source.start(), /mock start send failure/);
    assert.equal(socket.sent.length, sentBeforeFailure);
    assert.deepEqual(calls, { prepare: 2, commit: 1, rollback: 1 });
    assert.equal(adapter.summary().startPending, false, "failed send must restore the pre-send state");

    socket.throwOnSend = null;
    await source.start();
    assert.deepEqual(calls, { prepare: 3, commit: 2, rollback: 1 });
    assert.equal(adapter.summary().startPending, true);

    const closing = source.close();
    socket.finishClose();
    await closing;
  });
});

test("a failed hello send rolls back its reservation and a new socket can retry", { concurrency: false }, async () => {
  await withControlledWebSocket(async () => {
    const model = new StreamModel();
    const adapter = new SessionAdapter(model);
    const calls = { prepare: 0, commit: 0, rollback: 0 };
    const authority = {
      prepareOutboundControl(text) { calls.prepare += 1; return adapter.prepareOutboundControl(text); },
      commitOutboundControl(token) { calls.commit += 1; return adapter.commitOutboundControl(token); },
      rollbackOutboundControl(token) { calls.rollback += 1; return adapter.rollbackOutboundControl(token); },
      summary() { return adapter.summary(); },
    };
    const source = new WebSocketSource({
      endpoint: "ws://example.test/d2b/v0/stream",
      stream: LIVE_STREAM,
      supportedStreams: LIVE_SUPPORTED_STREAMS,
      controlAuthority: authority,
    });
    attach(source, adapter);

    const failedOpening = source.open();
    const first = ControlledWebSocket.instances[0];
    first.throwOnSend = new Error("mock hello send failure");
    first.open();
    await assert.rejects(failedOpening, /mock hello send failure/);
    assert.deepEqual(calls, { prepare: 1, commit: 0, rollback: 1 });
    const failedClose = source._closePromise;
    assert.ok(failedClose);
    first.finishClose();
    await failedClose;

    const retryOpening = source.open();
    const second = ControlledWebSocket.instances[1];
    second.open();
    await retryOpening;
    assert.deepEqual(calls, { prepare: 2, commit: 1, rollback: 1 });
    second.message(makeWelcomeText());
    assert.equal(adapter.controlState, "READY");

    const closing = source.close();
    second.finishClose();
    await closing;
  });
});

test("observer failures cannot undo an already-sent authority commit", { concurrency: false }, async () => {
  await withControlledWebSocket(async () => {
    const model = new StreamModel();
    const adapter = new SessionAdapter(model, { onChange: () => { throw new Error("hostile observer"); } });
    const source = new WebSocketSource({
      endpoint: "ws://example.test/d2b/v0/stream",
      stream: LIVE_STREAM,
      supportedStreams: LIVE_SUPPORTED_STREAMS,
      controlAuthority: adapter,
    });
    attach(source, adapter);
    const opening = source.open();
    const socket = ControlledWebSocket.instances[0];
    socket.open();
    await opening;
    socket.message(makeWelcomeText());

    await source.start();
    assert.equal(socket.sent.filter((text) => JSON.parse(text).type === "start_stream").length, 1);
    assert.equal(adapter.summary().startPending, true);
    assert.ok(adapter.diagnostics().some((entry) => entry.code === "observer_error"));

    const closing = source.close();
    socket.finishClose();
    await closing;
  });
});

test("live action availability is a pure conservative UI policy", () => {
  const cases = [
    [{ controlState: "READY", startPending: false, stopPending: false, streamId: null }, { state: "open" }, { start: true, stop: false }],
    [{ controlState: "READY", startPending: true, stopPending: false, streamId: null }, { state: "open" }, { start: false, stop: false }],
    [{ controlState: "STREAMING", startPending: false, stopPending: false, streamId: 7 }, { state: "open" }, { start: false, stop: true }],
    [{ controlState: "STREAMING", startPending: false, stopPending: true, streamId: 7 }, { state: "open" }, { start: false, stop: false }],
    [{ controlState: "STREAMING", startPending: false, stopPending: false, streamId: null }, { state: "open" }, { start: false, stop: false }],
    [{ controlState: "READY", startPending: false, stopPending: false, streamId: null }, { state: "closed" }, { start: false, stop: false }],
  ];
  for (const [session, sourceStatus, expected] of cases) {
    assert.deepEqual(liveActionAvailability(session, sourceStatus), expected);
  }
});

test("checked-in VAMeter fixture exposes and requests the exact live V/I stream", async () => {
  const capture = JSON.parse(await readFile(new URL("../fixtures/capture/synthetic-live-capture.json", import.meta.url), "utf8"));
  const capabilities = JSON.parse(capture.capabilities_text);
  const liveStream = capabilities.streams.find((stream) => stream.id === LIVE_STREAM);
  assert.ok(liveStream, "fixture must advertise live-vi");
  const viProfile = liveStream.profiles.find((profile) => profile.profile === "vi-measurement");
  assert.ok(viProfile, "live-vi must advertise vi-measurement");
  assert.deepEqual(viProfile.parameter_sets, [DEFAULT_VI_PARAMETERS]);

  const start = JSON.parse(capture.controls.find((control) => {
    const message = JSON.parse(control.text);
    return control.direction === "client_to_server" && message.type === "start_stream";
  }).text);
  assert.deepEqual(start, {
    type: "start_stream",
    stream: LIVE_STREAM,
    profile: "vi-measurement",
    parameters: DEFAULT_VI_PARAMETERS,
  });
});

test("application live mode explicitly constructs the captured live stream", async () => {
  const appText = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(appText, /new WebSocketSource\(\{\s*endpoint: controls\.endpoint\.value,\s*stream: "live-vi",\s*supportedStreams: \["live-vi"\],\s*controlAuthority: adapter,\s*\}\)/);
});

test("WebSocket close owns its callbacks through awaited reopen", { concurrency: false }, async () => {
  await withControlledWebSocket(async () => {
    const { adapter, source } = makeLiveWebSocketSource();
    const statuses = [];
    const controls = [];
    const errors = [];
    source.onStatus((status) => {
      statuses.push(status.state);
      adapter.notifyTransportStatus(status);
    });
    source.onControl((control) => {
      controls.push(control);
      return adapter.handleControl(control);
    });
    source.onError((error) => {
      errors.push(error);
      adapter.handleError(error);
    });

    const firstOpen = source.open();
    const first = ControlledWebSocket.instances[0];
    assert.equal(first.binaryType, "arraybuffer");
    first.open();
    await firstOpen;
    assert.equal(source.socket, first);
    assert.equal(JSON.parse(first.sent[0]).type, "hello");
    assert.equal(controls.length, 0, "outbound hello must not be replayed through onControl");
    first.message(makeWelcomeText());
    assert.equal(adapter.controlState, "READY");
    assert.equal(controls.length, 1);

    const pendingClose = source.close();
    let closeResolved = false;
    pendingClose.then(() => { closeResolved = true; });
    await Promise.resolve();
    assert.equal(first.readyState, ControlledWebSocket.CLOSING);
    assert.equal(closeResolved, false);

    const reopening = source.open();
    assert.equal(ControlledWebSocket.instances.length, 1, "open must wait for the owned close");
    first.finishClose();
    await pendingClose;
    await Promise.resolve();
    const second = ControlledWebSocket.instances[1];
    assert.ok(second, "reopen did not create a new socket after close");
    second.open();
    await reopening;
    assert.equal(source.socket, second);
    assert.equal(source.state, "open");
    second.message(makeWelcomeText());
    assert.equal(adapter.controlState, "READY");

    const statusCountBeforeStaleCallbacks = statuses.length;
    const controlCountBeforeStaleCallbacks = controls.length;
    const errorCountBeforeStaleCallbacks = errors.length;
    first.open();
    first.message(JSON.stringify({ type: "stream_started", stream_id: 999 }));
    first.error();
    first.finishClose();
    assert.equal(source.socket, second);
    assert.equal(source.state, "open");
    assert.equal(statuses.length, statusCountBeforeStaleCallbacks);
    assert.equal(controls.length, controlCountBeforeStaleCallbacks);
    assert.equal(errors.length, errorCountBeforeStaleCallbacks);
    assert.equal(statuses.at(-1), "open");

    await source.start();
    second.message(JSON.stringify({ type: "stream_started", stream: LIVE_STREAM, profile: "vi-measurement", parameters: DEFAULT_VI_PARAMETERS, stream_id: 22 }));
    await source.stop();
    assert.equal(JSON.parse(second.sent.at(-2)).type, "start_stream");
    assert.equal(JSON.parse(second.sent.at(-1)).stream_id, 22);

    const finalClose = source.close();
    second.finishClose();
    await finalClose;
    assert.equal(source.state, "closed");
    assert.equal(source.socket, null);
  });
});

test("WebSocket synchronous construction and close failures clear pending attempts", { concurrency: false }, async () => {
  const { adapter, source } = makeLiveWebSocketSource();
  class ThrowingWebSocket {
    constructor() { throw new Error("mock constructor failure"); }
  }
  await withWebSocketClass(ThrowingWebSocket, async () => {
    await assert.rejects(source.open(), /mock constructor failure/);
    assert.equal(source.socket, null);
    assert.equal(source._openPromise, null);
  });

  await withControlledWebSocket(async () => {
    const opening = source.open();
    const socket = ControlledWebSocket.instances[0];
    socket.open();
    await opening;
    socket.message(makeWelcomeText());
    assert.equal(adapter.controlState, "READY");
    socket.throwOnClose = new Error("mock close failure");
    await assert.rejects(source.close(), /mock close failure/);
    assert.equal(source.socket, socket);
    assert.equal(source._closePromise, null);
    socket.throwOnClose = null;
    const closing = source.close();
    socket.finishClose();
    await closing;
    assert.equal(source.socket, null);
    assert.equal(source.state, "closed");
  });
});

test("exact VAMeter capture schema replays fractional received_ms and rejects legacy frame shape", async () => {
  const captureText = await readFile(new URL("../fixtures/capture/synthetic-live-capture.json", import.meta.url), "utf8");
  const events = parseLiveCapture(captureText);
  assert.deepEqual(events.map((event) => event.eventIndex), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(events[1].receivedMs, 1.25);
  assert.equal(events[4].receivedMs, 10.5);
  assert.equal(events.filter((event) => event.kind === "binary").length, 3);

  const legacy = JSON.parse(captureText);
  legacy.frames[0].frame_hex = legacy.frames[0].hex;
  legacy.frames[0].direction = "server_to_client";
  delete legacy.frames[0].hex;
  assert.throws(() => parseLiveCapture(JSON.stringify(legacy)), /fields must be exactly/);

  const model = new StreamModel();
  const adapter = new SessionAdapter(model);
  const source = new CaptureReplaySource({ speed: "fast" });
  attach(source, adapter);
  try {
    source.loadText(captureText);
    await source.open();
    await source.start();
    await waitFor(() => source.state === "stopped");
    assert.equal(model.summary().sampleCount, 2);
    assert.equal(adapter.controlState, "READY");
  } finally {
    await source.close();
  }
});
