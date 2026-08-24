import { PcmAudioModel } from "./pcm-audio-model.js";
import { PcmSessionAdapter } from "./pcm-session-adapter.js";
import { PcmWaveformCanvas, flattenWindow } from "./pcm-waveform-canvas.js";
import {
  buildPcmScenarioPlan, makeHelloText, makeWelcomeText, PCM_SYNTHETIC_SCENARIOS,
} from "./synthetic-pcm-source.js";
import { PCM_PARAMETERS } from "../../protocol/d2b-reference/protocol-constants.js";

const results = document.getElementById("results");
const totals = document.getElementById("totals");

function assert(condition, detail = "assertion failed") {
  if (!condition) throw new Error(detail);
}

function equal(actual, expected, detail = "") {
  assert(Object.is(actual, expected), `${detail} expected ${String(expected)}, got ${String(actual)}`);
}

function readyAdapter() {
  const model = new PcmAudioModel();
  const adapter = new PcmSessionAdapter(model);
  adapter.notifyTransportStatus({ state: "open" });
  assert(adapter.handleControl({ direction: "client_to_server", text: makeHelloText() }), "hello rejected");
  assert(adapter.handleControl({ direction: "server_to_client", text: makeWelcomeText() }), "welcome rejected");
  return { model, adapter };
}

function driveScenario(scenarioId) {
  const { model, adapter } = readyAdapter();
  let rejectedCount = 0;
  for (const event of buildPcmScenarioPlan(scenarioId)) {
    if (event.kind === "transport") {
      adapter.notifyTransportStatus({ state: event.state });
    } else if (event.kind === "control") {
      assert(adapter.handleControl({ direction: event.direction, text: event.text }), `${scenarioId} control rejected`);
    } else if (!adapter.handleBinary(event.buffer)) {
      rejectedCount += 1;
    }
  }
  return { model, adapter, rejectedCount };
}

function countZeroCrossings(samples) {
  let crossings = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) crossings += 1;
  }
  return crossings;
}

function makeCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 200;
  document.body.append(canvas);
  return canvas;
}

function nonBackgroundPixelCount(canvas, backgroundHex = "#0e1721") {
  const context = canvas.getContext("2d");
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const bg = { r: parseInt(backgroundHex.slice(1, 3), 16), g: parseInt(backgroundHex.slice(3, 5), 16), b: parseInt(backgroundHex.slice(5, 7), 16) };
  let differing = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (Math.abs(data[index] - bg.r) > 6 || Math.abs(data[index + 1] - bg.g) > 6 || Math.abs(data[index + 2] - bg.b) > 6) differing += 1;
  }
  return differing;
}

