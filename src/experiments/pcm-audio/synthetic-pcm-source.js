import { DataSource } from "../../sources/data-source.js";
import { PCM_PARAMETERS } from "../../protocol/d2b-reference/protocol-constants.js";

/**
 * Synthetic pcm-audio frame generator and DataSource. Produces real,
 * spec-correct 544-byte d2b-stream/0.1 pcm-audio binary frames (a 32-byte
 * envelope plus a 512-byte PCM16LE payload for the fixed 256-sample-per-frame
 * reference parameter set) so they can be fed through the actual, unmodified
 * copied reference decoder in src/protocol/d2b-reference/. Nothing here
 * decodes its own output: this module only encodes bytes on the wire.
 */

const ENVELOPE_SIZE = 32;
const SAMPLES_PER_FRAME = PCM_PARAMETERS.samples_per_frame; // 256
const SAMPLE_RATE_NUMERATOR = BigInt(PCM_PARAMETERS.sample_rate.numerator); // 16000
const SAMPLE_RATE_DENOMINATOR = BigInt(PCM_PARAMETERS.sample_rate.denominator); // 1
const PAYLOAD_SIZE = SAMPLES_PER_FRAME * PCM_PARAMETERS.channel_count * 2; // 512
const FRAME_SIZE = ENVELOPE_SIZE + PAYLOAD_SIZE; // 544

const FRAME_FIXED_RATE = 0x01;
const FRAME_STREAM_END = 0x10;

const FLAG_STREAM_START = 0x01;
const FLAG_STREAM_END = 0x02;
const FLAG_DISCONTINUITY = 0x04;
const FLAG_PRODUCER_OVERFLOW = 0x08;
const FLAG_OUTPUT_QUEUE_DROP = 0x10;
const FLAG_SOURCE_PAUSED = 0x20;
const FLAG_TIMEBASE_RESET = 0x40;

export const PCM_SYNTHETIC_SCENARIOS = Object.freeze([
  Object.freeze({ id: "a1-sine-440", label: "A1 440 Hz sine" }),
  Object.freeze({ id: "a2-sine-880", label: "A2 880 Hz sine" }),
  Object.freeze({ id: "a3-harmonics-440", label: "A3 440 Hz + harmonics" }),
  Object.freeze({ id: "a4-amplitude-step", label: "A4 440 Hz, mid-stream amplitude step" }),
  Object.freeze({ id: "a5-gap-discontinuity", label: "A5 Sequence gap + DISCONTINUITY" }),
  Object.freeze({ id: "a6-producer-overflow", label: "A6 Gap + PRODUCER_OVERFLOW" }),
  Object.freeze({ id: "a7-output-queue-drop", label: "A7 Gap + OUTPUT_QUEUE_DROP" }),
  Object.freeze({ id: "a8-reconnect", label: "A8 Stop/close, then reconnect (new stream)" }),
  Object.freeze({ id: "a9-timebase-reset", label: "A9 TIMEBASE_RESET (new epoch)" }),
  Object.freeze({ id: "a10-invalid-frame", label: "A10 Malformed frame rejected" }),
]);

function text(message) { return JSON.stringify(message); }

export function makeHelloText() {
  return text({ type: "hello", protocol: "d2b-stream", versions: ["0.1"], client_name: "d2b-pcm-audio-spike" });
}

export function makeWelcomeText() {
  return text({
    type: "welcome",
    protocol: "d2b-stream",
    version: "0.1",
    max_control_message_size: 2048,
    max_binary_frame_size: 65536,
    session_state: "ready",
    server_name: "synthetic-pcm-source",
  });
}

export function makeStartText(stream = "audio-0") {
  return text({ type: "start_stream", stream, profile: "pcm-audio", parameters: PCM_PARAMETERS });
}

export function makeStartedText(streamId, stream = "audio-0") {
  return text({ type: "stream_started", stream, profile: "pcm-audio", parameters: PCM_PARAMETERS, stream_id: streamId });
}

