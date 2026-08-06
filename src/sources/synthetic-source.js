import { DataSource } from "./data-source.js";

export const DEFAULT_VI_PARAMETERS = Object.freeze({
  sample_format: "vi-f32le",
  channel_count: 2,
  channel_mask: 3,
  sample_rate: Object.freeze({ numerator: 0, denominator: 0 }),
});

const FRAME_TIMESTAMPED = 0x02;
const FRAME_STREAM_END = 0x10;
const FLAG_STREAM_START = 0x01;
const FLAG_STREAM_END = 0x02;
const FLAG_DISCONTINUITY = 0x04;
const FLAG_PRODUCER_OVERFLOW = 0x08;
const FLAG_OUTPUT_QUEUE_DROP = 0x10;
const SAMPLE_PERIOD_US = 40_000n; // 25 Hz, exactly 10 device seconds across 250 logical positions.
const SAMPLES_PER_SCENARIO = 250;

export const SYNTHETIC_SCENARIOS = Object.freeze([
  Object.freeze({ id: "stable", label: "S1 Stable — 3.3 V / 0.10 A" }),
  Object.freeze({ id: "step", label: "S2 Step response" }),
  Object.freeze({ id: "producer-gap", label: "S3 Sequence gap + producer overflow" }),
  Object.freeze({ id: "output-drop", label: "S4 Output queue drop" }),
  Object.freeze({ id: "validity", label: "S5 Validity phases" }),
  Object.freeze({ id: "reconnect", label: "S6 Reconnect: stream 1 → stream 2" }),
  Object.freeze({ id: "invalid-frame", label: "S7 Invalid frame rejected" }),
]);

function text(message) { return JSON.stringify(message); }

export function makeHelloText() {
  return text({ type: "hello", protocol: "d2b-stream", versions: ["0.1"], client_name: "d2b-viewer-prototype" });
}

export function makeWelcomeText() {
  return text({
    type: "welcome",
    protocol: "d2b-stream",
    version: "0.1",
    max_control_message_size: 2048,
    max_binary_frame_size: 65536,
    session_state: "ready",
    server_name: "synthetic-d2b-source",
  });
}

export function makeStartText(stream = "measurement-0") {
  return text({ type: "start_stream", stream, profile: "vi-measurement", parameters: DEFAULT_VI_PARAMETERS });
}

export function makeStartedText(streamId, stream = "measurement-0") {
  return text({ type: "stream_started", stream, profile: "vi-measurement", parameters: DEFAULT_VI_PARAMETERS, stream_id: streamId });
}

export function makeStoppedText(streamId, reason = "synthetic complete") {
  return text({ type: "stream_stopped", stream_id: streamId, reason });
}

export function makeStopText(streamId, reason = "viewer stop") {
  return text({ type: "stop_stream", stream_id: streamId, reason });
}

function requireUInt64(value, field) {
  if (typeof value !== "bigint" || value < 0n || value > 0xffffffffffffffffn) {
    throw new RangeError(`${field} must be uint64`);
  }
}

/** Creates one spec-valid 32-byte envelope plus a 16-byte V/I record. */
export function makeViFrame({ streamId, sequence, timestampUs, flags = 0, validMask = 3, voltage = 0, current = 0 }) {
  if (!Number.isSafeInteger(streamId) || streamId < 1 || streamId > 0xffffffff) throw new RangeError("invalid streamId");
  requireUInt64(sequence, "sequence");
  requireUInt64(timestampUs, "timestampUs");
  if (!Number.isSafeInteger(flags) || flags < 0 || flags > 0x7f) throw new RangeError("invalid flags");
  if (!Number.isSafeInteger(validMask) || validMask < 0 || validMask > 3) throw new RangeError("invalid validMask");
  if (!Number.isFinite(voltage) || !Number.isFinite(current)) throw new TypeError("synthetic numbers must be finite");
  const buffer = new ArrayBuffer(48);
  const bytes = new Uint8Array(buffer);
  bytes.set([0x44, 0x32, 0x42, 0x53, 0x00, 0x01, FRAME_TIMESTAMPED, flags]);
  const view = new DataView(buffer);
  view.setUint32(8, streamId, true);
  view.setUint32(12, 1, true);
  view.setBigUint64(16, sequence, true);
  view.setBigUint64(24, timestampUs, true);
  view.setUint32(32, 0, true);
  view.setUint32(36, validMask, true);
  view.setFloat32(40, voltage, true);
  view.setFloat32(44, current, true);
  return buffer;
}

export function makeStreamEndFrame({ streamId, sequence, timestampUs }) {
  if (!Number.isSafeInteger(streamId) || streamId < 1 || streamId > 0xffffffff) throw new RangeError("invalid streamId");
  requireUInt64(sequence, "sequence");
  requireUInt64(timestampUs, "timestampUs");
  const buffer = new ArrayBuffer(32);
  const bytes = new Uint8Array(buffer);
  bytes.set([0x44, 0x32, 0x42, 0x53, 0x00, 0x01, FRAME_STREAM_END, FLAG_STREAM_END]);
  const view = new DataView(buffer);
  view.setUint32(8, streamId, true);
  view.setUint32(12, 0, true);
  view.setBigUint64(16, sequence, true);
  view.setBigUint64(24, timestampUs, true);
  return buffer;
}

