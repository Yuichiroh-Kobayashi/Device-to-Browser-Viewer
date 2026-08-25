import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeOwner } from "../runtime-owner.js";
import { createPresentationCoordinator, ModeController } from "../presentation/mode-controller.js";
import { StudentPrimaryActionController } from "../student-primary-action-controller.js";
import { makeStartedText, makeStoppedText, makeStreamEndFrame, makeWelcomeText } from "../../source-export/viewer/src/sources/synthetic-source.js";

const originalWebSocket = globalThis.WebSocket;
let sockets = [];

class FakeWebSocket {
  static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor() { this.readyState = 0; this.sent = []; this.closeCalls = 0; sockets.push(this); }
  send(text) { this.sent.push(text); }
  close() { this.closeCalls += 1; this.readyState = FakeWebSocket.CLOSING; }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  message(data) { this.onmessage?.({ data }); }
  disconnect() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
}

class ManualScheduler {
  constructor() { this.now = 0; this.nextId = 1; this.jobs = new Map(); }
  setTimeout(callback, delay) { const id = this.nextId++; this.jobs.set(id, { callback, due: this.now + delay }); return id; }
  clearTimeout(id) { this.jobs.delete(id); }
  advance(delay) {
    this.now += delay;
    for (;;) {
      const due = [...this.jobs.entries()].filter(([, job]) => job.due <= this.now).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!due) return;
      this.jobs.delete(due[0]);
      due[1].callback();
    }
  }
}

const allowed = Object.freeze({ startAllowed: true });
const controls = (socket, type) => socket.sent.filter((text) => JSON.parse(text).type === type);
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

async function makeReady(owner) {
  const opening = owner.actions.open();
  const socket = sockets.at(-1);
  socket.open();
  await opening;
  socket.message(makeWelcomeText());
  assert.equal(owner.adapter.summary().controlState, "READY");
  return socket;
}

async function finishStop(socket, streamId, sequence = 1n) {
  socket.message(makeStreamEndFrame({ streamId, sequence, timestampUs: sequence }));
  socket.message(makeStoppedText(streamId));
}

