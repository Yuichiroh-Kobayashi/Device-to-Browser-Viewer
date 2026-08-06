import { parseControlMessageText } from "./d2b-reference/control-parser.js";
import { createDecoderState } from "./d2b-reference/decoder-state.js";
import { decodeBinaryFrame } from "./d2b-reference/decoder.js";
import { BoundedSegmentBuffer } from "../model/bounded-segment-buffer.js";

const MAX_DIAGNOSTICS = 100;

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function shortMessage(error) {
  return String(error?.message || error || "unknown error").replace(/\s+/g, " ").slice(0, 512);
}

/**
 * Explicit application-owned d2b control state machine. The copied reference
 * parser validates wire syntax; this adapter owns transition timing and uses the
 * reference decoder only after exact negotiation is complete.
 */
export class SessionAdapter {
  constructor(model, { onChange = null } = {}) {
    if (!model || typeof model.prepareDecodedFrame !== "function") throw new TypeError("a StreamModel is required");
    this.model = model;
    this.onChange = typeof onChange === "function" ? onChange : null;
    this.controlState = "CLOSED";
    this.decoderState = null;
    this.welcome = null;
    this.pendingStart = null;
    this.active = null;
    this.helloSeen = false;
    this.stopRequested = false;
    this.lastError = null;
    this._diagnostics = new BoundedSegmentBuffer(MAX_DIAGNOSTICS);
  }

  onStatus(callback) {
    this.onChange = typeof callback === "function" ? callback : null;
    return () => { if (this.onChange === callback) this.onChange = null; };
  }

  notifyTransportStatus(status) {
    const state = typeof status === "string" ? status : status?.state;
    if (state === "open") {
      this._openTransport();
    } else if (state === "closed") {
      this._closeTransport();
    } else if (state === "stopped") {
      this.abortStreaming("source stopped");
    }
  }

  _openTransport() {
    if (this.controlState !== "CLOSED") this._resetSession();
    this.controlState = "CONNECTED";
    this.helloSeen = false;
    this._notify();
  }

  _closeTransport() {
    this._resetSession();
    this.controlState = "CLOSED";
    this._notify();
  }

  _resetSession() {
    this.decoderState = null;
    this.welcome = null;
    this.pendingStart = null;
    this.active = null;
    this.helloSeen = false;
    this.stopRequested = false;
    this.model.finishStream();
  }

  abortStreaming(reason = "stream aborted") {
    if (this.controlState === "STREAMING") {
      this.decoderState = null;
      this.active = null;
      this.pendingStart = null;
      this.stopRequested = false;
      this.model.finishStream();
      this.controlState = this.welcome ? "READY" : "CLOSED";
      this._diagnose("source_abort", reason);
      this._notify();
    }
  }

  handleControl(controlOrDirection, maybeText) {
    const control = typeof controlOrDirection === "object"
      ? controlOrDirection
      : { direction: controlOrDirection, text: maybeText };
    const { direction, text } = control || {};
    const before = this._controlSnapshot();
    try {
      if ((direction !== "client_to_server" && direction !== "server_to_client") || typeof text !== "string") {
        throw new TypeError("invalid control callback payload");
      }
      const context = direction === "client_to_server"
        ? { state: this.controlState, owns_stream: this.controlState === "STREAMING" && this.active !== null }
        : undefined;
      const message = parseControlMessageText(text, direction, context);
      this._applyControl(message, direction);
      this._notify();
      return true;
    } catch (error) {
      this._restoreControlSnapshot(before);
      this._diagnose(error?.code || "control_rejected", shortMessage(error));
      this._notify();
      return false;
    }
  }

