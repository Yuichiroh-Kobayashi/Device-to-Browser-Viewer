import assert from "node:assert/strict";
import test from "node:test";
import { createViewerApplication } from "../app.js";
import { createRuntimeOwner } from "../runtime-owner.js";
import { professionalMarkup } from "../presentation/professional-view.js";
import { makeStartedText, makeStoppedText, makeStreamEndFrame, makeWelcomeText } from "../../source-export/viewer/src/sources/synthetic-source.js";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Physical-review polish item 3: Professional now shows the same common
 * measurement workspace as Student -- header, Start/Stop, value panels, both
 * graphs -- ahead of its own diagnostics, through the one shared
 * StudentPrimaryActionController transaction path. These tests cover the two
 * properties the physical review asked for explicitly: workspace-before-
 * diagnostics ordering, and exactly-one-transaction parity with Student.
 */

let sockets = [];
globalThis.WebSocket = class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
  send(text) { this.sent.push(text); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  message(data) { this.onmessage?.({ data }); }
  disconnect() { this.readyState = 3; this.onclose?.(); }
};
const controls = (socket, type) => socket.sent.filter((text) => JSON.parse(text).type === type);
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });

class FakeNode {
  constructor(tag, attributes) {
    this.tag = tag; this.attributes = attributes; this.parent = null; this.children = [];
    this.textContent = ""; this.hidden = false; this.disabled = false; this.onclick = null; this.onchange = null;
    this.dataset = {};
    for (const [name, value] of Object.entries(attributes)) {
      if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
    if (tag === "canvas") { this.width = 0; this.height = 0; this.context = { getContext: () => this.context, measureText: (t) => ({ width: String(t).length * 5 }) }; for (const name of ["setTransform", "clearRect", "fillRect", "fillText", "beginPath", "moveTo", "lineTo", "stroke", "setLineDash", "save", "translate", "rotate", "restore", "clip", "rect"]) this.context[name] = () => {}; }
    if (tag === "select") this.value = attributes.value ?? "";
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  getContext() { return this.context; }
  getBoundingClientRect() { return { width: 640, height: 288 }; }
  matches(selector) {
    const id = /^#([\w-]+)$/.exec(selector); if (id) return this.attributes.id === id[1];
    const withValue = /^\[([\w-]+)="([^"]*)"\]$/.exec(selector); if (withValue) return this.attributes[withValue[1]] === withValue[2];
    const bare = /^\[([\w-]+)\]$/.exec(selector); if (bare) return bare[1] in this.attributes;
    const cls = /^\.([\w-]+)$/.exec(selector); if (cls) return (this.attributes.class ?? "").split(/\s+/).includes(cls[1]);
    throw new Error(`test DOM does not implement selector ${selector}`);
  }
  descendants() { const out = []; const walk = (node) => { for (const child of node.children) { out.push(child); walk(child); } }; walk(this); return out; }
  querySelector(selector) { return this.descendants().find((node) => node.matches(selector)) ?? null; }
  set innerHTML(html) {
    this.children = [];
    const stack = [this];
    for (const [, closing, tag, rawAttributes] of html.matchAll(/<(\/?)([a-z0-9]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/gi)) {
      if (closing) { if (stack.length > 1) stack.pop(); continue; }
      const attributes = {};
      for (const [, name, value] of rawAttributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) if (name) attributes[name] = value ?? "";
      const node = new FakeNode(tag.toLowerCase(), attributes);
      node.parent = stack.at(-1); stack.at(-1).children.push(node); stack.push(node);
    }
    this._html = html;
  }
  get innerHTML() { return this._html ?? ""; }
}

function fakeMedia(matches = false) {
  return { matches, addEventListener() {}, removeEventListener() {} };
}

function manualFrames() {
  const queue = [];
  return {
    requestAnimationFrame(callback) { queue.push(callback); return queue.length; },
    cancelAnimationFrame() {},
    flush() { const pending = queue.splice(0, queue.length); for (const callback of pending) callback(); return pending.length; },
  };
}

function buildApplication() {
  const root = new FakeNode("main", { id: "viewer" });
  const documentElement = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const owner = createRuntimeOwner();
  const application = createViewerApplication({
    root, owner, includeProfessional: true,
    pageLocation: { protocol: "http:", host: "127.0.0.1:8080", href: "http://127.0.0.1:8080/" },
    animationScheduler: manualFrames(), themeMedia: fakeMedia(false), themeRoot: documentElement,
  });
  return { root, owner, application };
}

test("professionalMarkup places the shared measurement workspace ahead of its own diagnostics", () => {
  const owner = { adapter: { summary: () => ({ controlState: "READY", streamId: null, profile: null, diagnosticCount: 0, lastError: null }) }, source: { state: "open" }, model: { latest: null, sampleCount: 0, segmentCount: 0, summary: () => ({ sequenceGapCount: 0, sequenceGapSamples: "0", producerOverflowCount: 0, outputQueueDropCount: 0, invalidVoltageCount: 0, invalidCurrentCount: 0, viewerEvictionCount: 0, viewerWindowEvictionCount: 0, viewerCapacityEvictionCount: 0, bufferUsage: 0, bufferCapacity: 4096, markerUsage: 0, markerCapacity: 512 }) } };
  const markup = professionalMarkup(owner, { target: "device-hosted", bundleStatus: "matched" }, "dummy label");
  const primaryActionAt = markup.indexOf("data-student-primary-action");
  const graphsAt = markup.indexOf("data-student-graphs");
  const diagnosticsAt = markup.indexOf("Professional diagnostics");
  assert.ok(primaryActionAt >= 0 && graphsAt >= 0 && diagnosticsAt >= 0, "all three markers must be present");
  assert.ok(primaryActionAt < diagnosticsAt, "Start/Stop must precede the diagnostics section");
  assert.ok(graphsAt < diagnosticsAt, "the graphs must precede the diagnostics section");
  assert.match(markup, /class="professional-diagnostics"/, "diagnostics must be their own section, not the whole professional wrapper");
});

test("Professional always shows both graphs regardless of Student's device display_name policy", () => {
  const root = new FakeNode("main", { id: "viewer" });
  const owner = createRuntimeOwner();
  const documentElement = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const application = createViewerApplication({
    root, owner, includeProfessional: true, deploymentTarget: "device-hosted",
    pageLocation: { protocol: "http:", host: "127.0.0.1:8080", href: "http://127.0.0.1:8080/" },
    animationScheduler: manualFrames(), themeMedia: fakeMedia(false), themeRoot: documentElement,
  });
  application.controller.setMode("professional");
  application.presentation.update();
  assert.equal(root.querySelector('[data-graph-panel="voltage"]').hidden, false, "Professional must show the Voltage graph even under a Voltage-only-suggesting deployment");
  assert.equal(root.querySelector('[data-graph-panel="current"]').hidden, false, "Professional must show the Current graph even under a Voltage-only-suggesting deployment");
  application.destroy();
});

test("Professional Start: exactly one transaction, the same shared control as Student", async () => {
  sockets = [];
  const { root, owner, application } = buildApplication();
  application.controller.setMode("professional");
  application.presentation.update();
  const button = root.querySelector("[data-student-primary-action]");
  assert.ok(button, "Professional must expose the same [data-student-primary-action] control as Student");

  const starting = button.onclick();
  // A synchronous second click while the first activation is already in
  // flight must be guarded -- the same in-flight guard Student's shared
  // control relies on -- so it can never send a second command.
  const duplicate = button.onclick();
  assert.equal(sockets.length, 1, "one activation from CLOSED must open exactly one transport, even with a concurrent duplicate click");
  const socket = sockets[0];
  socket.open();
  await turn();
  assert.equal(controls(socket, "hello").length, 1);
  assert.equal(controls(socket, "start_stream").length, 0, "no start command yet -- still waiting for welcome");
  socket.message(makeWelcomeText());
  await turn();
  assert.equal(owner.adapter.summary().controlState, "READY");
  assert.equal(controls(socket, "start_stream").length, 1, "exactly one start command for one Professional activation, despite the duplicate click");
  socket.message(makeStartedText(9, "live-vi"));
  await starting;
  await duplicate;
  assert.equal(owner.adapter.summary().controlState, "STREAMING");
  assert.equal(owner.adapter.summary().streamId, 9);
  assert.equal(sockets.length, 1, "no second transport was opened for this single activation");
  assert.equal(controls(socket, "start_stream").length, 1, "the duplicate click never produced a second start command");
  application.destroy();
});

test("Professional Stop: exactly one transaction, the same shared control as Student", async () => {
  sockets = [];
  const { root, owner, application } = buildApplication();
  application.controller.setMode("professional");
  application.presentation.update();
  const button = root.querySelector("[data-student-primary-action]");

  // Reach STREAMING first, through the real shared Start path proven above.
  const starting = button.onclick();
  const socket = sockets[0];
  socket.open();
  await turn();
  socket.message(makeWelcomeText());
  await turn();
  socket.message(makeStartedText(11, "live-vi"));
  await starting;
  assert.equal(owner.adapter.summary().controlState, "STREAMING");
  assert.equal(controls(socket, "start_stream").length, 1);

  // A synchronous second click while the Stop activation is already in
  // flight is the technically meaningful case for the in-flight guard here
  // (unlike Start, Stop's own owner.actions.stop() sends its control message
  // synchronously, before any await, so the duplicate click lands while the
  // first activation is provably still in progress).
  const stopping = button.onclick();
  const duplicateStop = button.onclick();
  assert.equal(controls(socket, "stop_stream").length, 1, "exactly one stop command for one Professional Stop activation, despite the duplicate click");
  socket.message(makeStreamEndFrame({ streamId: 11, sequence: 1n, timestampUs: 1n }));
  socket.message(makeStoppedText(11));
  await stopping;
  await duplicateStop;
  await turn();
  // This activation opened its own transport (CLOSED -> Start), so -- exactly
  // as for Student in the equivalent case (see
  // student-primary-action-integration.test.mjs, "real CLOSED Start waits for
  // welcome and real Student-owned Stop closes once") -- Stop also closes the
  // transport it opened, settling in CLOSED rather than READY.
  assert.equal(socket.readyState, 3, "the transport Professional's Stop opened must be closed, same as Student's equivalent case");
  socket.disconnect();
  assert.equal(owner.adapter.summary().controlState, "CLOSED", "Professional Stop must settle to the same non-streaming state as Student's equivalent (self-opened) case");
  assert.equal(sockets.length, 1, "no second transport was opened for Stop");
  assert.equal(controls(socket, "stop_stream").length, 1, "the duplicate click never produced a second stop command");
  application.destroy();
});
