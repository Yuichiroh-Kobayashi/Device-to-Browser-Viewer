import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { BoundedSegmentBuffer } from "../src/model/bounded-segment-buffer.js";
import { StreamModel } from "../src/model/stream-model.js";
import { SessionAdapter } from "../src/protocol/session-adapter.js";
import { relativeDeviceSeconds } from "../src/render/scale.js";
import { parseLiveCapture, CaptureReplaySource } from "../src/sources/capture-replay-source.js";
import { WebSocketSource } from "../src/sources/websocket-source.js";
import {
  DEFAULT_VI_PARAMETERS, buildSyntheticPlan, makeHelloText, makeWelcomeText, makeStartText, makeStartedText,
  makeStoppedText, makeStreamEndFrame, makeViFrame, SyntheticSource,
} from "../src/sources/synthetic-source.js";

const BASE_SEQUENCE = 9_007_199_254_742_000n;
const SAMPLE_PERIOD_US = 40_000n;

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
    this.closeCalls = 0;
    this.throwOnClose = null;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    ControlledWebSocket.instances.push(this);
  }

  static reset() { ControlledWebSocket.instances = []; }

  send(text) {
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

test("new stream creates a hard model segment without joining old line", () => {
  const { model, adapter } = readyAdapter();
  startVi(adapter, 1);
  assert.equal(emitFirst(adapter, { streamId: 1 }), true);
  assert.equal(adapter.handleBinary(makeStreamEndFrame({ streamId: 1, sequence: BASE_SEQUENCE + 1n, timestampUs: 1_040_000n })), true);
  assert.equal(adapter.handleControl({ direction: "server_to_client", text: makeStoppedText(1) }), true);
  startVi(adapter, 2);
  assert.equal(emitFirst(adapter, { streamId: 2, timestampUs: 2_000_000n }), true);
  const records = model.recordSnapshot();
  assert.equal(records.length, 2);
  assert.notEqual(records[0].segment_id, records[1].segment_id);
  assert.deepEqual(records.map((record) => record.stream_id), [1, 2]);
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
  assert.deepEqual([...new Set(reconnect.model.recordSnapshot().map((record) => record.stream_id))], [1, 2]);

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

test("WebSocket close owns its callbacks through awaited reopen", { concurrency: false }, async () => {
  await withControlledWebSocket(async () => {
    const source = new WebSocketSource({ endpoint: "ws://example.test/d2b/v0/stream" });
    const statuses = [];
    const controls = [];
    const errors = [];
    source.onStatus((status) => statuses.push(status.state));
    source.onControl((control) => controls.push(control));
    source.onError((error) => errors.push(error));

    const firstOpen = source.open();
    const first = ControlledWebSocket.instances[0];
    assert.equal(first.binaryType, "arraybuffer");
    first.open();
    await firstOpen;
    assert.equal(source.socket, first);
    assert.equal(JSON.parse(first.sent[0]).type, "hello");
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
    second.message(JSON.stringify({ type: "stream_started", stream: "measurement-0", profile: "vi-measurement", parameters: DEFAULT_VI_PARAMETERS, stream_id: 22 }));
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
  const source = new WebSocketSource({ endpoint: "ws://example.test/d2b/v0/stream" });
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