export function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBuffer(hex) {
  if (typeof hex !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new TypeError("invalid hex frame");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes.buffer;
}

function control(direction, controlText, delayMs = 0) {
  return Object.freeze({ kind: "control", direction, text: controlText, delayMs });
}

function binary(buffer, streamId, nextSequence, lastTimestampUs, delayMs = 0) {
  return Object.freeze({ kind: "binary", buffer, streamId, nextSequence, lastTimestampUs, delayMs });
}

function transport(state, delayMs = 0) {
  return Object.freeze({ kind: "transport", state, delayMs });
}

function appendStart(events, streamId, stream = "measurement-0") {
  events.push(control("client_to_server", makeStartText(stream)));
  events.push(control("server_to_client", makeStartedText(streamId, stream)));
}

function appendStop(events, streamId, nextSequence, timestampUs, reason = "synthetic complete") {
  events.push(binary(makeStreamEndFrame({ streamId, sequence: nextSequence, timestampUs }), streamId, nextSequence, timestampUs));
  events.push(control("server_to_client", makeStoppedText(streamId, reason)));
}

function valuesFor(scenario, sampleIndex) {
  const t = sampleIndex / 25;
  if (scenario === "stable" || scenario === "producer-gap" || scenario === "output-drop" || scenario === "invalid-frame" || scenario === "reconnect") {
    return { voltage: 3.3, current: 0.1, validMask: 3 };
  }
  if (scenario === "step") {
    if (t < 2) return { voltage: 0, current: 0, validMask: 3 };
    if (t < 7) return { voltage: 5, current: 0.2, validMask: 3 };
    return { voltage: 5, current: 0.08, validMask: 3 };
  }
  if (scenario === "validity") {
    if (t < 2.5) return { voltage: 0, current: 0.1, validMask: 2 };
    if (t < 5) return { voltage: 3.3, current: 0, validMask: 1 };
    if (t < 7.5) return { voltage: 0, current: 0, validMask: 0 };
    return { voltage: 3.3, current: 0.1, validMask: 3 };
  }
  throw new RangeError(`unknown synthetic scenario ${scenario}`);
}

function isOmittedLogicalPosition(scenario, sampleIndex) {
  return (scenario === "producer-gap" && sampleIndex >= 75 && sampleIndex < 80) ||
    (scenario === "output-drop" && sampleIndex >= 125 && sampleIndex < 128);
}

function appendData(events, { scenario, streamId, from = 0, count = SAMPLES_PER_SCENARIO, sequenceStart, timestampStartUs = 0n, previewFrameDelayMs = 4 }) {
  let lastTimestampUs = timestampStartUs;
  let delivered = 0;
  for (let logicalOffset = 0; logicalOffset < count; logicalOffset += 1) {
    const sampleIndex = from + logicalOffset;
    if (isOmittedLogicalPosition(scenario, sampleIndex)) continue;
    const timestampUs = timestampStartUs + BigInt(logicalOffset) * SAMPLE_PERIOD_US;
    const sequence = sequenceStart + BigInt(logicalOffset);
    let flags = delivered === 0 ? FLAG_STREAM_START : 0;
    // The first record after each omission has advanced sequence *and* device
    // time. No missing logical position is generated or compressed.
    if (scenario === "producer-gap" && sampleIndex === 80) {
      flags |= FLAG_DISCONTINUITY | FLAG_PRODUCER_OVERFLOW;
    }
    if (scenario === "output-drop" && sampleIndex === 128) {
      flags |= FLAG_DISCONTINUITY | FLAG_OUTPUT_QUEUE_DROP;
    }
    const value = valuesFor(scenario, sampleIndex);
    const frame = makeViFrame({ streamId, sequence, timestampUs, flags, ...value });
    // S7 inserts a bad duplicate before the valid sample, leaving the valid
    // sequence untouched so a rejection cannot cause a fabricated gap.
    if (scenario === "invalid-frame" && sampleIndex === 75) {
      const invalid = frame.slice(0);
      new Uint8Array(invalid)[0] = 0x58;
      events.push(binary(invalid, streamId, sequence, lastTimestampUs, previewFrameDelayMs));
    }
    events.push(binary(frame, streamId, sequence + 1n, timestampUs, delivered === 0 ? 0 : previewFrameDelayMs));
    lastTimestampUs = timestampUs;
    delivered += 1;
  }
  return {
    nextSequence: sequenceStart + BigInt(count),
    lastTimestampUs,
    nextTimestampUs: timestampStartUs + BigInt(count) * SAMPLE_PERIOD_US,
  };
}

/** Build only a small deterministic preview plan; every data event is reference-valid. */
export function buildSyntheticPlan(scenario = "stable", previewFrameDelayMs = 4) {
  if (!SYNTHETIC_SCENARIOS.some((item) => item.id === scenario)) throw new RangeError(`unknown scenario ${scenario}`);
  const events = [];
  const baseSequence = 9_007_199_254_742_000n;
  if (scenario !== "reconnect") {
    appendStart(events, 1);
    const state = appendData(events, { scenario, streamId: 1, sequenceStart: baseSequence, previewFrameDelayMs });
    appendStop(events, 1, state.nextSequence, state.nextTimestampUs);
    return events;
  }

  appendStart(events, 1, "measurement-0");
  const first = appendData(events, {
    scenario,
    streamId: 1,
    from: 0,
    count: SAMPLES_PER_SCENARIO / 2,
    sequenceStart: baseSequence,
    timestampStartUs: 0n,
    previewFrameDelayMs,
  });
  appendStop(events, 1, first.nextSequence, first.nextTimestampUs, "first session complete");
  events.push(transport("closed"));
  events.push(transport("open"));
  events.push(control("client_to_server", makeHelloText()));
  events.push(control("server_to_client", makeWelcomeText()));
  appendStart(events, 2, "measurement-0");
  const second = appendData(events, {
    scenario,
    streamId: 2,
    from: SAMPLES_PER_SCENARIO / 2,
    count: SAMPLES_PER_SCENARIO / 2,
    sequenceStart: baseSequence + 1000n,
    timestampStartUs: BigInt(SAMPLES_PER_SCENARIO / 2) * SAMPLE_PERIOD_US,
    previewFrameDelayMs,
  });
  appendStop(events, 2, second.nextSequence, second.nextTimestampUs, "second session complete");
  return events;
}

/**
 * A fast deterministic source. One wall-clock tick is normally 4 ms (10x faster
 * than 25 Hz), while the 40 ms device timestamps remain authoritative.
 */
export class SyntheticSource extends DataSource {
  constructor({ scenario = "stable", speed = 1 } = {}) {
    super("synthetic");
    this.scenario = scenario;
    this.speed = speed;
    this._events = [];
    this._cursor = 0;
    this._timer = null;
    this._running = false;
    this._activeStreamId = null;
    this._activeNextSequence = 0n;
    this._activeLastTimestampUs = 0n;
  }

  setScenario(scenario) {
    if (this._running) throw new Error("stop synthetic replay before changing its scenario");
    if (!SYNTHETIC_SCENARIOS.some((item) => item.id === scenario)) throw new RangeError("unknown synthetic scenario");
    this.scenario = scenario;
  }

  setSpeed(speed) {
    if (![0.25, 1, 2, "fast"].includes(speed)) throw new RangeError("synthetic speed must be 0.25, 1, 2, or fast");
    this.speed = speed;
  }

  async open() {
    if (this.state === "open") return;
    this._emitStatus("open");
    this._emitControl("client_to_server", makeHelloText());
    this._emitControl("server_to_client", makeWelcomeText());
  }

  async start() {
    if (this._running) return;
    if (this.state !== "open") throw new Error("open the synthetic source first");
    this._events = buildSyntheticPlan(this.scenario);
    this._cursor = 0;
    this._running = true;
    this._runNext();
  }

  async stop() {
    if (!this._running) return;
    this._running = false;
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = null;
    this._events = [];
    if (this._activeStreamId !== null) {
      this._emitControl("client_to_server", makeStopText(this._activeStreamId));
      this._emitBinary(makeStreamEndFrame({
        streamId: this._activeStreamId,
        sequence: this._activeNextSequence,
        timestampUs: this._activeLastTimestampUs + SAMPLE_PERIOD_US,
      }));
      this._emitControl("server_to_client", makeStoppedText(this._activeStreamId, "viewer stop"));
      this._activeStreamId = null;
    }
    this._emitStatus("stopped", "synthetic playback stopped");
  }

  async close() {
    if (this.state === "closed") return;
    if (this._running) await this.stop();
    this._events = [];
    this._emitStatus("closed");
  }

  _runNext() {
    if (!this._running) return;
    if (this._cursor >= this._events.length) {
      this._running = false;
      this._events = [];
      return;
    }
    const event = this._events[this._cursor++];
    this._dispatch(event);
    if (!this._running) return;
    const delay = this.speed === "fast" ? 0 : Math.max(0, Math.round(event.delayMs / this.speed));
    this._timer = setTimeout(() => this._runNext(), delay);
  }

  _dispatch(event) {
    if (event.kind === "control") {
      this._emitControl(event.direction, event.text);
      const message = JSON.parse(event.text);
      if (event.direction === "server_to_client" && message.type === "stream_started") this._activeStreamId = message.stream_id;
      if (event.direction === "server_to_client" && message.type === "stream_stopped") this._activeStreamId = null;
    } else if (event.kind === "binary") {
      this._activeStreamId = event.streamId;
      this._activeNextSequence = event.nextSequence;
      this._activeLastTimestampUs = event.lastTimestampUs;
      this._emitBinary(event.buffer);
    } else if (event.kind === "transport") {
      this._emitStatus(event.state, event.state === "closed" ? "synthetic reconnect boundary" : undefined);
    }
  }
}
