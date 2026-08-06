import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { StreamModel } from "../src/model/stream-model.js";
import { SessionAdapter } from "../src/protocol/session-adapter.js";
import { WebSocketSource } from "../src/sources/websocket-source.js";
import {
  DEFAULT_VI_PARAMETERS, makeHelloText, makeStartText, makeStartedText, makeStopText,
  makeStoppedText, makeStreamEndFrame, makeViFrame, makeWelcomeText,
} from "../src/sources/synthetic-source.js";

const ENDPOINT = "ws://example.test/d2b/v0/stream";
const LIVE_STREAM = "live-vi";
const TEST_TIMEOUT_MS = 80;

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
    return this.onopen?.({});
  }

  message(data) { return this.onmessage?.({ data }); }
  error() { return this.onerror?.({}); }

  finishClose() {
    this.readyState = ControlledWebSocket.CLOSED;
    return this.onclose?.({});
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

async function actionOutcome(action) {
  try {
    await action();
    return "fulfilled";
  } catch {
    return "rejected";
  }
}

async function settledWithin(promise, timeoutMs = TEST_TIMEOUT_MS) {
  let timer = null;
  const completion = Promise.resolve(promise).then(
    () => ({ status: "fulfilled" }),
    () => ({ status: "rejected" }),
  );
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  const result = await Promise.race([completion, timeout]);
  clearTimeout(timer);
  return result;
}

function sentControls(socket, type) {
  return socket.sent.map((text) => JSON.parse(text)).filter((message) => message.type === type);
}

function readyAdapter({ capacity = 64, displayWindowSeconds = 60, supportedStreams = [LIVE_STREAM] } = {}) {
  const model = new StreamModel({ capacity, displayWindowSeconds });
  // `supportedStreams` is intentionally a future option at this baseline.
  const adapter = new SessionAdapter(model, { supportedStreams });
  adapter.notifyTransportStatus({ state: "open" });
  assert.equal(adapter.handleControl({ direction: "client_to_server", text: makeHelloText() }), true);
  assert.equal(adapter.handleControl({ direction: "server_to_client", text: makeWelcomeText() }), true);
  assert.equal(adapter.controlState, "READY");
  return { model, adapter };
}

function startAdapterStream(adapter, streamId, stream = LIVE_STREAM) {
  assert.equal(adapter.handleControl({ direction: "client_to_server", text: makeStartText(stream) }), true);
  assert.equal(adapter.handleControl({ direction: "server_to_client", text: makeStartedText(streamId, stream) }), true);
  assert.equal(adapter.controlState, "STREAMING");
}

function stopAdapterStream(adapter, streamId, sequence, timestampUs) {
  assert.equal(adapter.handleControl({ direction: "client_to_server", text: makeStopText(streamId) }), true);
  assert.equal(adapter.handleBinary(makeStreamEndFrame({ streamId, sequence, timestampUs })), true);
  assert.equal(adapter.handleControl({ direction: "server_to_client", text: makeStoppedText(streamId) }), true);
  assert.equal(adapter.controlState, "READY");
}

function attachLiveSource(source, adapter, controlResults = [], { onStatus = null, onError = null } = {}) {
  source.onStatus((status) => adapter.notifyTransportStatus(status));
  source.onControl((control) => {
    const accepted = adapter.handleControl(control);
    controlResults.push(Object.freeze({ direction: control.direction, accepted }));
    return accepted;
  });
  source.onBinary((buffer) => adapter.handleBinary(buffer));
  source.onError((error) => {
    adapter.handleError(error);
    onError?.(error);
  });
  if (onStatus) {
    source.onStatus((status) => {
      adapter.notifyTransportStatus(status);
      onStatus(status);
    });
  }
}

function makeLiveSession({ stream = LIVE_STREAM, supportedStreams = [LIVE_STREAM], displayWindowSeconds = 60 } = {}) {
  const model = new StreamModel({ displayWindowSeconds });
  // Both options are deliberately supplied before their production implementation.
  const adapter = new SessionAdapter(model, { supportedStreams });
  const options = { endpoint: ENDPOINT, stream, supportedStreams, controlAuthority: adapter };
  const source = new WebSocketSource(options);
  const controlResults = [];
  attachLiveSource(source, adapter, controlResults);
  return { model, adapter, source, controlResults };
}

function makeStandaloneLiveSource({ onStatus = null, onError = null } = {}) {
  const session = makeLiveSession();
  attachLiveSource(session.source, session.adapter, session.controlResults, { onStatus, onError });
  return session;
}

async function openLiveSession(options = {}) {
  const session = makeLiveSession(options);
  const opening = session.source.open();
  const socket = ControlledWebSocket.instances.at(-1);
  assert.ok(socket, "open did not construct a controlled socket");
  socket.open();
  await opening;
  if (options.welcome !== false) {
    socket.message(makeWelcomeText());
    assert.equal(session.adapter.controlState, "READY");
  }
  return { ...session, socket };
}

async function closeAndFinish(source, socket) {
  const closing = source.close();
  if (socket.readyState !== ControlledWebSocket.CLOSED) socket.finishClose();
  await closing;
}

function commitModelFrame(model, {
  streamId,
  sequence,
  timestampUs,
  flags = 0x01,
  timebaseReset = false,
} = {}) {
  const candidate = model.prepareDecodedFrame({
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
      validMask: 3,
      measurements: { voltage: 3.3, current: 0.1 },
    }],
    segment: {
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
    },
  });
  model.commitCandidate(candidate);
}

