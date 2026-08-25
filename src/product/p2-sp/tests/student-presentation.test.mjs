import assert from "node:assert/strict";
import test from "node:test";
import { updateStudentPresentation } from "../presentation/student-view.js";

class PresentationNode {
  constructor() { this.textContent = ""; this.disabled = false; this.hidden = false; this.dataset = {}; this.attributes = {}; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
}

function presentationFixture() {
  const selectors = [
    '[data-live="connection"]', '[data-live="stream"]', '[data-live="deployment"]',
    '[data-live="quality"]', '[data-live="voltage"]', '[data-live="current"]',
    '[data-live="error"]', '[data-live="action-error"]', '[data-value-panel="voltage"]',
    '[data-value-panel="current"]', '[data-graph-panel="voltage"]', '[data-graph-panel="current"]',
    "[data-student-graphs]", "[data-student-primary-action]",
  ];
  const nodes = new Map(selectors.map((selector) => [selector, new PresentationNode()]));
  let state = { controlState: "CLOSED", streamId: null, startPending: false, stopPending: false, lastError: null };
  let operation = { inFlight: false, operationKind: null };
  const owner = {
    adapter: { summary: () => state },
    model: { latest: null },
  };
  const root = { querySelector: (selector) => nodes.get(selector) ?? null };
  const primaryController = { snapshot: () => operation };
  const deployment = { target: "device-hosted", displayName: "Both", startAllowed: true, bundleStatus: "matched", message: "" };
  const diagnostic = { count: 0, lastAction: "none" };
  const render = () => updateStudentPresentation(root, owner, deployment, diagnostic, primaryController);
  return {
    button: nodes.get("[data-student-primary-action]"), render,
    setState(controlState, pending = {}) { state = { controlState, streamId: null, startPending: false, stopPending: false, lastError: null, ...pending }; },
    setOperation(inFlight, operationKind = null) { operation = { inFlight, operationKind }; },
  };
}

function assertButton(button, { label, disabled, busy }) {
  assert.equal(button.textContent, label);
  assert.equal(button.disabled, disabled);
  assert.equal(button.getAttribute("aria-disabled"), String(disabled));
  assert.equal(button.getAttribute("aria-busy"), String(busy));
}

test("Start success updates the same primary button from Starting to enabled Stop after settlement", () => {
  const view = presentationFixture();
  const button = view.button;
  view.setState("CONNECTED");
  view.setOperation(true, "start");
  view.render();
  assert.strictEqual(view.button, button);
  assertButton(button, { label: "開始中… / Starting…", disabled: true, busy: true });

  view.setState("STREAMING");
  view.setOperation(false);
  view.render();
  assert.strictEqual(view.button, button);
  assertButton(button, { label: "測定終了 / Stop", disabled: false, busy: false });
});

test("Stop success updates the same primary button to enabled Start for READY and Student-owned CLOSED settlement", () => {
  for (const settledState of ["READY", "CLOSED"]) {
    const view = presentationFixture();
    const button = view.button;
    view.setState("STREAMING", { stopPending: true });
    view.setOperation(true, "stop");
    view.render();
    assert.strictEqual(view.button, button);
    assertButton(button, { label: "終了中… / Stopping…", disabled: true, busy: true });

    view.setState(settledState);
    view.setOperation(false);
    view.render();
    assert.strictEqual(view.button, button);
    assertButton(button, { label: "測定開始 / Start", disabled: false, busy: false });
  }
});

test("CONNECTED without a controller callback still presents disabled busy Starting", () => {
  const view = presentationFixture();
  view.setState("CONNECTED");
  view.setOperation(false);
  view.render();
  assertButton(view.button, { label: "開始中… / Starting…", disabled: true, busy: true });
});
