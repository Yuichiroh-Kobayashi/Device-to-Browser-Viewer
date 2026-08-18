import { StreamModel } from "../source-export/viewer/src/model/stream-model.js";
import { SessionAdapter } from "../source-export/viewer/src/protocol/session-adapter.js";
import { WebSocketSource, defaultWebSocketEndpoint } from "../source-export/viewer/src/sources/websocket-source.js";

/** Scratch-only seam: the sole owner of frozen runtime identity. */
export function createRuntimeOwner({
  endpoint = defaultWebSocketEndpoint(),
  stream = "live-vi",
  supportedStreams = ["live-vi"],
  scheduler = globalThis,
  timeouts = {},
} = {}) {
  const setTimeoutFn = scheduler?.setTimeout?.bind(scheduler);
  const clearTimeoutFn = scheduler?.clearTimeout?.bind(scheduler);
  if (!setTimeoutFn || !clearTimeoutFn) throw new TypeError("scheduler must provide setTimeout and clearTimeout");
  const timeoutMs = Object.freeze({ hello: 5_000, start: 5_000, stop: 5_000, ...timeouts });
  for (const [kind, value] of Object.entries(timeoutMs)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${kind} timeout must be a positive safe integer`);
  }
  const model = new StreamModel();
  const adapter = new SessionAdapter(model);
  let source = null;
  const listeners = new Set();
  const timers = new Map();
  const timedOut = new Set();
  const notify = () => listeners.forEach((listener) => listener());
  const clearTimer = (kind) => {
    const handle = timers.get(kind);
    if (handle !== undefined) clearTimeoutFn(handle);
    timers.delete(kind);
  };
  const clearTimers = () => {
    for (const kind of [...timers.keys()]) clearTimer(kind);
  };
  const forceClose = () => {
    clearTimers();
    if (!source) return Promise.resolve();
    return source.close();
  };
  const timeout = (kind) => {
    timers.delete(kind);
    timedOut.add(kind);
    adapter.handleError({ code: `${kind}_timeout`, message: `${kind} response timed out` });
    forceClose().catch(() => {});
  };
  const armTimer = (kind) => {
    if (timers.has(kind) || timedOut.has(kind)) return;
    timers.set(kind, setTimeoutFn(() => timeout(kind), timeoutMs[kind]));
  };
  const coordinateTimers = () => {
    const state = adapter.summary();
    if (state.controlState === "CONNECTED" && state.welcome === null) armTimer("hello");
    else clearTimer("hello");
    if (state.startPending) armTimer("start");
    else clearTimer("start");
    if (state.stopPending) armTimer("stop");
    else clearTimer("stop");
    if (state.controlState === "CLOSED") {
      clearTimers();
      timedOut.clear();
    }
  };
  adapter.onStatus(() => { coordinateTimers(); notify(); });

  function requestLive() {
    if (source) return source;
    source = new WebSocketSource({ endpoint, stream, supportedStreams, controlAuthority: adapter });
    source.onControl(({ direction, text }) => adapter.handleControl(direction, text));
    source.onBinary((buffer) => adapter.handleBinary(buffer));
    source.onStatus(({ state, detail }) => { adapter.notifyTransportStatus({ state }); if (detail) notify(); });
    source.onError((error) => { adapter.abortStreaming(String(error)); notify(); });
    return source;
  }

  const actions = Object.freeze({
    open: () => requestLive().open(),
    start: () => requestLive().start(),
    stop: () => {
      if (!source) return Promise.reject(new Error("open the WebSocket and await an active stream before stopping"));
      return source.stop();
    },
    close: () => forceClose(),
    forceClose,
  });

  return Object.freeze({
    model,
    adapter,
    actions,
    get source() { return source; },
    requestLive,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot() { return Object.freeze({ model, adapter, source, summary: adapter.summary(), latest: model.latest }); },
  });
}
