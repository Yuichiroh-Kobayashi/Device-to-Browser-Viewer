import assert from "node:assert/strict";
import test from "node:test";
import { createViewerApplication } from "../app.js";
import { createRuntimeOwner } from "../runtime-owner.js";
import { studentMarkup } from "../presentation/student-view.js";
import { makeStartedText, makeViFrame, makeWelcomeText } from "../../source-export/viewer/src/sources/synthetic-source.js";

/**
 * Issue #9 lifecycle isolation, exercised through the real application.
 *
 * Every assertion here answers one question: can a theme change touch anything
 * that is not presentation? Transport counters, parser acceptance, stream
 * identity, the display window and the mounted control node are all captured
 * either side of a toggle.
 */

const counts = { constructor: 0, send: 0, close: 0 };
const sockets = [];
globalThis.WebSocket = class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor() { counts.constructor += 1; this.readyState = 0; sockets.push(this); }
  send() { counts.send += 1; }
  close() { counts.close += 1; this.readyState = 3; this.onclose?.(); }
  driveOpen() { this.readyState = 1; this.onopen?.(); }
  driveMessage(data) { this.onmessage?.({ data }); }
};
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

// ---------------------------------------------------------------------------
// Minimal DOM sufficient for the application's own queries.
// ---------------------------------------------------------------------------

const VOID_CONTEXT_METHODS = ["setTransform", "clearRect", "fillRect", "fillText", "beginPath", "moveTo", "lineTo", "stroke", "setLineDash", "save", "translate", "rotate", "restore", "clip", "rect"];

function createContext(canvas) {
  const context = { canvas, calls: [], strokeStyles: [], fillStyles: [] };
  for (const name of VOID_CONTEXT_METHODS) {
    context[name] = (...args) => {
      context.calls.push(name);
      if (name === "stroke") context.strokeStyles.push(context.strokeStyle);
      if (name === "fillRect" || name === "fillText") context.fillStyles.push(context.fillStyle);
      void args;
    };
  }
  context.measureText = (text) => ({ width: String(text).length * 5 });
  return context;
}

