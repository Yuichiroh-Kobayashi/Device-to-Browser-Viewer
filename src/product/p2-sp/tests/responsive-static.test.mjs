import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAnimationFrameQueue, createBoundedActionDiagnostics, createPresentationCoordinator } from "../presentation/mode-controller.js";
import { studentActionEnabled } from "../presentation/student-view.js";
import { professionalMarkup } from "../presentation/professional-view.js";
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const student = readFileSync(new URL("../presentation/student-view.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const openDeployment = Object.freeze({ startAllowed: true });
const blockedDeployment = Object.freeze({ startAllowed: false });
const state = (controlState, pending = {}) => ({ controlState, startPending: false, stopPending: false, ...pending });

assert.match(html, /viewport/);
assert.match(css, /@media\s*\(max-width:\s*599px\)[\s\S]*?\.graphs\s*\{\s*grid-template-columns:\s*1fr;/);
assert.match(css, /@media\s*\(min-width:\s*600px\)\s*and\s*\(max-width:\s*1023px\)[\s\S]*?\.values\s*\{\s*flex-wrap:\s*nowrap;[\s\S]*?\.graphs\s*\{\s*grid-template-columns:\s*1fr;/);
assert.match(css, /@media\s*\(min-width:\s*1024px\)[\s\S]*?\.graphs\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
assert.match(css, /min-height:\s*44px/);
assert.match(css, /focus-visible/);
assert.match(css, /prefers-reduced-motion/);
assert.match(css, /\.graph-panel canvas[\s\S]*?width:\s*100%[\s\S]*?height:\s*18rem/);
assert.match(student, /data-live="deployment"/);
assert.match(student, /<canvas data-waveform="voltage"/);
assert.match(student, /<canvas data-waveform="current"/);
assert.doesNotMatch(student, /Voltage graph: device-time axis|Current graph: device-time axis/);
assert.match(student, /deploymentNode\.dataset\.deploymentStatus/);
assert.match(student, /deployment\.message/);
assert.match(student, /data-action="\$\{action\}"/);
assert.match(student, /state\.controlState === "CLOSED"/);
assert.match(student, /state\.controlState === "READY"/);
assert.match(student, /state\.controlState === "STREAMING"/);
assert.match(student, /deployment\.startAllowed/);
assert.equal(studentActionEnabled(state("CLOSED"), openDeployment, "open"), true);
assert.equal(studentActionEnabled(state("CLOSED"), openDeployment, "start"), false);
assert.equal(studentActionEnabled(state("CLOSED"), openDeployment, "close"), false);
assert.equal(studentActionEnabled(state("READY"), openDeployment, "start"), true);
assert.equal(studentActionEnabled(state("READY"), blockedDeployment, "start"), false);
assert.equal(studentActionEnabled(state("READY"), blockedDeployment, "close"), true);
assert.equal(studentActionEnabled(state("STREAMING"), openDeployment, "stop"), true);
assert.equal(studentActionEnabled(state("STREAMING"), openDeployment, "close"), false);
assert.equal(studentActionEnabled(state("CONNECTED"), openDeployment, "open"), false);
assert.equal(studentActionEnabled(state("READY", { startPending: true }), openDeployment, "close"), false);
assert.equal(studentActionEnabled(state("READY", { startPending: true }), openDeployment, "start"), false);
assert.equal(studentActionEnabled(state("STREAMING", { stopPending: true }), openDeployment, "close"), false);
assert.equal(studentActionEnabled(state("STREAMING", { stopPending: true }), openDeployment, "stop"), false);
assert.match(app, /await owner\.actions\[action\]\(\);/);
assert.match(app, /owner\.subscribe\(\(\) => presentation\.update\(\)\)/);
assert.doesNotMatch(app, /owner\.subscribe\(\(\) => controller\.setMode/);
assert.doesNotMatch(app, /pointerdown|mousedown|debounce|retry/i);
let mountedControl = null;
let mountCount = 0;
let updateCount = 0;
const stablePresentation = createPresentationCoordinator({
  mount() { mountCount += 1; mountedControl = Object.freeze({ identity: mountCount }); },
  update() { updateCount += 1; },
});
stablePresentation.setMode("student");
const originalControl = mountedControl;
for (let frame = 0; frame < 20; frame += 1) stablePresentation.update();
assert.strictEqual(mountedControl, originalControl);
assert.equal(mountCount, 1);
assert.equal(updateCount, 21);
stablePresentation.setMode("professional");
assert.notStrictEqual(mountedControl, originalControl);
assert.equal(mountCount, 2);
const diagnostics = createBoundedActionDiagnostics(8);
for (let index = 0; index < 20; index += 1) diagnostics.record(index % 2 ? "stop" : "not-a-public-action");
assert.deepEqual(diagnostics.snapshot(), {
  count: 20,
  lastAction: "stop",
  retained: ["unknown", "stop", "unknown", "stop", "unknown", "stop", "unknown", "stop"],
});
const queuedFrames = [];
const cancelledFrames = [];
let graphRenderCount = 0;
let nextFrameHandle = 1;
const graphQueue = createAnimationFrameQueue({
  requestAnimationFrame(callback) { queuedFrames.push(callback); return nextFrameHandle++; },
  cancelAnimationFrame(handle) { cancelledFrames.push(handle); },
}, () => { graphRenderCount += 1; });
for (let frame = 0; frame < 20; frame += 1) graphQueue.request();
assert.equal(queuedFrames.length, 1);
assert.equal(graphRenderCount, 0);
queuedFrames.shift()();
assert.equal(graphRenderCount, 1);
assert.equal(graphQueue.isPending, false);
graphQueue.request();
graphQueue.cancel();
assert.deepEqual(cancelledFrames, [2]);

class TraceContext {
  constructor() { this.path = []; this.strokes = []; this.rects = []; this.text = []; }
  setTransform() {}
  clearRect() {}
  fillRect(x, y, width, height) { this.rects.push({ style: this.fillStyle, x, y, width, height }); }
  fillText(value) { this.text.push(String(value)); }
  beginPath() { this.path = []; }
  moveTo(x, y) { this.path.push({ kind: "move", x, y }); }
  lineTo(x, y) { this.path.push({ kind: "line", x, y }); }
  stroke() { this.strokes.push({ style: this.strokeStyle, path: this.path.map((entry) => ({ ...entry })) }); }
  setLineDash() {}
  save() {}
  translate() {}
  rotate() {}
  restore() {}
}
class TraceCanvas {
  constructor() { this.context = new TraceContext(); this.width = 0; this.height = 0; }
  getContext() { return this.context; }
  getBoundingClientRect() { return { width: 640, height: 300 }; }
}
globalThis.HTMLCanvasElement = TraceCanvas;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
const { WaveformCanvas } = await import("../../source-export/viewer/src/render/waveform-canvas.js");
const record = ({ timestamp, voltage, current, segment = 1, voltageSegment = 1, currentSegment = 1 }) => ({
  stream_id: 1,
  timestamp_us: BigInt(timestamp),
  voltage_V: voltage,
  current_A: current,
  segment_id: segment,
  voltage_segment_id: voltage === null ? null : voltageSegment,
  current_segment_id: current === null ? null : currentSegment,
});
function traceFor(canvas, style) { return canvas.context.strokes.findLast((stroke) => stroke.style === style); }
const zeroRecords = [
  record({ timestamp: 0, voltage: 0, current: 0 }),
  record({ timestamp: 40_000, voltage: 0, current: 0 }),
];
const zeroVoltageCanvas = new TraceCanvas();
new WaveformCanvas(zeroVoltageCanvas, { channel: "voltage", unit: "V", title: "Voltage" }).draw(zeroRecords, []);
const zeroVoltageTrace = traceFor(zeroVoltageCanvas, "#6dd6ff");
assert.deepEqual(zeroVoltageTrace.path.map((entry) => entry.kind), ["move", "line"]);
assert.equal(zeroVoltageTrace.path[0].y, zeroVoltageTrace.path[1].y);
assert.equal(zeroVoltageCanvas.context.text.includes("No finite valid device measurements in window"), false);
const zeroCurrentCanvas = new TraceCanvas();
new WaveformCanvas(zeroCurrentCanvas, { channel: "current", unit: "A", title: "Current" }).draw(zeroRecords, []);
const zeroCurrentTrace = traceFor(zeroCurrentCanvas, "#87f4b4");
assert.deepEqual(zeroCurrentTrace.path.map((entry) => entry.kind), ["move", "line"]);
assert.equal(zeroCurrentTrace.path[0].y, zeroCurrentTrace.path[1].y);
const nonzeroCanvas = new TraceCanvas();
new WaveformCanvas(nonzeroCanvas, { channel: "voltage", unit: "V", title: "Voltage" }).draw([
  record({ timestamp: 0, voltage: 0, current: 0 }),
  record({ timestamp: 40_000, voltage: 2, current: 0 }),
], []);
const nonzeroTrace = traceFor(nonzeroCanvas, "#6dd6ff");
assert.notEqual(nonzeroTrace.path[0].y, nonzeroTrace.path[1].y);
const gapCanvas = new TraceCanvas();
new WaveformCanvas(gapCanvas, { channel: "voltage", unit: "V", title: "Voltage" }).draw([
  record({ timestamp: 0, voltage: 1, current: 0, segment: 1, voltageSegment: 1 }),
  record({ timestamp: 40_000, voltage: 2, current: 0, segment: 2, voltageSegment: 2 }),
], []);
assert.deepEqual(traceFor(gapCanvas, "#6dd6ff").path.map((entry) => entry.kind), ["move", "move"]);
const invalidCanvas = new TraceCanvas();
new WaveformCanvas(invalidCanvas, { channel: "voltage", unit: "V", title: "Voltage" }).draw([
  record({ timestamp: 0, voltage: 1, current: 0, voltageSegment: 1 }),
  record({ timestamp: 40_000, voltage: null, current: 0 }),
  record({ timestamp: 80_000, voltage: 2, current: 0, voltageSegment: 2 }),
], []);
assert.deepEqual(traceFor(invalidCanvas, "#6dd6ff").path.map((entry) => entry.kind), ["move", "move"]);
assert.equal(invalidCanvas.context.rects.some((entry) => entry.style === "#d67eff"), true);
const professionalError = professionalMarkup({
  adapter: { summary: () => ({ controlState: "READY", streamId: null, profile: null, diagnosticCount: 1, lastError: { code: "c".repeat(97), message: "m".repeat(513) } }) },
  model: { latest: null, sampleCount: 0, segmentCount: 0, sequenceGapCount: 0, producerOverflowCount: 0, outputQueueDropCount: 0 },
}, { target: "device-hosted", bundleStatus: "matched" });
assert.match(professionalError, /<dt>last error code\/message<\/dt><dd data-live="last-error">c{96} \/ m{512}<\/dd>/);
assert.doesNotMatch(professionalError, /c{97}|m{513}/);
const hostileProfessionalError = professionalMarkup({
  adapter: { summary: () => ({ controlState: "READY", streamId: null, profile: null, diagnosticCount: 1, lastError: { code: "&<>\"'", message: "<img src=x onerror=alert(1)>&\"'" } }) },
  model: { latest: null, sampleCount: 0, segmentCount: 0, sequenceGapCount: 0, producerOverflowCount: 0, outputQueueDropCount: 0 },
}, { target: "device-hosted", bundleStatus: "matched" });
assert.match(hostileProfessionalError, /<dt>last error code\/message<\/dt><dd data-live="last-error">&amp;&lt;&gt;&quot;&#39; \/ &lt;img src=x onerror=alert\(1\)&gt;&amp;&quot;&#39;<\/dd>/);
assert.doesNotMatch(hostileProfessionalError, /<img\b/);
console.log("PASS responsive compact<=599, medium=600..1023, wide>=1024, Student deployment/action markup, focus, and reduced-motion rules");
