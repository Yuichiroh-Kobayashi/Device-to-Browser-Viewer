import assert from "node:assert/strict";
import test from "node:test";
import { StudentPrimaryActionController } from "../student-primary-action-controller.js";

function fixture(initialState) {
  let state = { controlState: initialState, startPending: false, stopPending: false };
  const listeners = new Set();
  const counts = { open: 0, start: 0, stop: 0, close: 0 };
  const owner = Object.freeze({
    adapter: { summary: () => state },
    actions: {
      async open() { counts.open += 1; state = { ...state, controlState: "CONNECTED" }; notify(); },
      async start() { counts.start += 1; state = { ...state, startPending: true }; notify(); },
      async stop() { counts.stop += 1; state = { ...state, stopPending: true }; notify(); },
      async close() { counts.close += 1; state = { ...state, controlState: "CLOSED", stopPending: false }; notify(); },
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  });
  function notify() { for (const listener of [...listeners]) listener(); }
  function drive(controlState, pending = {}) { state = { controlState, startPending: false, stopPending: false, ...pending }; notify(); }
  return { owner, counts, drive, state: () => state };
}

const allowed = Object.freeze({ startAllowed: true });
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

test("CLOSED Start opens once, waits for READY, and starts exactly once", async () => {
  const f = fixture("CLOSED");
  const controller = new StudentPrimaryActionController(f.owner);
  const operation = controller.activate(allowed);
  assert.equal(controller.snapshot().inFlight, true);
  assert.equal(f.counts.open, 1);
  await turn();
  assert.equal(f.counts.start, 0);
  f.drive("READY");
  await turn();
  assert.equal(f.counts.start, 1);
  f.drive("STREAMING");
  assert.equal(await operation, true);
  assert.deepEqual(f.counts, { open: 1, start: 1, stop: 0, close: 0 });
});

test("READY Start sends once and synchronous double activation is guarded", async () => {
  const f = fixture("READY");
  const controller = new StudentPrimaryActionController(f.owner);
  const first = controller.activate(allowed);
  const second = controller.activate(allowed);
  assert.equal(controller.snapshot().inFlight, true);
  assert.equal(await second, false);
  assert.equal(f.counts.start, 1);
  f.drive("STREAMING");
  assert.equal(await first, true);
  assert.deepEqual(f.counts, { open: 0, start: 1, stop: 0, close: 0 });
});

test("Student-owned transport stops once and closes once after READY convergence", async () => {
  const f = fixture("CLOSED");
  const controller = new StudentPrimaryActionController(f.owner);
  const start = controller.activate(allowed);
  await turn();
  f.drive("READY");
  await turn();
  f.drive("STREAMING");
  await start;
  const stop = controller.activate(allowed);
  assert.equal(f.counts.stop, 1);
  assert.equal(f.counts.close, 0);
  f.drive("READY");
  assert.equal(await stop, true);
  assert.deepEqual(f.counts, { open: 1, start: 1, stop: 1, close: 1 });
});

test("pre-existing READY transport remains open after Stop", async () => {
  const f = fixture("READY");
  const controller = new StudentPrimaryActionController(f.owner);
  const start = controller.activate(allowed);
  f.drive("STREAMING");
  await start;
  const stop = controller.activate(allowed);
  f.drive("READY");
  await stop;
  assert.deepEqual(f.counts, { open: 0, start: 1, stop: 1, close: 0 });
  assert.equal(f.state().controlState, "READY");
});

test("timeout/disconnect convergence rejects without retry or reconnect", async () => {
  for (const initialState of ["CLOSED", "READY", "STREAMING"]) {
    const f = fixture(initialState);
    const controller = new StudentPrimaryActionController(f.owner);
    const operation = controller.activate(allowed);
    await turn();
    f.drive("CLOSED");
    await assert.rejects(operation, /ended in CLOSED/);
    assert.ok(f.counts.open <= 1);
    assert.ok(f.counts.start <= 1);
    assert.ok(f.counts.stop <= 1);
    assert.equal(f.counts.close, 0);
  }
});

test("failed operations retain safe diagnostic attribution after operationKind clears", async () => {
  for (const initialState of ["READY", "STREAMING"]) {
    const f = fixture(initialState);
    const controller = new StudentPrimaryActionController(f.owner);
    const operation = controller.activate(allowed);
    f.drive("CLOSED");
    await assert.rejects(operation, /ended in CLOSED/);
    assert.equal(controller.snapshot().operationKind, null);
    assert.equal(controller.snapshot().lastAttemptedOperation, initialState === "STREAMING" ? "stop" : "start");
    controller.dispose();
  }
});
