import { validateCapabilities } from "../protocol/d2b-reference/capabilities-validator.js";
import { parseControlMessageText } from "../protocol/d2b-reference/control-parser.js";
import { createDecoderState } from "../protocol/d2b-reference/decoder-state.js";
import { decodeBinaryFrame } from "../protocol/d2b-reference/decoder.js";
import { parseControlText } from "../protocol/d2b-reference/strict-json.js";
import { DataSource } from "./data-source.js";
import { hexToBuffer } from "./synthetic-source.js";

export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
export const MAX_CAPTURE_EVENTS = 100_000;

const FORMAT = "vameter-d2b-live-capture/0.1";
const CAPTURE_FIELDS = [
  "format", "captured_at", "user_agent", "device_base_url", "duration_seconds",
  "capabilities_text", "status_before_text", "controls", "frames", "status_after_text",
];
const CONTROL_FIELDS = ["event_index", "received_ms", "direction", "text"];
const FRAME_FIELDS = ["event_index", "received_ms", "hex"];
const PUBLIC_STATUS_FIELDS = [
  "protocol", "version", "state", "connected_client_count", "producer_drop_count",
  "output_queue_drop_count", "queued_sample_count", "uptime_us",
];
const EXPECTED_CONTROLS = Object.freeze([
  Object.freeze({ direction: "client_to_server", type: "hello" }),
  Object.freeze({ direction: "server_to_client", type: "welcome" }),
  Object.freeze({ direction: "client_to_server", type: "start_stream" }),
  Object.freeze({ direction: "server_to_client", type: "stream_started" }),
  Object.freeze({ direction: "client_to_server", type: "stop_stream" }),
  Object.freeze({ direction: "server_to_client", type: "stream_stopped" }),
]);

function exactFields(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(label + " must be an object");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    throw new TypeError(label + " fields must be exactly " + wanted.join(", "));
  }
}

function nonNegativeUint(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(field + " must be a nonnegative safe integer");
  return value;
}

function finiteNonNegativeNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(field + " must be a finite nonnegative number");
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
}

function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }

function parseBoundedWireJson(text, label) {
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > 2048) {
    throw new TypeError(label + " must be bounded UTF-8 JSON text");
  }
  try {
    // The copied strict parser rejects duplicate keys and invalid JSON syntax.
    return parseControlText(text).root.value;
  } catch (error) {
    throw new TypeError(label + " is invalid JSON: " + (error?.message || "unknown error"));
  }
}

function validatePublicStatus(value, label) {
  exactFields(value, PUBLIC_STATUS_FIELDS, label);
  if (value.protocol !== "d2b-stream" || value.version !== "0.1" ||
      (value.state !== "idle" && value.state !== "streaming")) {
    throw new TypeError(label + " has an invalid protocol/version/state");
  }
  for (const field of PUBLIC_STATUS_FIELDS) {
    if (field === "protocol" || field === "version" || field === "state") continue;
    nonNegativeUint(value[field], label + "." + field);
  }
  return value;
}

function validateCaptureMetadata(root) {
  exactFields(root, CAPTURE_FIELDS, "capture");
  if (root.format !== FORMAT) throw new TypeError("unsupported capture format");
  for (const field of ["captured_at", "user_agent", "device_base_url"]) {
    if (typeof root[field] !== "string" || root[field].length === 0) throw new TypeError("capture." + field + " must be nonempty");
  }
  if (!root.device_base_url.startsWith("http://") || !root.device_base_url.endsWith("/d2b/v0/")) {
    throw new TypeError("capture.device_base_url must be a device http://.../d2b/v0/ URL");
  }
  const durationSeconds = root.duration_seconds;
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds < 5 || durationSeconds > 1800) {
    throw new TypeError("capture.duration_seconds must be finite and between 5 and 1800");
  }
  const capabilities = validateCapabilities(parseBoundedWireJson(root.capabilities_text, "capabilities_text"));
  if (capabilities.maximum_binary_frame_size !== 48) {
    throw new TypeError("VAMeter capture must advertise exactly 48-byte V/I frames");
  }
  const before = validatePublicStatus(parseBoundedWireJson(root.status_before_text, "status_before_text"), "status_before");
  const after = validatePublicStatus(parseBoundedWireJson(root.status_after_text, "status_after_text"), "status_after");
  if (before.state !== "idle" || before.connected_client_count !== 0) {
    throw new TypeError("capture must begin idle without a stream owner");
  }
  if (after.state !== "idle" || after.connected_client_count !== 1 || after.queued_sample_count !== 0) {
    throw new TypeError("capture must end idle, drained, with its control owner connected");
  }
  if (after.uptime_us < before.uptime_us ||
      after.producer_drop_count < before.producer_drop_count ||
      after.output_queue_drop_count < before.output_queue_drop_count) {
    throw new TypeError("capture public counters or uptime regressed");
  }
  if (!Array.isArray(root.controls) || !Array.isArray(root.frames) || root.frames.length === 0) {
    throw new TypeError("capture controls and nonempty frames arrays are required");
  }
  return Object.freeze({ maximumBinaryFrameSize: capabilities.maximum_binary_frame_size });
}