function snapshotForEpoch(model) {
  const records = model.recordSnapshot();
  const markers = model.markerSnapshot();
  return {
    records: records.map((record) => ({ streamId: record.stream_id, timestampUs: record.timestamp_us })),
    markers: markers.map((marker) => ({ streamId: marker.stream_id, timestampUs: marker.timestamp_us, timebaseReset: marker.causes.timebaseReset })),
  };
}

test("T0-01 live fixture capability is the only accepted selected stream", { concurrency: false }, async () => {
  const capture = JSON.parse(await readFile(new URL("../fixtures/capture/synthetic-live-capture.json", import.meta.url), "utf8"));
  const capabilities = JSON.parse(capture.capabilities_text);
  const captureStart = JSON.parse(capture.controls.find((control) => control.direction === "client_to_server" && JSON.parse(control.text).type === "start_stream").text);

  const selection = await withControlledWebSocket(async () => {
    const missing = await actionOutcome(() => new WebSocketSource({ endpoint: ENDPOINT, supportedStreams: [LIVE_STREAM] }));
    const unknown = await actionOutcome(() => new WebSocketSource({ endpoint: ENDPOINT, stream: "missing-stream", supportedStreams: [LIVE_STREAM] }));
    return { missing, unknown, constructedSockets: ControlledWebSocket.instances.length };
  });

  const wire = await withControlledWebSocket(async () => {
    const { source, socket } = await openLiveSession({ stream: LIVE_STREAM });
    const start = await actionOutcome(() => source.start());
    const startControl = sentControls(socket, "start_stream")[0];
    await closeAndFinish(source, socket);
    return { selectedStream: source.stream, start, wireStream: startControl?.stream ?? null };
  });

  assert.deepEqual({
    advertisedStreams: capabilities.streams.map((stream) => stream.id),
    capturedStartStream: captureStart.stream,
    ...selection,
    ...wire,
  }, {
    advertisedStreams: [LIVE_STREAM],
    capturedStartStream: LIVE_STREAM,
    missing: "rejected",
    unknown: "rejected",
    constructedSockets: 0,
    selectedStream: LIVE_STREAM,
    start: "fulfilled",
    wireStream: LIVE_STREAM,
  });
});

test("T0-02 Start is a one-wire reservation while stream_started is pending", { concurrency: false }, async () => {
  const observed = await withControlledWebSocket(async () => {
    const { source, socket } = await openLiveSession({ stream: LIVE_STREAM });
    const first = await actionOutcome(() => source.start());
    const afterFirst = sentControls(socket, "start_stream").length;
    const second = await actionOutcome(() => source.start());
    const afterSecond = sentControls(socket, "start_stream").length;
    await closeAndFinish(source, socket);
    return { first, second, afterFirst, afterSecond };
  });

  assert.deepEqual(observed, { first: "fulfilled", second: "rejected", afterFirst: 1, afterSecond: 1 });
});

