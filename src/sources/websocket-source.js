import { DataSource } from "./data-source.js";
import { DEFAULT_VI_PARAMETERS, makeHelloText } from "./synthetic-source.js";
import { CONTROL_LIMIT } from "../protocol/d2b-reference/protocol-constants.js";
import { IDENTIFIER_RE } from "../protocol/d2b-reference/value-validators.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject, settled: false, socket: null, generation: 0 };
}

function startStreamControlText(stream) {
  return JSON.stringify({
    type: "start_stream",
    stream,
    profile: "vi-measurement",
    parameters: DEFAULT_VI_PARAMETERS,
  });
}

function requireWireSafeStream(stream, field) {
  if (typeof stream !== "string" || stream.length === 0 || stream !== stream.trim()) {
    throw new TypeError(`${field} must be a trimmed, nonempty stream identifier`);
  }
  if (!IDENTIFIER_RE.test(stream)) throw new TypeError(`${field} is not wire-safe`);
  if (new TextEncoder().encode(startStreamControlText(stream)).byteLength > CONTROL_LIMIT) {
    throw new RangeError(`${field} exceeds the control message limit`);
  }
  return stream;
}

function selectSupportedStream(stream, supportedStreams) {
  if (!Array.isArray(supportedStreams) || supportedStreams.length === 0) {
    throw new TypeError("supportedStreams must be a nonempty array");
  }
  const selected = requireWireSafeStream(stream, "stream");
  for (const candidate of supportedStreams) requireWireSafeStream(candidate, "supportedStreams entry");
  if (!supportedStreams.includes(selected)) throw new RangeError("stream is not in supportedStreams");
  return Object.freeze({ stream: selected, supportedStreams: Object.freeze([...supportedStreams]) });
}

function requireControlAuthority(controlAuthority) {
  if (!controlAuthority || (typeof controlAuthority !== "object" && typeof controlAuthority !== "function")) {
    throw new TypeError("controlAuthority is required");
  }
  for (const method of ["prepareOutboundControl", "commitOutboundControl", "rollbackOutboundControl", "summary"]) {
    if (typeof controlAuthority[method] !== "function") throw new TypeError(`controlAuthority.${method} must be a function`);
  }
  return controlAuthority;
}