const tests = [
  ["all 10 pcm scenarios are enumerated", () => {
    equal(PCM_SYNTHETIC_SCENARIOS.length, 10);
  }],

  ["A1 440 Hz: full plan decodes through the real reference decoder with zero rejections and the canvas actually paints data", () => {
    const { model, rejectedCount } = driveScenario("a1-sine-440");
    equal(rejectedCount, 0, "no rejections expected in A1");
    equal(model.summary().frameCount, 20);
    const canvas = makeCanvas();
    const renderer = new PcmWaveformCanvas(canvas, { title: "A1" });
    renderer.draw(model.frameSnapshot(), model.markerSnapshot(), { windowMs: 20, sampleRate: PCM_PARAMETERS.sample_rate });
    const painted = nonBackgroundPixelCount(canvas);
    assert(painted > 200, `expected the canvas to visibly paint the waveform, got ${painted} differing pixels`);
    renderer.destroy();
  }],

  ["A2 880 Hz visibly differs from A1 440 Hz: both the retained sample buffer and the rendered pixels differ", () => {
    const a1 = driveScenario("a1-sine-440");
    const a2 = driveScenario("a2-sine-880");
    const flat440 = a1.model.frameSnapshot().flatMap((frame) => Array.from(frame.samples));
    const flat880 = a2.model.frameSnapshot().flatMap((frame) => Array.from(frame.samples));
    const ratio = countZeroCrossings(flat880) / countZeroCrossings(flat440);
    assert(ratio > 1.7 && ratio < 2.3, `expected ~2x zero crossings for 880 Hz vs 440 Hz, got ${ratio}`);

    const canvas440 = makeCanvas();
    const canvas880 = makeCanvas();
    new PcmWaveformCanvas(canvas440, { title: "440" }).draw(a1.model.frameSnapshot(), [], { windowMs: 20, sampleRate: PCM_PARAMETERS.sample_rate });
    new PcmWaveformCanvas(canvas880, { title: "880" }).draw(a2.model.frameSnapshot(), [], { windowMs: 20, sampleRate: PCM_PARAMETERS.sample_rate });
    const data440 = canvas440.getContext("2d").getImageData(0, 0, canvas440.width, canvas440.height).data;
    const data880 = canvas880.getContext("2d").getImageData(0, 0, canvas880.width, canvas880.height).data;
    let differingPixels = 0;
    for (let index = 0; index < data440.length; index += 4) {
      if (data440[index] !== data880[index] || data440[index + 1] !== data880[index + 1]) differingPixels += 1;
    }
    assert(differingPixels > 50, `expected visibly different waveform renders, got ${differingPixels} differing pixels`);
  }],

  ["A5 gap is not bridged: flattenWindow marks the post-gap point breakBefore and a sequence-gap marker exists", () => {
    const { model } = driveScenario("a5-gap-discontinuity");
    const summary = model.summary();
    equal(summary.sequenceGapCount, 1);
    const points = flattenWindow(model.frameSnapshot(), { windowMs: 5000, sampleRate: PCM_PARAMETERS.sample_rate });
    const breakPoints = points.filter((point) => point.breakBefore);
    assert(breakPoints.length >= 1, "expected at least one contiguity break at the gap boundary");
    const marker = model.markerSnapshot().find((entry) => entry.kind === "sequence-gap");
    assert(marker, "expected a sequence-gap marker");
    // Render it: this must not throw and must still paint (broken lines, not a crash).
    const canvas = makeCanvas();
    new PcmWaveformCanvas(canvas, { title: "A5" }).draw(model.frameSnapshot(), model.markerSnapshot(), { windowMs: 5000, sampleRate: PCM_PARAMETERS.sample_rate });
  }],

  ["A9 new epoch is never joined to the old one, at both the model and the renderer's contiguity check", () => {
    const { model } = driveScenario("a9-timebase-reset");
    const frames = model.frameSnapshot();
    assert(frames.length > 0, "expected retained post-reset frames");
    const streamIds = new Set(frames.map((frame) => frame.stream_id));
    equal(streamIds.size, 1, "the pre-reset stream must not remain in the retained ring");
    equal([...streamIds][0], 2);

    // Directly probe the renderer's contiguity guard with two frames from
    // different epochs to prove flattenWindow itself would refuse to bridge
    // them, independent of the model already having cleared the viewport.
    const frameA = frames[0];
    const frameB = { ...frameA, epoch_id: frameA.epoch_id + 1, segment_id: frameA.segment_id + 1, timestamp_us: frameA.timestamp_us + 1_000_000n };
    const points = flattenWindow([frameA, frameB], { windowMs: 5000, sampleRate: PCM_PARAMETERS.sample_rate });
    const firstOfB = points.find((point, index) => index > 0 && point.timestamp_us >= frameB.timestamp_us);
    assert(firstOfB && firstOfB.breakBefore, "a differing epoch_id/segment_id must force a render break");
  }],

  ["A10 malformed frame is rejected by the real decoder and never mutates the retained model (transactional)", () => {
    const { model, rejectedCount } = driveScenario("a10-invalid-frame");
    equal(rejectedCount, 1, "exactly the one injected bad-magic duplicate must be rejected");
    equal(model.summary().frameCount, 20, "all 20 legitimate frames must still be accepted, unaffected by the rejection");
  }],

  ["window selection changes what is rendered without altering retained samples", () => {
    const { model } = driveScenario("a1-sine-440");
    const before = model.frameSnapshot().map((frame) => Array.from(frame.samples));
    const shortWindow = flattenWindow(model.frameSnapshot(), { windowMs: 10, sampleRate: PCM_PARAMETERS.sample_rate });
    const longWindow = flattenWindow(model.frameSnapshot(), { windowMs: 100, sampleRate: PCM_PARAMETERS.sample_rate });
    assert(longWindow.length > shortWindow.length, "a wider window must include more points");
    const after = model.frameSnapshot().map((frame) => Array.from(frame.samples));
    assert(JSON.stringify(before) === JSON.stringify(after), "windowing must never mutate retained sample values");
  }],
];

let pass = 0;
let fail = 0;
for (const [name, run] of tests) {
  const item = document.createElement("li");
  try {
    run();
    pass += 1;
    item.className = "pass";
    item.textContent = `PASS - ${name}`;
  } catch (error) {
    fail += 1;
    item.className = "fail";
    item.textContent = `FAIL - ${name}: ${error?.message || error}`;
  }
  results.append(item);
}
totals.textContent = `TOTAL: ${tests.length} PASS: ${pass} FAIL: ${fail}`;

const consoleErrors = Array.isArray(window.__consoleErrors) ? window.__consoleErrors : [];
document.getElementById("console-errors").textContent = `CONSOLE_ERRORS: ${consoleErrors.length}`;
const consoleErrorsList = document.getElementById("console-errors-list");
for (const message of consoleErrors) {
  const item = document.createElement("li");
  item.textContent = message;
  consoleErrorsList.append(item);
}