export function makeStopText(streamId, reason = "viewer stop") {
  return text({ type: "stop_stream", stream_id: streamId, reason });
}

export function makeStoppedText(streamId, reason = "synthetic complete") {
  return text({ type: "stream_stopped", stream_id: streamId, reason });
}

function requireUint64(value, field) {
  if (typeof value !== "bigint" || value < 0n || value > 0xffffffffffffffffn) {
    throw new RangeError(`${field} must be a uint64 BigInt`);
  }
}

/**
 * Exact anchor-relative PCM timestamp per docs/profiles/pcm-audio-v0.1.md §3:
 *   anchor_timestamp_us + (s - anchor_sequence) * denominator * 1e6 / numerator
 * computed with BigInt-only arithmetic (floor division) so it lands within
 * the reference decoder's one-numerator-unit tolerance without ever routing
 * through floating point.
 */
export function pcmTimestampForSequence(anchorSequence, anchorTimestampUs, sequence) {
  requireUint64(anchorSequence, "anchorSequence");
  requireUint64(anchorTimestampUs, "anchorTimestampUs");
  requireUint64(sequence, "sequence");
  if (sequence < anchorSequence) throw new RangeError("sequence precedes anchor");
  const deltaSequence = sequence - anchorSequence;
  const deltaUs = (deltaSequence * SAMPLE_RATE_DENOMINATOR * 1_000_000n) / SAMPLE_RATE_NUMERATOR;
  return anchorTimestampUs + deltaUs;
}

/** Signed 16-bit sine wave, exact integer rounding, no clipping at unit amplitude. */
export function generateSineSamples({ frequencyHz, count = SAMPLES_PER_FRAME, startSampleIndex = 0, amplitude = 0.6, sampleRateHz = 16000, phase = 0 }) {
  const samples = new Int16Array(count);
  for (let index = 0; index < count; index += 1) {
    const t = (startSampleIndex + index) / sampleRateHz;
    const value = amplitude * Math.sin(2 * Math.PI * frequencyHz * t + phase);
    samples[index] = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
  }
  return samples;
}

/** Fundamental plus a small set of harmonic partials at decaying amplitude. */
export function generateHarmonicSamples({ fundamentalHz, harmonics = [2, 3], harmonicGain = 0.35, count = SAMPLES_PER_FRAME, startSampleIndex = 0, amplitude = 0.5, sampleRateHz = 16000 }) {
  const samples = new Int16Array(count);
  for (let index = 0; index < count; index += 1) {
    const t = (startSampleIndex + index) / sampleRateHz;
    let value = Math.sin(2 * Math.PI * fundamentalHz * t);
    let weight = 1;
    let gain = harmonicGain;
    for (const harmonic of harmonics) {
      value += gain * Math.sin(2 * Math.PI * fundamentalHz * harmonic * t);
      weight += gain;
      gain *= harmonicGain;
    }
    const normalized = (value / weight) * amplitude;
    samples[index] = Math.max(-32768, Math.min(32767, Math.round(normalized * 32767)));
  }
  return samples;
}

/** Builds one spec-valid 544-byte pcm-audio FIXED_RATE_SAMPLES frame. */
export function makePcmFrame({ streamId, sequence, timestampUs, flags = 0, samples }) {
  if (!Number.isSafeInteger(streamId) || streamId < 1 || streamId > 0xffffffff) throw new RangeError("invalid streamId");
  requireUint64(sequence, "sequence");
  requireUint64(timestampUs, "timestampUs");
  if (!Number.isSafeInteger(flags) || flags < 0 || flags > 0x7f) throw new RangeError("invalid flags");
  if (!(samples instanceof Int16Array) || samples.length !== SAMPLES_PER_FRAME) {
    throw new TypeError(`samples must be an Int16Array of exactly ${SAMPLES_PER_FRAME} entries`);
  }
  const buffer = new ArrayBuffer(FRAME_SIZE);
  const bytes = new Uint8Array(buffer);
  bytes.set([0x44, 0x32, 0x42, 0x53, 0x00, 0x01, FRAME_FIXED_RATE, flags]); // "D2BS", proto 0.1
  const view = new DataView(buffer);
  view.setUint32(8, streamId, true);
  view.setUint32(12, SAMPLES_PER_FRAME, true);
  view.setBigUint64(16, sequence, true);
  view.setBigUint64(24, timestampUs, true);
  for (let index = 0; index < SAMPLES_PER_FRAME; index += 1) {
    view.setInt16(ENVELOPE_SIZE + index * 2, samples[index], true);
  }
  return buffer;
}

