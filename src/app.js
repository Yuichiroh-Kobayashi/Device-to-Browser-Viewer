import { StreamModel } from "./model/stream-model.js";
import { SessionAdapter } from "./protocol/session-adapter.js";
import { SYNTHETIC_SCENARIOS, SyntheticSource } from "./sources/synthetic-source.js";
import { CaptureReplaySource } from "./sources/capture-replay-source.js";
import { defaultWebSocketEndpoint, WebSocketSource } from "./sources/websocket-source.js";
import { WaveformCanvas } from "./render/waveform-canvas.js";
import { liveActionAvailability } from "./ui/action-availability.js";
import { attachSourceActivity } from "./ui/source-activity.js";

const element = (id) => document.getElementById(id);
const controls = {
  source: element("source-select"), scenario: element("scenario-select"), capture: element("capture-file"),
  endpoint: element("endpoint-input"), speed: element("speed-select"), window: element("window-select"),
  open: element("open-button"), start: element("start-button"), stop: element("stop-button"), close: element("close-button"),
};
const statusGrid = element("status-grid");
const latestGrid = element("latest-grid");
const diagnosticCount = element("diagnostic-count");
const diagnosticList = element("diagnostics-list");
const voltageValue = element("voltage-value");
const currentValue = element("current-value");

for (const scenario of SYNTHETIC_SCENARIOS) {
  const option = document.createElement("option");
  option.value = scenario.id;
  option.textContent = scenario.label;
  controls.scenario.append(option);
}
controls.endpoint.value = defaultWebSocketEndpoint();

const model = new StreamModel({ capacity: 4096, displayWindowSeconds: Number(controls.window.value) });
const adapter = new SessionAdapter(model, { onChange: () => afterActivity() });
let source = null;
let sourceStatus = Object.freeze({ source: "none", state: "closed" });
let renderPending = false;
let currentScenario = controls.scenario.value;

const voltageCanvas = new WaveformCanvas(element("voltage-canvas"), {
  channel: "voltage", unit: "V", title: "Voltage", onResize: requestRender,
});
const currentCanvas = new WaveformCanvas(element("current-canvas"), {
  channel: "current", unit: "A", title: "Current", onResize: requestRender,
});

function sourceSpeed() {
  const value = controls.speed.value;
  return value === "fast" ? "fast" : Number(value);
}

function formatMeasurement(value, valid) {
  if (!valid || typeof value !== "number" || !Number.isFinite(value)) return "Invalid";
  return value.toFixed(Math.abs(value) >= 10 ? 2 : 4).replace(/\.0+$|(?<=\.[0-9]*?)0+$/, "");
}

function appendDefinition(grid, label, value) {
  const holder = document.createElement("div");
  const term = document.createElement("dt");
  const detail = document.createElement("dd");
  term.textContent = label;
  detail.textContent = value ?? "—";
  holder.append(term, detail);
  grid.append(holder);
}

function updateUi() {
  const summary = model.summary();
  const session = adapter.summary();
  const liveActions = liveActionAvailability(session, sourceStatus);
  const liveSource = source instanceof WebSocketSource;
  controls.start.disabled = liveSource ? !liveActions.start : false;
  controls.stop.disabled = liveSource ? !liveActions.stop : false;
  statusGrid.replaceChildren();
  const entries = [
    ["Source state", `${sourceStatus.source}: ${sourceStatus.state}`],
    ["D2B control state", session.controlState],
    ["Profile", session.profile || "—"],
    ["Stream ID", session.streamId ?? "—"],
    ["Samples / segments", `${summary.sampleCount} / ${summary.segmentCount}`],
    ["Sequence gaps", `${summary.sequenceGapCount} (${summary.sequenceGapSamples} samples)`],
    ["Producer overflow", summary.producerOverflowCount],
    ["Output queue drops", summary.outputQueueDropCount],
    ["Invalid V / I", `${summary.invalidVoltageCount} / ${summary.invalidCurrentCount}`],
    ["Viewer evictions", `${summary.viewerEvictionCount} (window ${summary.viewerWindowEvictionCount}, capacity ${summary.viewerCapacityEvictionCount})`],
    ["Retained ring", `${summary.bufferUsage} / ${summary.bufferCapacity}`],
    ["Last error", session.lastError ? `${session.lastError.code}: ${session.lastError.message}` : "—"],
  ];
  for (const [label, value] of entries) appendDefinition(statusGrid, label, String(value));

  const latest = summary.latest;
  voltageValue.textContent = latest ? formatMeasurement(latest.voltageV, Boolean(latest.validMask & 1)) : "—";
  currentValue.textContent = latest ? formatMeasurement(latest.currentA, Boolean(latest.validMask & 2)) : "—";
  latestGrid.replaceChildren();
  appendDefinition(latestGrid, "Device timestamp (µs)", latest?.timestampUs || "—");
  appendDefinition(latestGrid, "Sequence", latest?.sequence || "—");
  appendDefinition(latestGrid, "Valid mask", latest?.validMask ?? "—");
  appendDefinition(latestGrid, "Stream ID", latest?.streamId ?? "—");

  const diagnostics = adapter.diagnostics();
  diagnosticCount.textContent = String(diagnostics.length);
  diagnosticList.replaceChildren();
  for (const diagnostic of diagnostics) {
    const item = document.createElement("li");
    item.textContent = `${diagnostic.code}: ${diagnostic.message}`;
    diagnosticList.append(item);
  }
}

function requestRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    const records = model.recordSnapshot();
    const markers = model.markerSnapshot();
    voltageCanvas.draw(records, markers);
    currentCanvas.draw(records, markers);
  });
}

function afterActivity() {
  updateUi();
  requestRender();
}

function attachSource(nextSource) {
  attachSourceActivity(nextSource, adapter, {
    setSourceStatus(status) { sourceStatus = status; },
    afterActivity,
  });
}

async function replaceSource() {
  if (source) await source.close();
  const kind = controls.source.value;
  if (kind === "synthetic") {
    currentScenario = controls.scenario.value;
    source = new SyntheticSource({ scenario: currentScenario, speed: sourceSpeed() });
  } else if (kind === "capture") {
    source = new CaptureReplaySource({ speed: sourceSpeed() });
  } else {
    source = new WebSocketSource({
      endpoint: controls.endpoint.value,
      stream: "live-vi",
      supportedStreams: ["live-vi"],
      controlAuthority: adapter,
    });
  }
  sourceStatus = Object.freeze({ source: source.kind, state: "closed" });
  attachSource(source);
  updateSourceSpecificControls();
  afterActivity();
}

function updateSourceSpecificControls() {
  const kind = controls.source.value;
  document.querySelectorAll(".synthetic-only").forEach((node) => node.classList.toggle("is-hidden", kind !== "synthetic"));
  document.querySelectorAll(".capture-only").forEach((node) => node.classList.toggle("is-hidden", kind !== "capture"));
  document.querySelectorAll(".live-only").forEach((node) => node.classList.toggle("is-hidden", kind !== "websocket"));
}

async function withUiError(action) {
  try { await action(); } catch (error) { adapter.handleError(error); afterActivity(); }
}

controls.source.addEventListener("change", () => { void withUiError(replaceSource); });
controls.scenario.addEventListener("change", () => {
  currentScenario = controls.scenario.value;
  if (source instanceof SyntheticSource && source.state !== "open") source.setScenario(currentScenario);
});
controls.speed.addEventListener("change", () => {
  if (source?.setSpeed) source.setSpeed(sourceSpeed());
});
controls.window.addEventListener("change", () => {
  try { model.setDisplayWindowSeconds(Number(controls.window.value)); } catch (error) { adapter.handleError(error); }
  afterActivity();
});
controls.capture.addEventListener("change", () => {
  void withUiError(async () => {
    if (!(source instanceof CaptureReplaySource)) throw new Error("select Capture replay before choosing a file");
    const [file] = controls.capture.files || [];
    if (!file) return;
    await source.loadFile(file);
    afterActivity();
  });
});
controls.open.addEventListener("click", () => {
  void withUiError(async () => {
    if (source instanceof SyntheticSource) source.setScenario(controls.scenario.value);
    if (source instanceof WebSocketSource) source.setEndpoint(controls.endpoint.value);
    await source.open();
  });
});
controls.start.addEventListener("click", () => {
  void withUiError(async () => {
    if (source instanceof WebSocketSource && !liveActionAvailability(adapter.summary(), sourceStatus).start) {
      throw new Error("wait for a validated welcome before starting live stream");
    }
    await source.start();
  });
});
controls.stop.addEventListener("click", () => {
  void withUiError(async () => {
    if (source instanceof WebSocketSource && !liveActionAvailability(adapter.summary(), sourceStatus).stop) {
      throw new Error("wait for an accepted active stream before stopping live stream");
    }
    await source.stop();
  });
});
controls.close.addEventListener("click", () => { void withUiError(() => source.close()); });

window.addEventListener("error", (event) => {
  adapter.handleError(event.error || event.message || "window error");
  afterActivity();
});
window.addEventListener("unhandledrejection", (event) => {
  adapter.handleError(event.reason || "unhandled rejection");
  afterActivity();
});

Object.defineProperty(window, "__viewerDiagnostics", {
  configurable: true,
  value: Object.freeze({
    get model() { return model.summary(); },
    get session() { return adapter.summary(); },
    get errors() { return adapter.diagnostics(); },
    get currentScenario() { return currentScenario; },
    get source() { return Object.freeze({ kind: source?.kind || "none", state: sourceStatus.state }); },
  }),
});

async function bootstrap() {
  const query = new URLSearchParams(location.search);
  const requestedSource = query.get("source");
  const requestedScenario = query.get("scenario");
  if (["synthetic", "capture", "websocket"].includes(requestedSource)) controls.source.value = requestedSource;
  if (SYNTHETIC_SCENARIOS.some((item) => item.id === requestedScenario)) controls.scenario.value = requestedScenario;
  await replaceSource();
  if (query.get("autostart") === "1" && source instanceof SyntheticSource) {
    await source.open();
    await source.start();
  }
}

void withUiError(bootstrap);
