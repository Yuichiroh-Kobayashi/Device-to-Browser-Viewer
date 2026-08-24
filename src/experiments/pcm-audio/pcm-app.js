import { PcmAudioModel } from "./pcm-audio-model.js";
import { PcmSessionAdapter } from "./pcm-session-adapter.js";
import { PCM_SYNTHETIC_SCENARIOS, SyntheticPcmSource } from "./synthetic-pcm-source.js";
import { DEFAULT_PCM_WINDOW_MS, PcmWaveformCanvas, estimateWindowStats, flattenWindow } from "./pcm-waveform-canvas.js";
import { liveActionAvailability } from "../../ui/action-availability.js";
import { attachSourceActivity } from "../../ui/source-activity.js";

const element = (id) => document.getElementById(id);
const controls = {
  scenario: element("scenario-select"), speed: element("speed-select"), window: element("window-select"),
  open: element("open-button"), start: element("start-button"), stop: element("stop-button"), close: element("close-button"),
};
const statusGrid = element("status-grid");
const latestGrid = element("latest-grid");
const markerCount = element("marker-count");
const markersList = element("markers-list");
const diagnosticCount = element("diagnostic-count");
const diagnosticList = element("diagnostics-list");
const peakValue = element("peak-value");
const rmsValue = element("rms-value");

for (const scenario of PCM_SYNTHETIC_SCENARIOS) {
  const option = document.createElement("option");
  option.value = scenario.id;
  option.textContent = scenario.label;
  controls.scenario.append(option);
}

const model = new PcmAudioModel();
const adapter = new PcmSessionAdapter(model, { onChange: () => afterActivity() });
let source = null;
let sourceStatus = Object.freeze({ source: "none", state: "closed" });
let renderPending = false;

const pcmCanvas = new PcmWaveformCanvas(element("pcm-canvas"), { title: "PCM amplitude", onResize: requestRender });

function windowMs() { return Number(controls.window.value); }
function sourceSpeed() {
  const value = controls.speed.value;
  return value === "fast" ? "fast" : Number(value);
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
  const actions = liveActionAvailability(session, sourceStatus);
  const sourceOpen = sourceStatus.state === "open";
  controls.start.disabled = !sourceOpen || !actions.start;
  controls.stop.disabled = !sourceOpen || !actions.stop;

  statusGrid.replaceChildren();
  const sampleRate = summary.sampleRate;
  const rateText = sampleRate ? `${sampleRate.numerator}/${sampleRate.denominator} Hz` : "—";
  const entries = [
    ["Source state", `${sourceStatus.source}: ${sourceStatus.state}`],
    ["D2B control state", session.controlState],
    ["Profile", session.profile || "—"],
    ["Stream ID", session.streamId ?? "—"],
    ["Sample rate", rateText],
    ["Channel count", "1 (mono)"],
    ["Samples per frame", summary.samplesPerFrame ?? "—"],
    ["Frames / samples", `${summary.frameCount} / ${summary.sampleCount}`],
    ["Sequence gaps", `${summary.sequenceGapCount} (${summary.sequenceGapSamples} samples)`],
    ["Producer overflow / output drop", `${summary.producerOverflowCount} / ${summary.outputQueueDropCount}`],
    ["Source paused / timebase resets", `${summary.sourcePausedCount} / ${summary.timebaseResetCount}`],
    ["Rejected frames (never mutate model)", summary.rejectedFrameCount],
    ["Retained ring", `${summary.bufferUsage} / ${summary.bufferCapacity} frames`],
    ["Epoch ID", summary.epochId],
    ["Last error", session.lastError ? `${session.lastError.code}: ${session.lastError.message}` : "—"],
  ];
  for (const [label, value] of entries) appendDefinition(statusGrid, label, String(value));

  const latest = summary.latest;
  latestGrid.replaceChildren();
  appendDefinition(latestGrid, "Device timestamp (µs)", latest?.timestampUs || "—");
  appendDefinition(latestGrid, "Sequence (first sample)", latest?.sequence || "—");
  appendDefinition(latestGrid, "Stream ID", latest?.streamId ?? "—");
  appendDefinition(latestGrid, "Segment / epoch", latest ? `${latest.segmentId} / ${latest.epochId}` : "—");
  appendDefinition(latestGrid, "First / last sample (Int16)", latest ? `${latest.firstSample} / ${latest.lastSample}` : "—");

  const points = flattenWindow(model.frameSnapshot(), { windowMs: windowMs(), sampleRate });
  const stats = estimateWindowStats(points, { sampleRate });
  peakValue.textContent = stats.peak === null ? "—" : stats.peak.toFixed(3);
  rmsValue.textContent = stats.rms === null ? "—" : stats.rms.toFixed(3);

  const markers = model.markerSnapshot();
  markerCount.textContent = String(markers.length);
  markersList.replaceChildren();
  for (const marker of markers.slice(-20)) {
    const item = document.createElement("li");
    const causes = [];
    if (marker.causes.producerOverflow) causes.push("producer overflow");
    if (marker.causes.outputQueueDrop) causes.push("output drop");
    if (marker.causes.sourcePaused) causes.push("source paused");
    if (marker.causes.timebaseReset) causes.push("timebase reset");
    item.textContent = `segment ${marker.id} @ seq ${marker.sequence}: ${marker.kind}` +
      (marker.gap_samples > 0n ? ` (${marker.gap_samples} sample gap${causes.length ? `, ${causes.join(", ")}` : ""})` : "");
    markersList.append(item);
  }

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
    const summary = model.summary();
    pcmCanvas.draw(model.frameSnapshot(), model.markerSnapshot(), { windowMs: windowMs(), sampleRate: summary.sampleRate });
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
  source = new SyntheticPcmSource({ scenario: controls.scenario.value, speed: sourceSpeed() });
  sourceStatus = Object.freeze({ source: source.kind, state: "closed" });
  attachSource(source);
  afterActivity();
}