test("T0-03 Stop is a one-wire reservation while stream_stopped is pending", { concurrency: false }, async () => {
  const observed = await withControlledWebSocket(async () => {
    const { adapter, source, socket } = await openLiveSession({ stream: LIVE_STREAM });
    assert.equal(await actionOutcome(() => source.start()), "fulfilled");
    socket.message(makeStartedText(17, LIVE_STREAM));
    assert.equal(adapter.controlState, "STREAMING");

    const first = await actionOutcome(() => source.stop());
    const afterFirst = sentControls(socket, "stop_stream").length;
    const second = await actionOutcome(() => source.stop());
    const afterSecond = sentControls(socket, "stop_stream").length;
    await closeAndFinish(source, socket);
    return { first, second, afterFirst, afterSecond };
  });

  assert.deepEqual(observed, { first: "fulfilled", second: "rejected", afterFirst: 1, afterSecond: 1 });
});

test("T0-04 adapter-rejected Start and Stop never reach the live wire", { concurrency: false }, async () => {
  const observed = await withControlledWebSocket(async () => {
    const { source, socket } = await openLiveSession({ stream: LIVE_STREAM, welcome: false });
    const prematureStart = await actionOutcome(() => source.start());
    const startsAfterPremature = sentControls(socket, "start_stream").length;

    socket.message(makeWelcomeText());
    const validStart = await actionOutcome(() => source.start());
    const startsAfterValid = sentControls(socket, "start_stream").length;
    const pendingStop = await actionOutcome(() => source.stop());
    const stopsAfterPending = sentControls(socket, "stop_stream").length;
    await closeAndFinish(source, socket);
    return { prematureStart, startsAfterPremature, validStart, startsAfterValid, pendingStop, stopsAfterPending };
  });

  assert.deepEqual(observed, {
    prematureStart: "rejected",
    startsAfterPremature: 0,
    validStart: "fulfilled",
    startsAfterValid: 1,
    pendingStop: "rejected",
    stopsAfterPending: 0,
  });
});

test("T0-05 rejected server stream_started never becomes the source stop target", { concurrency: false }, async () => {
  const observed = await withControlledWebSocket(async () => {
    const { adapter, source, socket, controlResults } = await openLiveSession({ stream: LIVE_STREAM });
    assert.equal(await actionOutcome(() => source.start()), "fulfilled");

    const duplicateKey = `{"type":"stream_started","stream":"${LIVE_STREAM}","profile":"vi-measurement","parameters":${JSON.stringify(DEFAULT_VI_PARAMETERS)},"stream_id":17,"stream_id":18}`;
    const parameterMismatch = JSON.stringify({
      type: "stream_started",
      stream: LIVE_STREAM,
      profile: "vi-measurement",
      parameters: { ...DEFAULT_VI_PARAMETERS, sample_rate: { numerator: 25, denominator: 1 } },
      stream_id: 19,
    });
    socket.message(duplicateKey);
    const sourceHasActiveStreamId = Object.hasOwn(source, "_activeStreamId");
    socket.message(parameterMismatch);
    const serverResults = controlResults.filter((entry) => entry.direction === "server_to_client").map((entry) => entry.accepted);
    const adapterState = adapter.controlState;
    const adapterActiveStreamId = adapter.summary().streamId;
    await closeAndFinish(source, socket);
    return {
      serverResults,
      adapterState,
      adapterActiveStreamId,
      sourceHasActiveStreamId,
    };
  });

  assert.deepEqual(observed, {
    serverResults: [true, false, false],
    adapterState: "READY",
    adapterActiveStreamId: null,
    sourceHasActiveStreamId: false,
  });
});