test.before(() => { globalThis.WebSocket = FakeWebSocket; });
test.beforeEach(() => { sockets = []; });
test.after(() => { if (originalWebSocket === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = originalWebSocket; });

test("real CLOSED Start waits for welcome and real Student-owned Stop closes once", async () => {
  const owner = createRuntimeOwner();
  const controller = new StudentPrimaryActionController(owner);
  const constructorsBefore = sockets.length;
  const starting = controller.activate(allowed);
  const socket = sockets.at(-1);
  assert.equal(sockets.length - constructorsBefore, 1);
  socket.open();
  await turn();
  assert.equal(controls(socket, "hello").length, 1);
  assert.equal(controls(socket, "start_stream").length, 0);
  socket.message(makeWelcomeText());
  await turn();
  assert.equal(owner.adapter.summary().controlState, "READY");
  assert.equal(controls(socket, "start_stream").length, 1);
  socket.message(makeStartedText(41, "live-vi"));
  assert.equal(await starting, true);
  assert.equal(owner.adapter.summary().controlState, "STREAMING");

  const stopping = controller.activate(allowed);
  assert.equal(controls(socket, "stop_stream").length, 1);
  await finishStop(socket, 41);
  await turn();
  assert.equal(socket.closeCalls, 1);
  socket.disconnect();
  assert.equal(await stopping, true);
  assert.equal(controller.snapshot().studentOpenedTransport, false);
  controller.dispose();
});

test("real pre-existing READY transport remains open after Stop", async () => {
  const owner = createRuntimeOwner();
  const socket = await makeReady(owner);
  const controller = new StudentPrimaryActionController(owner);
  const starting = controller.activate(allowed);
  socket.message(makeStartedText(42, "live-vi"));
  await starting;
  const stopping = controller.activate(allowed);
  assert.equal(controls(socket, "stop_stream").length, 1);
  await finishStop(socket, 42);
  await stopping;
  assert.equal(owner.adapter.summary().controlState, "READY");
  assert.equal(socket.closeCalls, 0);
  controller.dispose();
});

test("unsolicited CLOSED clears stale lease before a later pre-existing READY lifecycle", async () => {
  const owner = createRuntimeOwner();
  const controller = new StudentPrimaryActionController(owner);
  const firstStart = controller.activate(allowed);
  const firstSocket = sockets.at(-1);
  firstSocket.open(); await turn(); firstSocket.message(makeWelcomeText()); await turn(); firstSocket.message(makeStartedText(43, "live-vi")); await firstStart;
  assert.equal(controller.snapshot().studentOpenedTransport, true);
  firstSocket.disconnect();
  assert.equal(owner.adapter.summary().controlState, "CLOSED");
  assert.equal(controller.snapshot().studentOpenedTransport, false);

  const secondSocket = await makeReady(owner);
  const secondStart = controller.activate(allowed);
  secondSocket.message(makeStartedText(44, "live-vi")); await secondStart;
  const secondStop = controller.activate(allowed);
  await finishStop(secondSocket, 44, 2n); await secondStop;
  assert.equal(secondSocket.closeCalls, 0);
  assert.equal(owner.adapter.summary().controlState, "READY");
  controller.dispose();
});

test("real RuntimeOwner timeouts and disconnect never retry or reconnect and clear ownership", async () => {
  const helloScheduler = new ManualScheduler();
  const helloOwner = createRuntimeOwner({ scheduler: helloScheduler, timeouts: { hello: 10 } });
  const helloController = new StudentPrimaryActionController(helloOwner);
  const helloStart = helloController.activate(allowed); const helloSocket = sockets.at(-1); helloSocket.open(); await turn();
  const helloConstructors = sockets.length; helloScheduler.advance(10); helloSocket.disconnect();
  await assert.rejects(helloStart, /ended in CLOSED/);
  assert.equal(sockets.length, helloConstructors);
  assert.equal(controls(helloSocket, "hello").length, 1);
  assert.equal(controls(helloSocket, "start_stream").length, 0);
  assert.equal(helloController.snapshot().studentOpenedTransport, false);
  helloController.dispose();

  const startScheduler = new ManualScheduler();
  const startOwner = createRuntimeOwner({ scheduler: startScheduler, timeouts: { start: 10 } });
  const startSocket = await makeReady(startOwner); const startController = new StudentPrimaryActionController(startOwner);
  const startOperation = startController.activate(allowed); const startConstructors = sockets.length;
  startScheduler.advance(10); startSocket.disconnect();
  await assert.rejects(startOperation, /ended in CLOSED/);
  assert.equal(sockets.length, startConstructors);
  assert.equal(controls(startSocket, "start_stream").length, 1);
  assert.equal(startController.snapshot().studentOpenedTransport, false);
  startController.dispose();

  const disconnectOwner = createRuntimeOwner();
  const disconnectController = new StudentPrimaryActionController(disconnectOwner);
  const disconnectStart = disconnectController.activate(allowed); const disconnectSocket = sockets.at(-1); disconnectSocket.open(); await turn(); disconnectSocket.message(makeWelcomeText()); await turn(); disconnectSocket.message(makeStartedText(45, "live-vi")); await disconnectStart;
  const disconnectConstructors = sockets.length; disconnectSocket.disconnect();
  assert.equal(sockets.length, disconnectConstructors);
  assert.equal(disconnectController.snapshot().studentOpenedTransport, false);
  disconnectController.dispose();
});

test("real ModeController switching preserves the in-flight Student transaction and runtime identities", async () => {
  const owner = createRuntimeOwner();
  const socket = await makeReady(owner);
  const studentController = new StudentPrimaryActionController(owner);
  const presentation = createPresentationCoordinator({ mount() {}, update() {} });
  const modeController = new ModeController(owner, { deployment: allowed, render: (mode) => presentation.setMode(mode) });
  modeController.setMode("student");
  const source = owner.source; const adapter = owner.adapter; const model = owner.model; const controllerIdentity = studentController;
  const operation = studentController.activate(allowed);
  assert.equal(controls(socket, "start_stream").length, 1);
  const constructors = sockets.length; const sends = socket.sent.length; const closes = socket.closeCalls;
  modeController.toggle();
  modeController.toggle();
  assert.strictEqual(studentController, controllerIdentity);
  assert.strictEqual(owner.source, source); assert.strictEqual(owner.adapter, adapter); assert.strictEqual(owner.model, model);
  assert.equal(sockets.length, constructors); assert.equal(socket.sent.length, sends); assert.equal(socket.closeCalls, closes);
  assert.equal(controls(socket, "start_stream").length, 1);
  socket.message(makeStartedText(46, "live-vi"));
  assert.equal(await operation, true);
  assert.equal(modeController.mode, "student");
  assert.equal(owner.adapter.summary().controlState, "STREAMING");
  studentController.dispose();
});