async function withUiError(action) {
  try { await action(); } catch (error) { adapter.handleError(error); }
}

controls.scenario.addEventListener("change", () => {
  if (source instanceof SyntheticPcmSource && source.state !== "open") source.setScenario(controls.scenario.value);
});
controls.speed.addEventListener("change", () => {
  if (source?.setSpeed) source.setSpeed(sourceSpeed());
});
controls.window.addEventListener("change", () => { afterActivity(); });
controls.open.addEventListener("click", () => {
  void withUiError(async () => {
    if (source instanceof SyntheticPcmSource) source.setScenario(controls.scenario.value);
    await source.open();
  });
});
controls.start.addEventListener("click", () => { void withUiError(() => source.start()); });
controls.stop.addEventListener("click", () => { void withUiError(() => source.stop()); });
controls.close.addEventListener("click", () => { void withUiError(() => source.close()); });

window.addEventListener("error", (event) => {
  adapter.handleError(event.error || event.message || "window error");
});
window.addEventListener("unhandledrejection", (event) => {
  adapter.handleError(event.reason || "unhandled rejection");
});

Object.defineProperty(window, "__pcmAudioSpikeDiagnostics", {
  configurable: true,
  value: Object.freeze({
    get model() { return model.summary(); },
    get session() { return adapter.summary(); },
    get errors() { return adapter.diagnostics(); },
    get source() { return Object.freeze({ kind: source?.kind || "none", state: sourceStatus.state }); },
    get frames() { return model.frameSnapshot(); },
    get markers() { return model.markerSnapshot(); },
    get windowMs() { return windowMs(); },
  }),
});

async function bootstrap() {
  const query = new URLSearchParams(location.search);
  const requestedScenario = query.get("scenario");
  if (PCM_SYNTHETIC_SCENARIOS.some((item) => item.id === requestedScenario)) controls.scenario.value = requestedScenario;
  await replaceSource();
  if (query.get("autostart") === "1") {
    await source.open();
    await source.start();
  }
}

void withUiError(bootstrap);