class FakeNode {
  constructor(tag, attributes) {
    this.tag = tag;
    this.attributes = attributes;
    this.parent = null;
    this.children = [];
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.onclick = null;
    this.onchange = null;
    this.dataset = {};
    for (const [name, value] of Object.entries(attributes)) {
      if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
    if (tag === "canvas") { this.width = 0; this.height = 0; this.context = createContext(this); }
    if (tag === "select") this.value = attributes.value ?? "";
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  getContext() { return this.context; }
  getBoundingClientRect() { return { width: 640, height: 288 }; }
  matches(selector) {
    const id = /^#([\w-]+)$/.exec(selector);
    if (id) return this.attributes.id === id[1];
    const withValue = /^\[([\w-]+)="([^"]*)"\]$/.exec(selector);
    if (withValue) return this.attributes[withValue[1]] === withValue[2];
    const bare = /^\[([\w-]+)\]$/.exec(selector);
    if (bare) return bare[1] in this.attributes;
    throw new Error(`test DOM does not implement selector ${selector}`);
  }
  closest(selector) {
    for (let node = this; node; node = node.parent) if (node.matches?.(selector)) return node;
    return null;
  }
  descendants() {
    const out = [];
    const walk = (node) => { for (const child of node.children) { out.push(child); walk(child); } };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.descendants().find((node) => node.matches(selector)) ?? null; }
  set innerHTML(html) {
    this.children = [];
    const stack = [this];
    for (const [, closing, tag, rawAttributes] of html.matchAll(/<(\/?)([a-z0-9]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/gi)) {
      if (closing) { if (stack.length > 1) stack.pop(); continue; }
      const attributes = {};
      for (const [, name, value] of rawAttributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) if (name) attributes[name] = value ?? "";
      const node = new FakeNode(tag.toLowerCase(), attributes);
      node.parent = stack.at(-1);
      stack.at(-1).children.push(node);
      stack.push(node);
    }
    this._html = html;
  }
  get innerHTML() { return this._html ?? ""; }
}

// Token values resolved per effective theme, so a repaint after a toggle is
// observable in the colours the renderer actually asks for.
const TOKENS = {
  light: { background: "#ffffff", foreground: "#18212f", grid: "#8a8a8a", "zero-boundary": "#4a5666", "voltage-accent": "#005aff", "current-accent": "#8a5a00", gap: "#6a32c9", invalid: "#b3006b", segment: "#4a5666", muted: "#4a5666" },
  dark: { background: "#101821", foreground: "#dfeaff", grid: "#6b7a94", "zero-boundary": "#9eadbf", "voltage-accent": "#4dc4ff", "current-accent": "#f6aa00", gap: "#c58cff", invalid: "#ff8fb0", segment: "#9eadbf", muted: "#b9c6da" },
};

const documentElement = {
  attributes: {},
  setAttribute(name, value) { this.attributes[name] = value; },
};
globalThis.getComputedStyle = () => ({
  getPropertyValue(property) {
    const effective = documentElement.attributes["data-effective-theme"] ?? "light";
    return TOKENS[effective][property.replace("--graph-", "")] ?? "";
  },
});

function fakeMedia(matches = false) {
  const listeners = new Set();
  return {
    matches,
    addEventListener(type, listener) { listeners.add(listener); },
    removeEventListener(type, listener) { listeners.delete(listener); },
    setSystemPrefersDark(next) { this.matches = next; for (const listener of [...listeners]) listener({ matches: next }); },
  };
}

function manualFrames() {
  const queue = [];
  return {
    requestAnimationFrame(callback) { queue.push(callback); return queue.length; },
    cancelAnimationFrame() {},
    flush() { const pending = queue.splice(0, queue.length); for (const callback of pending) callback(); return pending.length; },
    get pending() { return queue.length; },
  };
}

function buildApplication({ systemPrefersDark = false } = {}) {
  const root = new FakeNode("main", { id: "viewer" });
  const media = fakeMedia(systemPrefersDark);
  const frames = manualFrames();
  documentElement.attributes = {};
  const owner = createRuntimeOwner();
  const application = createViewerApplication({
    root,
    owner,
    includeProfessional: true,
    pageLocation: { protocol: "http:", host: "127.0.0.1:8080", href: "http://127.0.0.1:8080/" },
    animationScheduler: frames,
    themeMedia: media,
    themeRoot: documentElement,
  });
  return { root, media, frames, owner, application };
}

/** Captures everything a theme change is forbidden to move. */
function runtimeFingerprint(owner) {
  const summary = owner.adapter.summary();
  return {
    constructor: counts.constructor, send: counts.send, close: counts.close,
    controlState: summary.controlState, streamId: summary.streamId, profile: summary.profile,
    displayWindowSeconds: owner.model.displayWindowSeconds,
    sampleCount: owner.model.sampleCount, segmentCount: owner.model.segmentCount,
    latest: owner.model.latest, records: owner.model.records.toArray().length,
    source: owner.source, model: owner.model, adapter: owner.adapter,
  };
}

async function driveToStreaming(owner) {
  const source = owner.requestLive();
  const opening = source.open();
  sockets.at(-1).driveOpen();
  await opening;
  sockets.at(-1).driveMessage(makeWelcomeText());
  await source.start();
  sockets.at(-1).driveMessage(makeStartedText(7, "live-vi"));
  sockets.at(-1).driveMessage(makeViFrame({ streamId: 7, sequence: 1n, timestampUs: 1000n, flags: 1, voltage: 3.3, current: 0.12 }));
  assert.equal(owner.adapter.summary().controlState, "STREAMING");
}

// ---------------------------------------------------------------------------

test("a fresh application mounts in system state and follows the browser preference", () => {
  const light = buildApplication({ systemPrefersDark: false });
  assert.equal(light.application.theme.state, "system");
  assert.equal(light.application.theme.effective, "light");
  assert.equal(documentElement.attributes["data-theme"], "system");
  assert.equal(documentElement.attributes["data-effective-theme"], "light");
  assert.equal(light.root.querySelector("[data-theme-toggle]").textContent, "");
  assert.equal(light.root.querySelector("[data-theme-toggle]").innerHTML, "");
  light.application.destroy();

  const dark = buildApplication({ systemPrefersDark: true });
  assert.equal(dark.application.theme.effective, "dark");
  assert.equal(documentElement.attributes["data-effective-theme"], "dark");
  // The mounted control offers the opposite theme, written to the label node
  // beside the (untouched) icon node, not to the button's own textContent.
  assert.match(dark.root.innerHTML, /data-theme-toggle-label>ライト表示 \/ Light mode</);
  dark.application.destroy();
});

test("clicking the mounted control alternates the theme and repaints without remounting", () => {
  const { root, frames, application } = buildApplication({ systemPrefersDark: false });
  frames.flush();
  const button = root.querySelector("[data-theme-toggle]");
  const icon = button.children[0];
  const label = root.querySelector("[data-theme-toggle-label]");
  const canvas = root.querySelector('[data-waveform="voltage"]');
  assert.equal(button.tag, "button");
  assert.equal(button.attributes.type, "button");
  assert.equal(icon.attributes["aria-hidden"], "true", "the decorative icon node must be aria-hidden");

  button.onclick();
  assert.equal(application.theme.state, "dark");
  // Only the label node is rewritten; the icon node beside it is never
  // replaced by a theme change (a whole-button textContent write would have
  // destroyed it).
  assert.equal(label.textContent, "ライト表示 / Light mode");
  assert.strictEqual(root.querySelector("[data-theme-toggle]"), button, "the control node must be relabelled, not replaced");
  assert.strictEqual(root.querySelector("[data-theme-toggle-label]"), label, "the label node must be relabelled, not replaced");
  assert.strictEqual(button.children[0], icon, "the icon node must survive a theme change");
  assert.strictEqual(root.querySelector('[data-waveform="voltage"]'), canvas, "a theme change must not remount the canvas");
  assert.equal(frames.pending, 1, "a theme change schedules exactly one repaint");
  frames.flush();
  assert.equal(canvas.context.fillStyles.includes("#101821"), true, "the canvas repaints on the dark ground");

  button.onclick();
  assert.equal(application.theme.state, "light");
  assert.equal(label.textContent, "ダーク表示 / Dark mode");
  assert.strictEqual(button.children[0], icon, "the icon node must survive a second theme change");
  button.onclick();
  assert.equal(application.theme.state, "dark");
  frames.flush();
  application.destroy();
});

test("theme changes move nothing in transport, parser, stream identity or display window", async () => {
  const { root, frames, owner, application } = buildApplication();
  const button = () => root.querySelector("[data-theme-toggle]");

  // CLOSED
  let before = runtimeFingerprint(owner);
  for (let click = 0; click < 4; click += 1) button().onclick();
  frames.flush();
  assert.deepEqual(runtimeFingerprint(owner), before, "a theme change during CLOSED moved runtime state");

  // READY
  const source = owner.requestLive();
  const opening = source.open();
  sockets.at(-1).driveOpen();
  await opening;
  sockets.at(-1).driveMessage(makeWelcomeText());
  assert.equal(owner.adapter.summary().controlState, "READY");
  frames.flush();
  before = runtimeFingerprint(owner);
  for (let click = 0; click < 4; click += 1) button().onclick();
  frames.flush();
  assert.deepEqual(runtimeFingerprint(owner), before, "a theme change during READY moved runtime state");

  // STREAMING, with a non-default display window selected.
  await source.start();
  sockets.at(-1).driveMessage(makeStartedText(7, "live-vi"));
  sockets.at(-1).driveMessage(makeViFrame({ streamId: 7, sequence: 1n, timestampUs: 1000n, flags: 1, voltage: 3.3, current: 0.12 }));
  assert.equal(owner.adapter.summary().controlState, "STREAMING");
  const displayWindow = root.querySelector("[data-display-window]");
  displayWindow.value = "10";
  displayWindow.onchange();
  assert.equal(owner.model.displayWindowSeconds, 10);
  frames.flush();
  before = runtimeFingerprint(owner);
  assert.equal(before.streamId, 7);
  for (let click = 0; click < 6; click += 1) button().onclick();
  frames.flush();
  const after = runtimeFingerprint(owner);
  assert.deepEqual(after, before, "a theme change during STREAMING moved runtime state");
  assert.equal(after.streamId, 7, "stream identity must survive a theme change");
  assert.equal(after.displayWindowSeconds, 10, "the 10/30/60 second window must survive a theme change");
  // 14 activations from system on a light-preferring system: odd lands on
  // dark, even lands back on light.
  assert.equal(application.theme.state, "light");
  assert.equal(application.theme.effective, "light");
  application.destroy();
});

test("live-frame updates never replace the mounted theme control", async () => {
  const { root, frames, owner, application } = buildApplication();
  await driveToStreaming(owner);
  frames.flush();
  const button = root.querySelector("[data-theme-toggle]");
  const label = root.querySelector("[data-theme-toggle-label]");
  button.onclick();
  frames.flush();
  const labelAfterToggle = label.textContent;

  for (let sequence = 2n; sequence < 40n; sequence += 1n) {
    sockets.at(-1).driveMessage(makeViFrame({ streamId: 7, sequence, timestampUs: sequence * 1000n, flags: 1, voltage: 3.3, current: 0.12 }));
  }
  frames.flush();
  assert.strictEqual(root.querySelector("[data-theme-toggle]"), button, "live frames replaced the theme control node");
  assert.strictEqual(root.querySelector("[data-theme-toggle-label]"), label, "live frames replaced the theme label node");
  assert.equal(label.textContent, labelAfterToggle, "live frames changed the theme control label");
  assert.equal(application.theme.state, "dark");
  assert.equal(documentElement.attributes["data-effective-theme"], "dark");
  application.destroy();
});

test("Student and Professional remounts preserve the page-lifetime theme", async () => {
  const { root, frames, owner, application } = buildApplication();
  await driveToStreaming(owner);
  frames.flush();
  root.querySelector("[data-theme-toggle]").onclick();
  frames.flush();
  assert.equal(application.theme.state, "dark");
  const before = runtimeFingerprint(owner);

  for (const mode of ["professional", "student", "professional", "student"]) {
    application.controller.setMode(mode);
    frames.flush();
    assert.equal(application.theme.state, "dark", `${mode} remount lost the theme state`);
    assert.equal(documentElement.attributes["data-effective-theme"], "dark");
    // The node is legitimately recreated by a remount; it must come back
    // carrying the retained theme, not a fresh system default.
    const button = root.querySelector("[data-theme-toggle]");
    assert.ok(button, `${mode} remount lost the theme control`);
    assert.equal(button.tag, "button");
    assert.match(root.innerHTML, /ライト表示 \/ Light mode/, `${mode} remount rebuilt the control with the wrong label`);
  }
  assert.deepEqual(runtimeFingerprint(owner), before, "mode switching plus theme state moved runtime state");

  // The retained explicit theme still alternates correctly after a remount.
  root.querySelector("[data-theme-toggle]").onclick();
  assert.equal(application.theme.state, "light");
  frames.flush();
  application.destroy();
});

test("a system preference change during streaming re-themes without touching the stream", async () => {
  const { root, frames, owner, media, application } = buildApplication({ systemPrefersDark: false });
  await driveToStreaming(owner);
  frames.flush();
  const before = runtimeFingerprint(owner);
  const button = root.querySelector("[data-theme-toggle]");
  const label = root.querySelector("[data-theme-toggle-label]");

  media.setSystemPrefersDark(true);
  assert.equal(application.theme.state, "system", "following the system must not become an explicit override");
  assert.equal(application.theme.effective, "dark");
  assert.equal(documentElement.attributes["data-effective-theme"], "dark");
  assert.equal(label.textContent, "ライト表示 / Light mode");
  assert.strictEqual(root.querySelector("[data-theme-toggle]"), button);
  frames.flush();
  assert.deepEqual(runtimeFingerprint(owner), before, "a system preference change moved runtime state");

  media.setSystemPrefersDark(false);
  assert.equal(application.theme.effective, "light");
  assert.equal(label.textContent, "ダーク表示 / Dark mode");
  frames.flush();
  application.destroy();
});

test("the real mounted primary control takes the Stop role while streaming", async () => {
  const { root, frames, owner, application } = buildApplication();
  const button = () => root.querySelector("[data-student-primary-action]");
  // CLOSED with a start-permitting deployment is already the Start role; the
  // markup's own default is the disabled role until the first update runs.
  assert.match(studentMarkup(), /data-action-kind="disabled" disabled/);
  assert.equal(button().dataset.actionKind, "start");

  const source = owner.requestLive();
  const opening = source.open();
  sockets.at(-1).driveOpen();
  await opening;
  sockets.at(-1).driveMessage(makeWelcomeText());
  frames.flush();
  assert.equal(owner.adapter.summary().controlState, "READY");
  assert.equal(button().dataset.actionKind, "start", "READY with a permitted deployment is the Start role");

  await source.start();
  sockets.at(-1).driveMessage(makeStartedText(7, "live-vi"));
  sockets.at(-1).driveMessage(makeViFrame({ streamId: 7, sequence: 1n, timestampUs: 1000n, flags: 1, voltage: 3.3, current: 0.12 }));
  frames.flush();
  assert.equal(owner.adapter.summary().controlState, "STREAMING");
  // The mounted node itself carries the Stop role, which is what the Stop
  // tokens are selected by.
  assert.equal(button().dataset.actionKind, "stop");
  assert.equal(button().textContent, "測定終了 / Stop");
  assert.equal(button().disabled, false);

  // A theme change must not disturb the action role.
  root.querySelector("[data-theme-toggle]").onclick();
  frames.flush();
  assert.equal(button().dataset.actionKind, "stop", "a theme change changed the action role");

  // The role survives a Professional round trip.
  application.controller.setMode("professional");
  frames.flush();
  application.controller.setMode("student");
  frames.flush();
  assert.equal(button().dataset.actionKind, "stop");
  application.destroy();
});

// The control lives inside the shared measurement header now (physical-review
// UI polish), not ahead of the workspace as a separate block; this test's
// title reflects that -- the assertions themselves already prove it, since
// the header the control is part of is the workspace's own first child.
test("the theme control (inside the shared header) precedes Start/Stop and the graph stack in document order", () => {
  const { root, application } = buildApplication();
  const html = root.innerHTML;
  assert.ok(html.indexOf("data-theme-toggle") < html.indexOf("data-student-primary-action"), "the header, and the theme control inside it, must precede the primary action in the document");
  assert.ok(html.indexOf("data-theme-toggle") < html.indexOf("data-student-graphs"), "the header, and the theme control inside it, must precede the graph stack");
  application.destroy();
});

test("destroying the application releases the theme subscription", () => {
  const { media, application } = buildApplication();
  application.destroy();
  // No listener remains, so a later system change cannot reach a dead app.
  assert.doesNotThrow(() => media.setSystemPrefersDark(true));
  assert.throws(() => application.theme.toggle(), /disposed/);
  application.destroy();
});
