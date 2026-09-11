import assert from "node:assert/strict";
import { createRuntimeOwner } from "../runtime-owner.js";
import { createViewerApplication } from "../app.js";
import { makeStartedText, makeWelcomeText, makeViFrame, makeStreamEndFrame, makeStoppedText } from "../../source-export/viewer/src/sources/synthetic-source.js";

function createContext() {
  const context = { text: [], measureText: (text) => ({ width: String(text).length * 6 }) };
  for (const name of ["setTransform", "clearRect", "fillRect", "beginPath", "moveTo", "lineTo", "stroke", "setLineDash", "save", "translate", "rotate", "restore", "clip", "rect"]) context[name] = () => {};
  context.fillText = (text) => context.text.push(String(text));
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
    if (tag === "canvas") { this.width = 0; this.height = 0; this.context = createContext(); }
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
      if (!["input", "br", "hr"].includes(tag.toLowerCase())) stack.push(node);
    }
    this._html = html;
  }
  get innerHTML() { return this._html ?? ""; }
}


export function fixture() {
  const counts = { construct: 0, send: 0, close: 0 };
  const sockets = [];
  const original = globalThis.WebSocket;
  const originalStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  globalThis.WebSocket = class {
    static OPEN = 1; static CLOSED = 3; static CLOSING = 2;
    constructor() { counts.construct++; this.readyState = 0; sockets.push(this); }
    send() { counts.send++; }
    close() { counts.close++; this.disconnect(); }
    open() { this.readyState = 1; this.onopen?.(); }
    message(data) { this.onmessage?.({ data }); }
    disconnect() { this.readyState = 3; this.onclose?.(); }
    error() { this.onerror?.(); }
  };
  let jobId = 0; const jobs = new Map();
  const scheduler = { setTimeout(fn) { const id = ++jobId; jobs.set(id, fn); return id; }, clearTimeout(id) { jobs.delete(id); } };
  const frames = new Map(); let frameId = 0;
  const animationScheduler = { requestAnimationFrame(fn) { const id = ++frameId; frames.set(id, fn); return id; }, cancelAnimationFrame(id) { frames.delete(id); } };
  const owner = createRuntimeOwner({ scheduler });
  const root = new FakeNode("main", {});
  const app = createViewerApplication({ root, owner, animationScheduler, themeMedia: null, themeRoot: null });
  let streamId = 1; let sequence = 0n; let timestampUs = 0n;
  const socket = () => sockets.at(-1);
  return {
    root, owner, app, counts, socket,
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); },
    async start(id = 1) {
      streamId = id; sequence = 0n;
      if (owner.adapter.controlState === "CLOSED") {
        const opening = owner.actions.open(); socket().open(); await opening; socket().message(makeWelcomeText());
      }
      await owner.actions.start(); socket().message(makeStartedText(id, "live-vi"));
      assert.equal(owner.adapter.controlState, "STREAMING");
    },
    data(timestamp, options = {}) {
      timestampUs = timestamp; sequence = options.sequence ?? sequence + 1n;
      socket().message(makeViFrame({ streamId, sequence, timestampUs, flags: sequence === 1n ? 1 : 0, voltage: 1, current: 0.125, ...options }));
    },
    end() { socket().message(makeStreamEndFrame({ streamId, sequence: sequence + 1n, timestampUs })); },
    stopped() { socket().message(makeStoppedText(streamId)); },
    async stop() { await owner.actions.stop(); this.end(); this.stopped(); assert.equal(owner.stoppedHistoryReady, true); },
    state() { return app.historyReview.snapshot(owner.model.historySummary(), owner.stoppedHistoryReady, owner.model.displayWindowSeconds); },
    window(seconds) { const control = root.querySelector("[data-display-window]"); control.value = String(seconds); control.onchange(); },
    click(action) { root.querySelector(`[data-history-${action}]`).onclick(); },
    position(value) { const control = root.querySelector("[data-history-position]"); control.value = String(value); control.oninput(); },
    timeout() { const pending = [...jobs.values()]; jobs.clear(); pending.forEach(fn => fn()); },
    dispose() { app.destroy(); globalThis.WebSocket = original; globalThis.getComputedStyle = originalStyle; },
  };
}