function validateLifecycle(events, metadata) {
  let state = "CLOSED";
  let controlIndex = 0;
  let welcome = null;
  let pendingStart = null;
  let active = null;
  let decoderState = null;
  let stopSeen = false;
  let streamEndSeen = false;
  let dataFrames = 0;

  for (const event of events) {
    if (event.kind === "control") {
      const context = event.direction === "client_to_server"
        ? { state: state === "CLOSED" ? "CONNECTED" : state, owns_stream: state === "STREAMING" && active !== null }
        : undefined;
      const message = parseControlMessageText(event.text, event.direction, context);
      const expected = EXPECTED_CONTROLS[controlIndex];
      if (!expected || expected.direction !== event.direction || expected.type !== message.type) {
        throw new TypeError("capture controls must be hello, welcome, start_stream, stream_started, stop_stream, stream_stopped");
      }
      controlIndex += 1;

      if (message.type === "hello") {
        if (state !== "CLOSED") throw new TypeError("capture hello is out of order");
        state = "CONNECTED";
      } else if (message.type === "welcome") {
        if (state !== "CONNECTED" || message.max_binary_frame_size !== metadata.maximumBinaryFrameSize) {
          throw new TypeError("capture welcome is out of order or disagrees with capabilities");
        }
        welcome = cloneJson(message);
        state = "READY";
      } else if (message.type === "start_stream") {
        if (state !== "READY" || !welcome || message.stream !== "live-vi" || message.profile !== "vi-measurement") {
          throw new TypeError("capture start_stream is out of order or not the VAMeter live V/I request");
        }
        pendingStart = cloneJson(message);
      } else if (message.type === "stream_started") {
        if (state !== "READY" || !pendingStart || !welcome || message.stream !== pendingStart.stream ||
            message.profile !== pendingStart.profile || canonicalJson(message.parameters) !== canonicalJson(pendingStart.parameters)) {
          throw new TypeError("capture stream_started does not match start_stream");
        }
        decoderState = createDecoderState({
          negotiated_version: welcome.version,
          session_state: "STREAMING",
          maximum_binary_frame_size: welcome.max_binary_frame_size,
          stream_id: message.stream_id,
          profile: message.profile,
          parameters: pendingStart.parameters,
        });
        active = { streamId: message.stream_id };
        pendingStart = null;
        state = "STREAMING";
      } else if (message.type === "stop_stream") {
        if (state !== "STREAMING" || !active || stopSeen || !Object.hasOwn(message, "stream_id") ||
            message.stream_id !== active.streamId) {
          throw new TypeError("capture stop_stream is out of order or targets the wrong stream");
        }
        stopSeen = true;
      } else if (message.type === "stream_stopped") {
        if (state !== "STREAMING" || !active || !stopSeen || !streamEndSeen || message.stream_id !== active.streamId) {
          throw new TypeError("capture stream_stopped must follow stop_stream and STREAM_END for the active stream");
        }
        active = null;
        decoderState = null;
        state = "READY";
      }
      continue;
    }

    if (state !== "STREAMING" || !active || !decoderState || event.buffer.byteLength > metadata.maximumBinaryFrameSize) {
      throw new TypeError("capture binary is outside the negotiated streaming lifecycle");
    }
    const candidate = decodeBinaryFrame(event.buffer, decoderState);
    if (candidate.decoded.stream_end) {
      if (!stopSeen || streamEndSeen || event.buffer.byteLength !== 32) {
        throw new TypeError("capture STREAM_END must occur once after stop_stream");
      }
      streamEndSeen = true;
    } else {
      if (streamEndSeen || event.buffer.byteLength !== 48 || candidate.decoded.sample_count !== 1) {
        throw new TypeError("capture data must be one 48-byte V/I record before STREAM_END");
      }
      dataFrames += 1;
    }
    decoderState = candidate.nextState;
  }

  if (controlIndex !== EXPECTED_CONTROLS.length || state !== "READY" || !stopSeen || !streamEndSeen || dataFrames < 1) {
    throw new TypeError("capture lifecycle is incomplete");
  }
}

