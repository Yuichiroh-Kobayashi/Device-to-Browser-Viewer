import { DataSource } from "./data-source.js";
import { DEFAULT_VI_PARAMETERS, makeHelloText } from "./synthetic-source.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject, settled: false, socket: null, generation: 0 };
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
  constructor({ endpoint = defaultWebSocketEndpoint(), stream = "measurement-0" } = {}) {
    super("websocket");
    this.endpoint = endpoint;
    this.stream = stream;
    this.socket = null;
    this._generation = 0;
    this._socketGeneration = 0;
    this._opening = null;
    this._openPromise = null;
    this._closing = null;
    this._closePromise = null;
    this._failedOpenSocket = null;
    this._activeStreamId = null;
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
    this._emitStatus("connecting");
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
        this._activeStreamId = null;
        try { socket.close(1000, "viewer close"); } catch { /* initialization already failed */ }
      }
      this._settleOpeningReject(opening, error);
      this._emitError(error);
      this._emitStatus("closed", "WebSocket construction failed");
    }
    return opening.promise;
  }

  async start() {
    const WebSocketClass = globalThis.WebSocket;
    if (!this.socket || !WebSocketClass || this.socket.readyState !== WebSocketClass.OPEN || this._isClosingSocket(this.socket, this._socketGeneration)) {
      throw new Error("open the WebSocket and await welcome before starting");
    }
    this._sendControl(JSON.stringify({
      type: "start_stream",
      stream: this.stream,
      profile: "vi-measurement",
      parameters: DEFAULT_VI_PARAMETERS,
    }));
  }

  async stop() {
    const WebSocketClass = globalThis.WebSocket;
    if (!this.socket || !WebSocketClass || this.socket.readyState !== WebSocketClass.OPEN || this._isClosingSocket(this.socket, this._socketGeneration)) return;
    const message = { type: "stop_stream", reason: "viewer stop" };
    if (this._activeStreamId !== null) message.stream_id = this._activeStreamId;
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
      if (this.state !== "closed") this._emitStatus("closed");
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
      this._emitError(error);
    }
    return closeAttempt.promise;
  }

  _handleSocketOpen(socket, generation, opening) {
    if (!this._ownsSocket(socket, generation) || this._isClosingSocket(socket, generation) || this._opening !== opening || opening.settled) return;
    try {
      this._emitStatus("open");
      this._sendControl(makeHelloText(), socket, generation);
      this._settleOpeningResolve(opening);
    } catch (error) {
      this._failedOpenSocket = socket;
      this._settleOpeningReject(opening, error);
      this._emitError(error);
      this._closeAfterOpenFailure(socket, generation);
    }
  }

  _handleSocketMessage(socket, generation, event) {
    if (!this._ownsSocket(socket, generation) || this._isClosingSocket(socket, generation)) return;
    if (typeof event.data === "string") {
      this._observeServerControl(event.data);
      this._emitControl("server_to_client", event.data);
      return;
    }
    if (event.data instanceof ArrayBuffer) {
      this._emitBinary(event.data);
      return;
    }
    this._emitError(new TypeError("WebSocket delivered a non-ArrayBuffer binary payload"));
  }

  _handleSocketError(socket, generation, opening) {
    if (!this._ownsSocket(socket, generation) || this._isClosingSocket(socket, generation)) return;
    const error = new Error("WebSocket transport error");
    this._emitError(error);
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
    this._activeStreamId = null;
    this._failedOpenSocket = null;
    this._emitStatus("closed", "WebSocket closed");
    if (closing?.socket === socket && closing.generation === generation) this._settleClosingResolve(closing);
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
    socket.send(controlText);
    if (this._ownsSocket(socket, generation) && !this._isClosingSocket(socket, generation)) {
      this._emitControl("client_to_server", controlText);
    }
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

  _observeServerControl(controlText) {
    // This is only for optional stop targeting. The adapter remains the sole
    // validator and owner of server transition state.
    try {
      const message = JSON.parse(controlText);
      if (message?.type === "stream_started" && Number.isSafeInteger(message.stream_id)) this._activeStreamId = message.stream_id;
      if (message?.type === "stream_stopped") this._activeStreamId = null;
    } catch {
      // Pass malformed text to the strict adapter; it will record the protocol error.
    }
  }
}