test("T0-06 a reconnect purges the old stream and keeps a sixty-second viewport", () => {
  const { model, adapter } = readyAdapter({ capacity: 64, displayWindowSeconds: 60 });
  startAdapterStream(adapter, 1);
  assert.equal(adapter.handleBinary(makeViFrame({ streamId: 1, sequence: 1n, timestampUs: 0n, flags: 0x01 })), true);
  assert.equal(adapter.handleBinary(makeViFrame({ streamId: 1, sequence: 2n, timestampUs: 10_000_000n })), true);
  stopAdapterStream(adapter, 1, 3n, 10_040_000n);

  startAdapterStream(adapter, 2);
  assert.equal(adapter.handleBinary(makeViFrame({ streamId: 2, sequence: 1n, timestampUs: 10_040_000n, flags: 0x01 })), true);
  assert.equal(adapter.handleBinary(makeViFrame({ streamId: 2, sequence: 2n, timestampUs: 80_000_000n })), true);

  const records = model.recordSnapshot();
  const markers = model.markerSnapshot();
  const timestamps = records.map((record) => record.timestamp_us);
  const spanUs = timestamps.length === 0 ? null : timestamps.at(-1) - timestamps[0];
  assert.deepEqual({
    recordStreamIds: [...new Set(records.map((record) => record.stream_id))],
    timestamps,
    markerStreamIds: [...new Set(markers.map((marker) => marker.stream_id))],
    markerTimestamps: markers.map((marker) => marker.timestamp_us),
    spanUs,
  }, {
    recordStreamIds: [2],
    timestamps: [80_000_000n],
    markerStreamIds: [],
    markerTimestamps: [],
    spanUs: 0n,
  });
});

test("T0-07 new-stream and TIMEBASE_RESET boundaries create disjoint viewport epochs", () => {
  const newStreamModel = new StreamModel({ capacity: 16, displayWindowSeconds: 60 });
  newStreamModel.beginStream({ streamId: 1, profile: "vi-measurement" });
  commitModelFrame(newStreamModel, { streamId: 1, sequence: 90n, timestampUs: 80_000_000n });
  newStreamModel.finishStream();
  newStreamModel.beginStream({ streamId: 2, profile: "vi-measurement" });
  commitModelFrame(newStreamModel, { streamId: 2, sequence: 1n, timestampUs: 1_000_000n });

  // The copied upstream parser correctly permits TIMEBASE_RESET only for a new
  // decoder session, so isolate the model epoch behavior with the decoded
  // candidate after recording that exact wire frame remains rejected in-session.
  const { adapter: parserAdapter } = readyAdapter();
  startAdapterStream(parserAdapter, 1);
  assert.equal(parserAdapter.handleBinary(makeViFrame({ streamId: 1, sequence: 90n, timestampUs: 80_000_000n, flags: 0x01 })), true);
  const exactTimebaseAccepted = parserAdapter.handleBinary(makeViFrame({ streamId: 1, sequence: 1n, timestampUs: 1_000_000n, flags: 0x45 }));
  const exactTimebaseError = parserAdapter.summary().lastError?.code ?? null;

  const resetModel = new StreamModel({ capacity: 16, displayWindowSeconds: 60 });
  resetModel.beginStream({ streamId: 1, profile: "vi-measurement" });
  commitModelFrame(resetModel, { streamId: 1, sequence: 90n, timestampUs: 80_000_000n });
  commitModelFrame(resetModel, { streamId: 1, sequence: 1n, timestampUs: 1_000_000n, flags: 0x45, timebaseReset: true });

  assert.equal(exactTimebaseAccepted, false);
  assert.equal(exactTimebaseError, "timebase_reset_requires_new_session");
  assert.deepEqual({ newStream: snapshotForEpoch(newStreamModel), sameStreamReset: snapshotForEpoch(resetModel) }, {
    newStream: {
      records: [{ streamId: 2, timestampUs: 1_000_000n }],
      markers: [{ streamId: 2, timestampUs: 1_000_000n, timebaseReset: false }],
    },
    sameStreamReset: {
      records: [{ streamId: 1, timestampUs: 1_000_000n }],
      markers: [{ streamId: 1, timestampUs: 1_000_000n, timebaseReset: true }],
    },
  });
});

test("T0-08 throwing a closed-status observer cannot strand close or reopen", { concurrency: false }, async () => {
  const observed = await withControlledWebSocket(async () => {
    const { source } = makeStandaloneLiveSource({ onStatus: (status) => {
      if (status.state === "closed") throw new Error("deliberate closed-status observer failure");
    } });
    const opening = source.open();
    const first = ControlledWebSocket.instances[0];
    first.open();
    await opening;

    const closing = source.close();
    try { first.finishClose(); } catch { /* the observer is deliberately hostile */ }
    const closeOutcome = await settledWithin(closing);
    const closingCleared = source._closing === null;

    const reopening = source.open();
    const second = ControlledWebSocket.instances.at(-1);
    if (second && second !== first) second.open();
    const reopenOutcome = await settledWithin(reopening);
    const reopened = second !== first && source.socket === second && source.state === "open";

    if (reopened) {
      source.onStatus(() => {});
      const finalClose = source.close();
      second.finishClose();
      await finalClose;
    }
    return { closeOutcome: closeOutcome.status, closingCleared, reopenOutcome: reopenOutcome.status, reopened };
  });

  assert.deepEqual(observed, {
    closeOutcome: "fulfilled",
    closingCleared: true,
    reopenOutcome: "fulfilled",
    reopened: true,
  });
});