export function makeStreamEndFrame({ streamId, sequence, timestampUs }) {
  if (!Number.isSafeInteger(streamId) || streamId < 1 || streamId > 0xffffffff) throw new RangeError("invalid streamId");
  requireUint64(sequence, "sequence");
  requireUint64(timestampUs, "timestampUs");
  const buffer = new ArrayBuffer(ENVELOPE_SIZE);
  const bytes = new Uint8Array(buffer);
  bytes.set([0x44, 0x32, 0x42, 0x53, 0x00, 0x01, FRAME_STREAM_END, FLAG_STREAM_END]);
  const view = new DataView(buffer);
  view.setUint32(8, streamId, true);
  view.setUint32(12, 0, true);
  view.setBigUint64(16, sequence, true);
  view.setBigUint64(24, timestampUs, true);
  return buffer;
}

/**
 * A10 malformed-frame builders. Each returns bytes the reference decoder
 * MUST reject at (or before) profile decode: bad magic fails envelope
 * parsing, a wrong sample_count fails pcm_sample_count_mismatch, and a
 * truncated payload fails pcm_payload_length_mismatch.
 */
export function makeBadMagicFrame(validFrameArgs) {
  const buffer = makePcmFrame(validFrameArgs).slice(0);
  new Uint8Array(buffer)[0] = 0x58; // 'D' -> 'X'
  return buffer;
}

export function makeWrongSampleCountFrame({ streamId, sequence, timestampUs, flags = 0, samples }) {
  const buffer = makePcmFrame({ streamId, sequence, timestampUs, flags, samples }).slice(0);
  new DataView(buffer).setUint32(12, SAMPLES_PER_FRAME - 1, true); // envelope claims 255, payload still 512 bytes
  return buffer;
}

export function makeTruncatedPayloadFrame({ streamId, sequence, timestampUs, flags = 0, samples }) {
  const full = makePcmFrame({ streamId, sequence, timestampUs, flags, samples });
  return full.slice(0, ENVELOPE_SIZE + PAYLOAD_SIZE - 64); // short by 64 bytes
}

export function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function control(direction, controlText, delayMs = 0) {
  return Object.freeze({ kind: "control", direction, text: controlText, delayMs });
}

function binary(buffer, streamId, delayMs = 0) {
  return Object.freeze({ kind: "binary", buffer, streamId, delayMs });
}

function transport(state, delayMs = 0) {
  return Object.freeze({ kind: "transport", state, delayMs });
}

function appendStart(events, streamId, stream = "audio-0") {
  events.push(control("client_to_server", makeStartText(stream)));
  events.push(control("server_to_client", makeStartedText(streamId, stream)));
}

function appendStop(events, streamId, nextSequence, timestampUs, reason = "synthetic complete") {
  events.push(binary(makeStreamEndFrame({ streamId, sequence: nextSequence, timestampUs }), streamId));
  events.push(control("server_to_client", makeStoppedText(streamId, reason)));
}

