import { DataSource } from "./data-source.js";
import { DEFAULT_VI_PARAMETERS, makeHelloText } from "./synthetic-source.js";

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
    this._openPromise = null;
    this._activeStreamId = null;
  }

  setEndpoint(endpoint) {
    if (this.socket) throw new Error("close the WebSocket before changing its endpoint");
    const parsed = new URL(endpoint, globalThis.location?.href || "http://localhost/");
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new TypeError("WebSocket endpoint must use ws: or wss:");
    this.endpoint = parsed.href;
  }

  async open() {
    const WebSocketClass = globalThis.WebSocket;
    if (typeof WebSocketClass === "undefined") throw new Error("WebSocket is unavailable in this runtime");
    if (this.socket?.readyState === WebSocketClass.OPEN) return;
    if (this._openPromise) return this._openPromise;
    this._emitStatus("connecting");
    let settleOpen;
    let settleReject;
    const opening = new Promise((resolve, reject) => {
      settleOpen = resolve;
      settleReject = reject;
    });
    this._openPromise = opening;
    try {
      const socket = new WebSocketClass(this.endpoint);
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      let settled = false;
      socket.onopen = () => {
        this._emitStatus("open");
        try {
          this._sendControl(makeHelloText());
          settled = true;
          this._openPromise = null;
          settleOpen();
        } catch (error) {
          settled = true;
          this._openPromise = null;
          settleReject(error);
        }
      };
      socket.onmessage = (event) => this._onMessage(event);
      socket.onerror = () => {
        const error = new Error("WebSocket transport error");
        this._emitError(error);
        if (!settled) {
          settled = true;
          this._openPromise = null;
          settleReject(error);
        }
      };
      socket.onclose = () => {
        this.socket = null;
        this._activeStreamId = null;
        this._emitStatus("closed", "WebSocket closed");
        if (!settled) {
          settled = true;
          this._openPromise = null;
          settleReject(new Error("WebSocket closed before opening"));
        }
      };
    } catch (error) {
      this._openPromise = null;
      this._emitError(error);
      this._emitStatus("closed", "WebSocket construction failed");
      settleReject(error);
    }
    return opening;
  }

  async start() {
    const WebSocketClass = globalThis.WebSocket;
    if (!this.socket || !WebSocketClass || this.socket.readyState !== WebSocketClass.OPEN) throw new Error("open the WebSocket and await welcome before starting");
    this._sendControl(JSON.stringify({
      type: "start_stream",
      stream: this.stream,
      profile: "vi-measurement",
      parameters: DEFAULT_VI_PARAMETERS,
    }));
  }

  async stop() {
    const WebSocketClass = globalThis.WebSocket;
    if (!this.socket || !WebSocketClass || this.socket.readyState !== WebSocketClass.OPEN) return;
    const message = { type: "stop_stream", reason: "viewer stop" };
    if (this._activeStreamId !== null) message.stream_id = this._activeStreamId;
    this._sendControl(JSON.stringify(message));
  }

  async close() {
    const WebSocketClass = globalThis.WebSocket;
    if (!this.socket) {
      if (this.state !== "closed") this._emitStatus("closed");
      return;
    }
    const socket = this.socket;
    if (!WebSocketClass || socket.readyState === WebSocketClass.CLOSING || socket.readyState === WebSocketClass.CLOSED) return;
    socket.close(1000, "viewer close");
  }

  _sendControl(controlText) {
    const WebSocketClass = globalThis.WebSocket;
    if (!this.socket || !WebSocketClass || this.socket.readyState !== WebSocketClass.OPEN) throw new Error("WebSocket is not open");
    this.socket.send(controlText);
    this._emitControl("client_to_server", controlText);
  }

  _onMessage(event) {
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