  _applyControl(message, direction) {
    if (direction === "client_to_server") {
      if (message.type === "hello") {
        if (this.controlState !== "CONNECTED") throw new TypeError("hello outside CONNECTED");
        this.helloSeen = true;
        return;
      }
      if (message.type === "start_stream") {
        if (this.controlState !== "READY" || !this.welcome) throw new TypeError("start_stream outside READY");
        if (message.profile !== "vi-measurement") throw new TypeError("viewer supports only vi-measurement");
        this.pendingStart = cloneJson(message);
        this.stopRequested = false;
        return;
      }
      if (message.type === "stop_stream") {
        if (this.controlState !== "STREAMING" || !this.active) throw new TypeError("stop_stream outside STREAMING");
        if (Object.hasOwn(message, "stream_id") && message.stream_id !== this.active.streamId) {
          throw new TypeError("stop_stream stream_id does not match active stream");
        }
        this.stopRequested = true;
        return;
      }
      // parseControlMessageText only permits ping here, which is state-neutral.
      return;
    }

    if (message.type === "welcome") {
      if (this.controlState !== "CONNECTED" || !this.helloSeen) throw new TypeError("welcome requires a preceding hello");
      if (message.protocol !== "d2b-stream" || message.version !== "0.1" || message.session_state !== "ready") {
        throw new TypeError("unusable welcome");
      }
      this.welcome = cloneJson(message);
      this.controlState = "READY";
      return;
    }
    if (message.type === "stream_started") {
      if (this.controlState !== "READY" || !this.welcome || !this.pendingStart) {
        throw new TypeError("stream_started without a pending start_stream");
      }
      const request = this.pendingStart;
      if (message.stream !== request.stream || message.profile !== request.profile || canonicalJson(message.parameters) !== canonicalJson(request.parameters)) {
        throw new TypeError("stream_started does not match requested stream/profile/parameters");
      }
      const decoderState = createDecoderState({
        negotiated_version: this.welcome.version,
        session_state: "STREAMING",
        maximum_binary_frame_size: this.welcome.max_binary_frame_size,
        stream_id: message.stream_id,
        profile: request.profile,
        parameters: request.parameters,
      });
      // All construction succeeds before visible state changes.
      this.model.beginStream({ streamId: message.stream_id, profile: request.profile });
      this.decoderState = decoderState;
      this.active = Object.freeze({ streamId: message.stream_id, stream: request.stream, profile: request.profile, parameters: cloneJson(request.parameters) });
      this.pendingStart = null;
      this.stopRequested = false;
      this.controlState = "STREAMING";
      return;
    }
    if (message.type === "stream_stopped") {
      if (this.controlState !== "STREAMING" || !this.active) throw new TypeError("stream_stopped outside STREAMING");
      if (message.stream_id !== this.active.streamId) throw new TypeError("stream_stopped stream_id does not match active stream");
      this.decoderState = null;
      this.active = null;
      this.pendingStart = null;
      this.stopRequested = false;
      this.model.finishStream();
      this.controlState = "READY";
      return;
    }
    if (message.type === "status" && message.state === "streaming" && this.active && message.active_stream_id !== this.active.streamId) {
      throw new TypeError("status active_stream_id does not match active stream");
    }
    if (message.type === "error") {
      this._diagnose(`server_${message.code}`, message.message);
    }
  }

  handleBinary(buffer) {
    if (this.controlState !== "STREAMING" || this.decoderState === null || this.active === null) {
      this._diagnose("binary_outside_streaming", "binary data is only legal in STREAMING after stream_started");
      this._notify();
      return false;
    }
    try {
      // Both methods return candidates. Neither reference state nor model state is
      // changed until model validation has completed successfully.
      const referenceCandidate = decodeBinaryFrame(buffer, this.decoderState);
      const decodedForModel = Object.freeze({ ...referenceCandidate.decoded, segment: referenceCandidate.segment });
      const modelCandidate = this.model.prepareDecodedFrame(decodedForModel);
      this.model.commitCandidate(modelCandidate);
      this.decoderState = referenceCandidate.nextState;
      this._notify();
      return true;
    } catch (error) {
      this._diagnose(error?.code || "binary_rejected", shortMessage(error));
      this._notify();
      return false;
    }
  }

  handleError(error) {
    this._diagnose(error?.code || "source_error", shortMessage(error));
    this._notify();
  }

  _controlSnapshot() {
    return {
      controlState: this.controlState,
      decoderState: this.decoderState,
      welcome: this.welcome,
      pendingStart: this.pendingStart,
      active: this.active,
      helloSeen: this.helloSeen,
      stopRequested: this.stopRequested,
    };
  }

  _restoreControlSnapshot(snapshot) {
    this.controlState = snapshot.controlState;
    this.decoderState = snapshot.decoderState;
    this.welcome = snapshot.welcome;
    this.pendingStart = snapshot.pendingStart;
    this.active = snapshot.active;
    this.helloSeen = snapshot.helloSeen;
    this.stopRequested = snapshot.stopRequested;
  }

  _diagnose(code, message) {
    const entry = Object.freeze({ code: String(code).slice(0, 96), message: String(message).slice(0, 512) });
    this._diagnostics.append(entry);
    this.lastError = entry;
  }

  diagnostics() { return this._diagnostics.toArray(); }

  summary() {
    return Object.freeze({
      controlState: this.controlState,
      profile: this.active?.profile || this.pendingStart?.profile || null,
      streamId: this.active?.streamId || null,
      welcome: this.welcome ? Object.freeze({
        version: this.welcome.version,
        maximumBinaryFrameSize: this.welcome.max_binary_frame_size,
      }) : null,
      lastError: this.lastError,
      diagnosticCount: this._diagnostics.size,
    });
  }

  _notify() { this.onChange?.(this.summary()); }
}