function waveformFor(scenarioId, frameIndex, startSampleIndex) {
  if (scenarioId === "a1-sine-440" || scenarioId === "a5-gap-discontinuity" || scenarioId === "a6-producer-overflow" ||
      scenarioId === "a7-output-queue-drop" || scenarioId === "a10-invalid-frame") {
    return generateSineSamples({ frequencyHz: 440, startSampleIndex });
  }
  if (scenarioId === "a2-sine-880") return generateSineSamples({ frequencyHz: 880, startSampleIndex });
  if (scenarioId === "a3-harmonics-440") return generateHarmonicSamples({ fundamentalHz: 440, startSampleIndex });
  if (scenarioId === "a4-amplitude-step") {
    const amplitude = frameIndex < 15 ? 0.25 : 0.75;
    return generateSineSamples({ frequencyHz: 440, startSampleIndex, amplitude });
  }
  if (scenarioId === "a8-reconnect" || scenarioId === "a9-timebase-reset") {
    return generateSineSamples({ frequencyHz: 440, startSampleIndex });
  }
  throw new RangeError(`unknown pcm scenario ${scenarioId}`);
}

/**
 * Appends `frameCount` contiguous data frames (with optional single mid-run
 * gap of `gapFrames` frames at `gapAtFrame`) for one stream/session, honoring
 * the anchor-relative timestamp formula exactly. `frameDelayMs` paces the
 * synthetic wall-clock schedule only; device sequence/timestamp are
 * independent of it.
 */
function appendData(events, {
  scenarioId, streamId, frameCount, anchorSequence, anchorTimestampUs,
  gapAtFrame = -1, gapFrames = 0, gapFlags = 0, frameDelayMs = 8,
}) {
  let sequence = anchorSequence;
  let deliveredFrame = 0;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    if (frameIndex === gapAtFrame) sequence += BigInt(gapFrames) * BigInt(SAMPLES_PER_FRAME);
    const timestampUs = pcmTimestampForSequence(anchorSequence, anchorTimestampUs, sequence);
    const samples = waveformFor(scenarioId, frameIndex, Number(sequence - anchorSequence));
    let flags = deliveredFrame === 0 ? FLAG_STREAM_START : 0;
    if (frameIndex === gapAtFrame) flags |= gapFlags;
    const frame = makePcmFrame({ streamId, sequence, timestampUs, flags, samples });

    if (scenarioId === "a10-invalid-frame" && frameIndex === 5) {
      const invalid = makeBadMagicFrame({ streamId, sequence, timestampUs, flags: 0, samples });
      events.push(binary(invalid, streamId, frameDelayMs));
    }

    events.push(binary(frame, streamId, deliveredFrame === 0 ? 0 : frameDelayMs));
    sequence += BigInt(SAMPLES_PER_FRAME);
    deliveredFrame += 1;
  }
  return { nextSequence: sequence, lastTimestampUs: pcmTimestampForSequence(anchorSequence, anchorTimestampUs, sequence) };
}