test("lifecycle guard: close while CONNECTING settles opening and close", { concurrency: false }, async () => {
  await withControlledWebSocket(async () => {
    const { source } = makeStandaloneLiveSource();
    const opening = source.open();
    const socket = ControlledWebSocket.instances[0];
    const openingOutcome = settledWithin(opening);
    const closing = source.close();
    const closeOutcome = settledWithin(closing);
    socket.finishClose();
    assert.equal((await openingOutcome).status, "rejected");
    assert.equal((await closeOutcome).status, "fulfilled");
    assert.equal(source.socket, null);
    assert.equal(source._closing, null);
    assert.equal(source.state, "closed");
  });
});

test("lifecycle guard: error before open rejects and releases the owned socket", { concurrency: false }, async () => {
  await withControlledWebSocket(async () => {
    const errors = [];
    const { source } = makeStandaloneLiveSource({ onError: (error) => errors.push(error.message) });
    const opening = source.open();
    const socket = ControlledWebSocket.instances[0];
    const openingOutcome = settledWithin(opening);
    socket.error();
    const closing = source._closePromise;
    assert.ok(closing, "error before open did not initiate close");
    const closeOutcome = settledWithin(closing);
    socket.finishClose();
    assert.equal((await openingOutcome).status, "rejected");
    assert.equal((await closeOutcome).status, "fulfilled");
    assert.deepEqual(errors, ["WebSocket transport error"]);
    assert.equal(source.socket, null);
    assert.equal(source._opening, null);
    assert.equal(source._closing, null);
  });
});

test("lifecycle guard: synchronous constructor failure clears an opening attempt", { concurrency: false }, async () => {
  class ThrowingWebSocket {
    constructor() { throw new Error("mock constructor failure"); }
  }
  const { source } = makeStandaloneLiveSource();
  await withWebSocketClass(ThrowingWebSocket, async () => {
    assert.equal(await actionOutcome(() => source.open()), "rejected");
    assert.equal(source.socket, null);
    assert.equal(source._opening, null);
    assert.equal(source._openPromise, null);
    assert.equal(source.state, "closed");
  });
});

test("lifecycle guard: synchronous send failure rolls back the opening attempt", { concurrency: false }, async () => {
  await withControlledWebSocket(async () => {
    const { source } = makeStandaloneLiveSource();
    const opening = source.open();
    const socket = ControlledWebSocket.instances[0];
    socket.throwOnSend = new Error("mock send failure");
    const openingOutcome = settledWithin(opening);
    socket.open();
    const closing = source._closePromise;
    assert.ok(closing, "send failure did not initiate close");
    const closeOutcome = settledWithin(closing);
    socket.finishClose();
    assert.equal((await openingOutcome).status, "rejected");
    assert.equal((await closeOutcome).status, "fulfilled");
    assert.equal(source.socket, null);
    assert.equal(source._opening, null);
    assert.equal(source._closing, null);
  });
});

test("lifecycle guard: synchronous close failure clears only the close reservation", { concurrency: false }, async () => {
  await withControlledWebSocket(async () => {
    const { source } = makeStandaloneLiveSource();
    const opening = source.open();
    const socket = ControlledWebSocket.instances[0];
    socket.open();
    await opening;
    socket.throwOnClose = new Error("mock close failure");
    assert.equal(await actionOutcome(() => source.close()), "rejected");
    assert.equal(source.socket, socket);
    assert.equal(source._closing, null);
    assert.equal(source._closePromise, null);

    socket.throwOnClose = null;
    const closing = source.close();
    socket.finishClose();
    assert.equal((await settledWithin(closing)).status, "fulfilled");
    assert.equal(source.socket, null);
    assert.equal(source.state, "closed");
  });
});