export function defaultWebSocketEndpoint(locationLike = globalThis.location) {
  const host = locationLike?.host;
  if (!host) return "ws://127.0.0.1:8080/d2b/v0/stream";
  const scheme = locationLike.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${host}/d2b/v0/stream`;
}

/**
 * Direct browser WebSocket source. It intentionally does not use a relay,
 * origin bypass, CORS workaround, or authentication shortcut.
 */
export class WebSocketSource extends DataSource {
  constructor({ endpoint = defaultWebSocketEndpoint(), stream, supportedStreams, controlAuthority } = {}) {
    const selection = selectSupportedStream(stream, supportedStreams);
    const authority = requireControlAuthority(controlAuthority);
    super("websocket");
    this.endpoint = endpoint;
    this.stream = selection.stream;
    this.supportedStreams = selection.supportedStreams;
    this.controlAuthority = authority;
    this.socket = null;
    this._generation = 0;
    this._socketGeneration = 0;
    this._opening = null;
    this._openPromise = null;
    this._closing = null;
    this._closePromise = null;
    this._failedOpenSocket = null;
  }

  setEndpoint(endpoint) {
    if (this.socket || this._opening || this._closing) throw new Error("close the WebSocket before changing its endpoint");
    const parsed = new URL(endpoint, globalThis.location?.href || "http://localhost/");
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new TypeError("WebSocket endpoint must use ws: or wss:");
    this.endpoint = parsed.href;
  }

  async open() {
    const WebSocketClass = globalThis.WebSocket;
    if (typeof WebSocketClass === "undefined") throw new Error("WebSocket is unavailable in this runtime");
    if (this._closing) {
      const closing = this._closing;
      const closed = WebSocketClass.CLOSED ?? 3;
      if (this._ownsSocket(closing.socket, closing.generation) && closing.socket.readyState === closed) {
        this._handleSocketClose(closing.socket, closing.generation);
      }
      if (this._closing) await this._closing.promise;
      return this.open();
    }
    if (this._opening) return this._opening.promise;
    if (this.socket) {
      if (this.socket.readyState === WebSocketClass.OPEN && this._failedOpenSocket !== this.socket) return;
      await this.close();
      return this.open();
    }
    return this._openNewSocket(WebSocketClass);
  }

  _openNewSocket(WebSocketClass) {
    const opening = deferred();
    const generation = ++this._generation;
    opening.generation = generation;
    this._opening = opening;
    this._openPromise = opening.promise;
    this._safeEmitStatus("connecting");
    let socket = null;
    try {
      socket = new WebSocketClass(this.endpoint);
      opening.socket = socket;
      this.socket = socket;
      this._socketGeneration = generation;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => this._handleSocketOpen(socket, generation, opening);
      socket.onmessage = (event) => this._handleSocketMessage(socket, generation, event);
      socket.onerror = () => this._handleSocketError(socket, generation, opening);
      socket.onclose = () => this._handleSocketClose(socket, generation);
    } catch (error) {
      if (socket && this._ownsSocket(socket, generation)) {
        this.socket = null;
        this._socketGeneration = 0;
        try { socket.close(1000, "viewer close"); } catch { /* initialization already failed */ }
      }
      this._settleOpeningReject(opening, error);
      this._safeEmitError(error);
      this._safeEmitStatus("closed", "WebSocket construction failed");
    }
    return opening.promise;
  }

  async start() {
    const WebSocketClass = globalThis.WebSocket;
    if (!this.socket || !WebSocketClass || this.socket.readyState !== WebSocketClass.OPEN || this._isClosingSocket(this.socket, this._socketGeneration)) {
      throw new Error("open the WebSocket and await welcome before starting");
    }
    this._sendControl(startStreamControlText(this.stream));
  }

  async stop() {
    const WebSocketClass = globalThis.WebSocket;
    if (!this.socket || !WebSocketClass || this.socket.readyState !== WebSocketClass.OPEN || this._isClosingSocket(this.socket, this._socketGeneration)) {
      throw new Error("open the WebSocket and await an active stream before stopping");
    }
    const streamId = this.controlAuthority.summary()?.streamId;
    if (!Number.isSafeInteger(streamId) || streamId < 1) throw new Error("no accepted active stream to stop");
    const message = { type: "stop_stream", stream_id: streamId, reason: "viewer stop" };
    this._sendControl(JSON.stringify(message));
  }

  close() {
    if (this._closing) {
      const closingAttempt = this._closing;
      const closed = globalThis.WebSocket?.CLOSED ?? 3;
      if (this._ownsSocket(closingAttempt.socket, closingAttempt.generation) && closingAttempt.socket.readyState === closed) {
        this._handleSocketClose(closingAttempt.socket, closingAttempt.generation);
      }
      return this._closing?.promise || Promise.resolve();
    }
    const socket = this.socket;
    if (!socket) {
      if (this.state !== "closed") this._safeEmitStatus("closed");
      return Promise.resolve();
    }
    const WebSocketClass = globalThis.WebSocket;
    const closed = WebSocketClass?.CLOSED ?? 3;
    const closing = WebSocketClass?.CLOSING ?? 2;
    const generation = this._socketGeneration;
    if (socket.readyState === closed) {
      this._handleSocketClose(socket, generation);
      return Promise.resolve();
    }

    const closeAttempt = deferred();
    closeAttempt.socket = socket;
    closeAttempt.generation = generation;
    this._closing = closeAttempt;
    this._closePromise = closeAttempt.promise;
    try {
      if (socket.readyState !== closing) socket.close(1000, "viewer close");
      if (this._ownsSocket(socket, generation) && socket.readyState === closed) {
        this._handleSocketClose(socket, generation);
      }
    } catch (error) {
      this._settleClosingReject(closeAttempt, error);
      this._safeEmitError(error);
    }
    return closeAttempt.promise;
  }

  _handleSocketOpen(socket, generation, opening) {
    if (!this._ownsSocket(socket, generation) || this._isClosingSocket(socket, generation) || this._opening !== opening || opening.settled) return;
    try {
      this._safeEmitStatus("open");
      this._sendControl(makeHelloText(), socket, generation);
      this._settleOpeningResolve(opening);
    } catch (error) {
      this._failedOpenSocket = socket;
      this._settleOpeningReject(opening, error);
      this._safeEmitError(error);
      this._closeAfterOpenFailure(socket, generation);
    }
  }

  _handleSocketMessage(socket, generation, event) {
    if (!this._ownsSocket(socket, generation) || this._isClosingSocket(socket, generation)) return;
    if (typeof event.data === "string") {
      this._safeEmitControl("server_to_client", event.data);
      return;
    }
    if (event.data instanceof ArrayBuffer) {
      this._safeEmitBinary(event.data);
      return;
    }
    this._safeEmitError(new TypeError("WebSocket delivered a non-ArrayBuffer binary payload"));
  }

  _handleSocketError(socket, generation, opening) {
    if (!this._ownsSocket(socket, generation) || this._isClosingSocket(socket, generation)) return;
    const error = new Error("WebSocket transport error");
    this._safeEmitError(error);
    if (this._opening === opening && !opening.settled) {
      this._failedOpenSocket = socket;
      this._settleOpeningReject(opening, error);
      this._closeAfterOpenFailure(socket, generation);
    }
  }

  _handleSocketClose(socket, generation) {
    if (!this._ownsSocket(socket, generation)) return;
    const opening = this._opening;
    const closing = this._closing;
    if (opening?.socket === socket && opening.generation === generation) {
      this._settleOpeningReject(opening, new Error("WebSocket closed before opening"));
    }
    this.socket = null;
    this._socketGeneration = 0;
    this._failedOpenSocket = null;
    if (closing?.socket === socket && closing.generation === generation) this._settleClosingResolve(closing);
    this._safeEmitStatus("closed", "WebSocket closed");
  }

  _closeAfterOpenFailure(socket, generation) {
    if (!this._ownsSocket(socket, generation)) return;
    const pendingClose = this.close();
    pendingClose.catch(() => {});
  }

  _sendControl(controlText, socket = this.socket, generation = this._socketGeneration) {
    const WebSocketClass = globalThis.WebSocket;
    if (!this._ownsSocket(socket, generation) || this._isClosingSocket(socket, generation) || !WebSocketClass || socket.readyState !== WebSocketClass.OPEN) {
      throw new Error("WebSocket is not open");
    }
    const token = this.controlAuthority.prepareOutboundControl(controlText);
    try {
      socket.send(controlText);
    } catch (error) {
      try {
        this.controlAuthority.rollbackOutboundControl(token);
      } catch (rollbackError) {
        this._safeEmitError(rollbackError);
      }
      throw error;
    }
    // A successful send is irreversible. Never roll back or retry a commit error.
    this.controlAuthority.commitOutboundControl(token);
  }

  _ownsSocket(socket, generation) {
    return this.socket === socket && this._socketGeneration === generation;
  }

  _isClosingSocket(socket, generation) {
    return this._closing?.socket === socket && this._closing.generation === generation;
  }

  _settleOpeningResolve(opening) {
    if (this._opening !== opening || opening.settled) return;
    opening.settled = true;
    this._opening = null;
    if (this._openPromise === opening.promise) this._openPromise = null;
    opening.resolve();
  }

  _settleOpeningReject(opening, error) {
    if (this._opening !== opening || opening.settled) return;
    opening.settled = true;
    this._opening = null;
    if (this._openPromise === opening.promise) this._openPromise = null;
    opening.reject(error);
  }

  _settleClosingResolve(closing) {
    if (this._closing !== closing || closing.settled) return;
    closing.settled = true;
    this._closing = null;
    if (this._closePromise === closing.promise) this._closePromise = null;
    closing.resolve();
  }

  _settleClosingReject(closing, error) {
    if (this._closing !== closing || closing.settled) return;
    closing.settled = true;
    this._closing = null;
    if (this._closePromise === closing.promise) this._closePromise = null;
    closing.reject(error);
  }

  _safeEmitStatus(state, detail = undefined) {
    try { this._emitStatus(state, detail); } catch { /* external observer failures cannot strand lifecycle */ }
  }

  _safeEmitError(error) {
    try { this._emitError(error); } catch { /* never recurse through a failing error observer */ }
  }

  _safeEmitControl(direction, text) {
    try { this._emitControl(direction, text); } catch (error) { this._safeEmitError(error); }
  }

  _safeEmitBinary(buffer) {
    try { this._emitBinary(buffer); } catch (error) { this._safeEmitError(error); }
  }
}