/** Parses the exact bounded VAMeter-Edu capture-live.js saved-capture format. */
export function parseLiveCapture(text) {
  if (typeof text !== "string") throw new TypeError("capture text must be a string");
  if (new TextEncoder().encode(text).byteLength > MAX_CAPTURE_BYTES) throw new RangeError("capture exceeds " + MAX_CAPTURE_BYTES + " byte limit");
  let root;
  try { root = JSON.parse(text); } catch { throw new SyntaxError("capture is not valid JSON"); }
  const metadata = validateCaptureMetadata(root);
  if (root.controls.length + root.frames.length > MAX_CAPTURE_EVENTS) throw new RangeError("capture exceeds " + MAX_CAPTURE_EVENTS + " event limit");
  const events = [];

  for (const item of root.controls) {
    exactFields(item, CONTROL_FIELDS, "capture control");
    const eventIndex = nonNegativeUint(item.event_index, "control.event_index");
    const receivedMs = finiteNonNegativeNumber(item.received_ms, "control.received_ms");
    if (item.direction !== "client_to_server" && item.direction !== "server_to_client") throw new TypeError("invalid control direction");
    if (typeof item.text !== "string" || item.text.length === 0 || new TextEncoder().encode(item.text).byteLength > 2048) {
      throw new TypeError("control text must be a nonempty UTF-8 string within 2048 bytes");
    }
    events.push({ kind: "control", eventIndex, receivedMs, direction: item.direction, text: item.text });
  }
  for (const item of root.frames) {
    exactFields(item, FRAME_FIELDS, "capture frame");
    const eventIndex = nonNegativeUint(item.event_index, "frame.event_index");
    const receivedMs = finiteNonNegativeNumber(item.received_ms, "frame.received_ms");
    if (typeof item.hex !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(item.hex)) {
      throw new TypeError("frame.hex must contain an even nonempty sequence of hex bytes");
    }
    const buffer = hexToBuffer(item.hex);
    events.push({ kind: "binary", eventIndex, receivedMs, buffer });
  }
  events.sort((left, right) => left.eventIndex - right.eventIndex);
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].eventIndex !== index) throw new TypeError("event_index values must be unique and contiguous from zero");
    if (index > 0 && events[index].receivedMs < events[index - 1].receivedMs) throw new TypeError("received_ms must not decrease after merging events");
  }
  validateLifecycle(events, metadata);
  // Parsed JSON is intentionally not retained: this bounded replay plan is all
  // that remains until Close clears it.
  return Object.freeze(events.map((event) => Object.freeze(event)));
}

export class CaptureReplaySource extends DataSource {
  constructor({ speed = 1 } = {}) {
    super("capture-replay");
    this.speed = speed;
    this._events = null;
    this._cursor = 0;
    this._timer = null;
    this._running = false;
    this._lastReceivedMs = 0;
  }

  setSpeed(speed) {
    if (![0.25, 1, 2, "fast"].includes(speed)) throw new RangeError("capture speed must be 0.25, 1, 2, or fast");
    this.speed = speed;
  }

  loadText(text) {
    if (this._running) throw new Error("stop replay before loading a capture");
    this._events = parseLiveCapture(text);
    this._cursor = 0;
  }

  async loadFile(file) {
    if (!file || typeof file.text !== "function") throw new TypeError("a browser File is required");
    if (Number.isFinite(file.size) && file.size > MAX_CAPTURE_BYTES) throw new RangeError("capture exceeds " + MAX_CAPTURE_BYTES + " byte limit");
    this.loadText(await file.text());
  }

  async open() {
    if (!this._events) throw new Error("load a capture before opening replay");
    if (this.state === "open") return;
    this._emitStatus("open");
  }

  async start() {
    if (this._running) return;
    if (this.state !== "open" || !this._events) throw new Error("open a loaded capture first");
    this._running = true;
    this._cursor = 0;
    this._lastReceivedMs = this._events[0]?.receivedMs || 0;
    this._runNext();
  }

  async stop() {
    if (!this._running) return;
    this._running = false;
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = null;
    this._emitStatus("stopped", "capture replay stopped");
  }

  async close() {
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = null;
    this._running = false;
    this._events = null;
    this._cursor = 0;
    if (this.state !== "closed") this._emitStatus("closed");
  }

  _runNext() {
    if (!this._running || !this._events) return;
    if (this._cursor >= this._events.length) {
      this._running = false;
      this._emitStatus("stopped", "capture replay complete");
      return;
    }
    const event = this._events[this._cursor++];
    const elapsed = event.receivedMs - this._lastReceivedMs;
    this._lastReceivedMs = event.receivedMs;
    const delay = this.speed === "fast" ? 0 : Math.max(0, Math.round(elapsed / this.speed));
    this._timer = setTimeout(() => {
      if (!this._running) return;
      if (event.kind === "control") this._emitControl(event.direction, event.text);
      else this._emitBinary(event.buffer);
      this._runNext();
    }, delay);
  }
}