/** Build a small deterministic preview plan; every plain data event is reference-valid except A10's injected duplicate. */
export function buildPcmScenarioPlan(scenarioId = "a1-sine-440") {
  if (!PCM_SYNTHETIC_SCENARIOS.some((item) => item.id === scenarioId)) throw new RangeError(`unknown pcm scenario ${scenarioId}`);
  const events = [];
  const baseAnchorUs = 5_000_000n;

  if (scenarioId === "a8-reconnect") {
    appendStart(events, 1, "audio-0");
    const first = appendData(events, { scenarioId, streamId: 1, frameCount: 10, anchorSequence: 0n, anchorTimestampUs: baseAnchorUs });
    appendStop(events, 1, first.nextSequence, first.lastTimestampUs, "first session complete");
    events.push(transport("closed"));
    events.push(transport("open"));
    events.push(control("client_to_server", makeHelloText()));
    events.push(control("server_to_client", makeWelcomeText()));
    appendStart(events, 2, "audio-0");
    const second = appendData(events, { scenarioId, streamId: 2, frameCount: 10, anchorSequence: 0n, anchorTimestampUs: baseAnchorUs + 1_000_000n });
    appendStop(events, 2, second.nextSequence, second.lastTimestampUs, "second session complete");
    return events;
  }

  if (scenarioId === "a9-timebase-reset") {
    appendStart(events, 1, "audio-0");
    const first = appendData(events, { scenarioId, streamId: 1, frameCount: 6, anchorSequence: 0n, anchorTimestampUs: baseAnchorUs });
    appendStop(events, 1, first.nextSequence, first.lastTimestampUs, "pre-reset session complete");
    // A device clock/timebase discontinuity: end the old stream and start a
    // fresh one on the same transport (no reconnect needed) carrying
    // TIMEBASE_RESET on its first frame, per docs/profiles/pcm-audio-v0.1.md
    // §3 ("the sender MUST end the old stream and start a new stream ID
    // rather than estimate the gap"). The new anchor timestamp intentionally
    // does not relate to the old stream's device time.
    appendStart(events, 2, "audio-0");
    const second = appendData(events, {
      scenarioId, streamId: 2, frameCount: 6, anchorSequence: 0n, anchorTimestampUs: baseAnchorUs + 9_000_000n,
      gapAtFrame: 0, gapFrames: 0, gapFlags: FLAG_STREAM_START | FLAG_DISCONTINUITY | FLAG_TIMEBASE_RESET,
    });
    appendStop(events, 2, second.nextSequence, second.lastTimestampUs, "post-reset session complete");
    return events;
  }

  const streamId = 1;
  appendStart(events, streamId, "audio-0");
  let dataOptions = { scenarioId, streamId, frameCount: 20, anchorSequence: 0n, anchorTimestampUs: baseAnchorUs };
  if (scenarioId === "a5-gap-discontinuity") {
    dataOptions = { ...dataOptions, gapAtFrame: 10, gapFrames: 3, gapFlags: FLAG_DISCONTINUITY };
  } else if (scenarioId === "a6-producer-overflow") {
    dataOptions = { ...dataOptions, gapAtFrame: 10, gapFrames: 4, gapFlags: FLAG_DISCONTINUITY | FLAG_PRODUCER_OVERFLOW };
  } else if (scenarioId === "a7-output-queue-drop") {
    dataOptions = { ...dataOptions, gapAtFrame: 10, gapFrames: 2, gapFlags: FLAG_DISCONTINUITY | FLAG_OUTPUT_QUEUE_DROP };
  }
  const state = appendData(events, dataOptions);
  appendStop(events, streamId, state.nextSequence, state.lastTimestampUs);
  return events;
}

/**
 * A fast deterministic pcm-audio source, structurally parallel to
 * ../../sources/synthetic-source.js's SyntheticSource but for pcm-audio.
 */
export class SyntheticPcmSource extends DataSource {
  constructor({ scenario = "a1-sine-440", speed = 1 } = {}) {
    super("synthetic-pcm");
    this.scenario = scenario;
    this.speed = speed;
    this._events = [];
    this._cursor = 0;
    this._timer = null;
    this._running = false;
    this._activeStreamId = null;
  }

  setScenario(scenario) {
    if (this._running) throw new Error("stop synthetic pcm replay before changing its scenario");
    if (!PCM_SYNTHETIC_SCENARIOS.some((item) => item.id === scenario)) throw new RangeError("unknown pcm scenario");
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
    if (this.state !== "open") throw new Error("open the synthetic pcm source first");
    this._events = buildPcmScenarioPlan(this.scenario);
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
    this._activeStreamId = null;
    this._emitStatus("stopped", "synthetic pcm playback stopped");
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
      this._emitBinary(event.buffer);
    } else if (event.kind === "transport") {
      this._emitStatus(event.state, event.state === "closed" ? "synthetic reconnect boundary" : undefined);
    }
  }
}

export { SAMPLES_PER_FRAME, FRAME_SIZE, ENVELOPE_SIZE, PAYLOAD_SIZE };
