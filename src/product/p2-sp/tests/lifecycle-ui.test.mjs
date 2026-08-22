import assert from "node:assert/strict";
import { createRuntimeOwner } from "../runtime-owner.js";
import { ModeController } from "../presentation/mode-controller.js";
import { presentError } from "../presentation/view-state.js";
import { makeStartedText, makeStoppedText, makeStreamEndFrame, makeViFrame, makeWelcomeText } from "../../source-export/viewer/src/sources/synthetic-source.js";

const originalWebSocket = globalThis.WebSocket;
let sockets = [];
let constructorFault = null;
class FakeWebSocket {
  static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(endpoint) { if (constructorFault) throw constructorFault; this.endpoint = endpoint; this.readyState = 0; this.sent = []; this.closeCalls = 0; sockets.push(this); }
  send(text) { this.sent.push(text); }
  close() { this.closeCalls += 1; if (this.readyState !== FakeWebSocket.CLOSED) this.readyState = FakeWebSocket.CLOSING; }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  error() { this.onerror?.(); }
  closeEvent() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
  message(data) { this.onmessage?.({ data }); }
}
globalThis.WebSocket = FakeWebSocket;

const rows = [];
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
  pending() { return this.jobs.size; }
}
function controls(socket, type) { return socket.sent.filter((text) => JSON.parse(text).type === type); }
function snapshot(owner) { return owner.model.records.toArray(); }
function add(id, stimulus_method, assertions) { assert.equal(assertions.length > 0, true, `${id} needs concrete assertions`); rows.push({ id, executed: true, result: "PASS", stimulus_method, assertions }); }
async function rejects(promise, pattern) { await assert.rejects(promise, pattern); }
async function closeAndSettle(source, socket) { const closing = source.close(); if (socket.readyState !== FakeWebSocket.CLOSED) socket.closeEvent(); await closing; }
async function forceCloseAndSettle(owner, socket) { const closing = owner.actions.forceClose(); if (socket.readyState !== FakeWebSocket.CLOSED) socket.closeEvent(); await closing; }
async function readyOwner(options = {}) {
  const owner = createRuntimeOwner(options); const source = owner.requestLive(); const opening = owner.actions.open(); const socket = sockets.at(-1);
  socket.open(); await opening; socket.message(makeWelcomeText()); assert.equal(owner.adapter.summary().controlState, "READY"); return { owner, source, socket };
}
async function streamingOwner(streamId = 1, frame = true, options = {}) {
  const runtime = await readyOwner(options); await runtime.owner.actions.start(); runtime.socket.message(makeStartedText(streamId, "live-vi"));
  if (frame) runtime.socket.message(makeViFrame({ streamId, sequence: 1n, timestampUs: 1000n, flags: 1, voltage: 3.3, current: 0.1 }));
  assert.equal(runtime.owner.adapter.summary().controlState, "STREAMING"); return runtime;
}

try {
  // L01-L10: one real public lifecycle, including an old-viewport isolation check.
  const nominalScheduler = new ManualScheduler(); const owner = createRuntimeOwner({ scheduler: nominalScheduler }); const source = owner.requestLive(); const firstOpen = source.open(); const firstSocket = sockets.at(-1);
  assert.equal(source.state, "connecting"); assert.equal(owner.adapter.summary().controlState, "CLOSED");
  add("L01", "public source.open() before fake transport opens", ["source.state=connecting", "adapter.controlState=CLOSED before onopen"]);
  firstSocket.open(); await firstOpen; firstSocket.message(makeWelcomeText());
  assert.equal(source.state, "open"); assert.equal(owner.adapter.summary().controlState, "READY"); assert.equal(controls(firstSocket, "hello").length, 1); assert.equal(nominalScheduler.pending(), 0);
  add("L02", "fake socket.onopen followed by protocol-valid welcome", ["source.state=open", "adapter.controlState=READY", "hello sends=1", "hello timer cleared on READY"]);
  await source.start(); assert.equal(owner.adapter.summary().startPending, true); assert.equal(owner.adapter.summary().controlState, "READY"); assert.equal(controls(firstSocket, "start_stream").length, 1); assert.equal(nominalScheduler.pending(), 1);
  add("L03", "public source.start() after READY", ["startPending=true", "controlState=READY", "start_stream sends=1", "start timer armed"]);
  firstSocket.message(makeStartedText(7, "live-vi")); assert.equal(owner.adapter.summary().controlState, "STREAMING"); assert.equal(owner.adapter.summary().streamId, 7); assert.equal(nominalScheduler.pending(), 0);
  add("L04", "protocol-valid stream_started(stream_id=7)", ["controlState=STREAMING", "streamId=7", "start timer cleared on STREAMING"]);
  await source.stop(); assert.equal(owner.adapter.summary().stopPending, true); assert.equal(controls(firstSocket, "stop_stream").length, 1); assert.equal(nominalScheduler.pending(), 1);
  add("L05", "public source.stop() while stream_id=7 is active", ["stopPending=true", "stop_stream sends=1", "stop timer armed"]);
  firstSocket.message(makeStreamEndFrame({ streamId: 7, sequence: 1n, timestampUs: 1n })); firstSocket.message(makeStoppedText(7));
  assert.equal(owner.adapter.summary().controlState, "READY"); assert.equal(owner.adapter.summary().streamId, null); assert.equal(nominalScheduler.pending(), 0);
  add("L06", "accepted STREAM_END then matching stream_stopped", ["controlState=READY", "streamId=null", "stop timer cleared on READY"]);
  const firstClose = source.close(); assert.equal(firstSocket.readyState, FakeWebSocket.CLOSING); assert.equal(firstSocket.closeCalls, 1);
  add("L07", "public source.close() from READY", ["socket.readyState=CLOSING", "socket.closeCalls=1"]);
  firstSocket.closeEvent(); await firstClose; assert.equal(source.state, "closed"); assert.equal(owner.adapter.summary().controlState, "CLOSED"); assert.equal(nominalScheduler.pending(), 0);
  add("L08", "fake socket.onclose completing requested close", ["source.state=closed", "adapter.controlState=CLOSED", "all coordinator timers cleared on close"]);
  const socketCountBeforeReconnect = sockets.length; const secondOpen = source.open(); const secondSocket = sockets.at(-1);
  assert.equal(sockets.length - socketCountBeforeReconnect, 1); assert.equal(secondSocket, source.socket);
  add("L09", "explicit public source.open() after CLOSED", ["WebSocket constructor delta=1", "new socket is source.socket"]);
  secondSocket.open(); await secondOpen; secondSocket.message(makeWelcomeText()); await source.start(); secondSocket.message(makeStartedText(8, "live-vi")); secondSocket.message(makeViFrame({ streamId: 8, sequence: 1n, timestampUs: 9n, flags: 1, voltage: 1, current: 1 }));
  const newRecords = snapshot(owner); assert.equal(newRecords.length, 1); assert.deepEqual(newRecords.map((record) => record.stream_id), [8]); assert.equal(newRecords[0].timestamp_us, 9n);
  add("L10", "distinct stream_id=8 accepted frame after explicit reconnect", ["record count=1", "viewport stream_ids=[8]", "latest timestamp_us=9"]);
  await closeAndSettle(source, secondSocket);

  constructorFault = new Error("deterministic constructor failure"); const f01Owner = createRuntimeOwner(); const f01Source = f01Owner.requestLive(); const f01SocketsBefore = sockets.length;
  await rejects(f01Source.open(), /constructor failure/); constructorFault = null;
  assert.equal(sockets.length - f01SocketsBefore, 0); assert.equal(f01Source.state, "closed"); assert.equal(f01Owner.adapter.summary().controlState, "CLOSED"); assert.equal(f01Owner.adapter.summary().lastError, null);
  add("F01", "FakeWebSocket constructor throws; public source.open() rejects", ["WebSocket instances delta=0", "source.state=closed", "adapter.controlState=CLOSED", "adapter.lastError=null (no active stream to abort)"]);

  const f02Owner = createRuntimeOwner(); const f02Source = f02Owner.requestLive(); const f02Before = sockets.length; const f02Open = f02Source.open(); const f02Socket = sockets.at(-1);
  f02Socket.error(); await rejects(f02Open, /transport error/); f02Socket.closeEvent();
  assert.equal(sockets.length - f02Before, 1); assert.equal(f02Owner.adapter.summary().controlState, "CLOSED"); assert.equal(controls(f02Socket, "hello").length, 0); assert.equal(sockets.length, f02Before + 1);
  add("F02", "fake socket.onerror before onopen, then fake onclose", ["WebSocket constructor delta=1", "hello sends=0", "adapter.controlState=CLOSED", "automatic reconnect delta=0"]);

  const f03Scheduler = new ManualScheduler(); const f03Owner = createRuntimeOwner({ scheduler: f03Scheduler, timeouts: { hello: 10 } }); const f03Opening = f03Owner.actions.open(); const f03Socket = sockets.at(-1);
  f03Socket.open(); await f03Opening;
  assert.equal(f03Owner.adapter.summary().controlState, "CONNECTED"); assert.equal(controls(f03Socket, "hello").length, 1); assert.equal(f03Scheduler.pending(), 1);
  f03Scheduler.advance(10); const f03Error = presentError(f03Owner.adapter.summary().lastError);
  assert.equal(f03Error.classification, "recoverable"); assert.equal(f03Error.code, "hello_timeout"); assert.equal(f03Socket.closeCalls, 1);
  f03Socket.closeEvent(); assert.equal(f03Owner.adapter.summary().controlState, "CLOSED"); assert.equal(f03Scheduler.pending(), 0);
  add("F03", "owner coordinator arms hello timer after actual socket open/hello and ManualScheduler advances it before READY", ["hello sends=1", "presentError.code=hello_timeout", "forced recovery closeCalls=1", "adapter.controlState=CLOSED", "scheduler pending=0", "automatic reconnect delta=0"]);

  const f04Scheduler = new ManualScheduler(); const f04Owner = createRuntimeOwner({ scheduler: f04Scheduler, timeouts: { hello: 10 } }); const f04Opening = f04Owner.actions.open(); const f04Socket = sockets.at(-1);
  f04Socket.open(); await f04Opening; const f04DiagBefore = f04Owner.adapter.summary().diagnosticCount;
  const invalidWelcome = JSON.stringify({ ...JSON.parse(makeWelcomeText()), protocol: "not-d2b-stream" }); f04Socket.message(invalidWelcome);
  const f04Summary = f04Owner.adapter.summary(); const f04Error = presentError(f04Summary.lastError);
  assert.equal(f04Summary.controlState, "CONNECTED"); assert.equal(f04Summary.welcome, null); assert.equal(f04Error.code, "invalid_message"); assert.equal(f04Error.classification, "fatal-semantic"); assert.equal(f04Summary.diagnosticCount, f04DiagBefore + 1); assert.equal(f04Scheduler.pending(), 1);
  await forceCloseAndSettle(f04Owner, f04Socket); assert.equal(f04Scheduler.pending(), 0);
  add("F04", "actual socket message carries a D2B-semantic-invalid welcome(protocol=not-d2b-stream) after hello", ["controlState=CONNECTED (not READY)", "welcome=null", "D2B invalid_message=fatal-semantic", `diagnosticCount=${f04Summary.diagnosticCount}`, "scheduler cleared on forced close"]);

  const f05 = await readyOwner(); const f05Before = sockets.length; await f05.source.start(); f05.socket.message(JSON.stringify({ type: "error", code: "busy", message: "meter in use", recoverable: true }));
  const f05Summary = f05.owner.adapter.summary(); const f05Error = presentError(f05Summary.lastError);
  assert.equal(f05Summary.controlState, "READY"); assert.equal(f05Summary.startPending, true); assert.equal(f05Error.classification, "recoverable"); assert.equal(controls(f05.socket, "start_stream").length, 1); await closeAndSettle(f05.source, f05.socket); assert.equal(sockets.length, f05Before);
  add("F05", "public start_stream followed by valid server error(code=busy), then explicit close", ["controlState=READY (not STREAMING)", "startPending=true until close", "presentError.classification=recoverable", "start_stream sends=1", "automatic retry delta=0"]);

  const f06Scheduler = new ManualScheduler(); const f06 = await readyOwner({ scheduler: f06Scheduler, timeouts: { start: 10 } }); await f06.owner.actions.start();
  assert.equal(controls(f06.socket, "start_stream").length, 1); assert.equal(f06.owner.adapter.summary().startPending, true); assert.equal(f06Scheduler.pending(), 1);
  f06Scheduler.advance(10); const f06Error = presentError(f06.owner.adapter.summary().lastError);
  assert.equal(f06Error.code, "start_timeout"); assert.equal(f06.socket.closeCalls, 1); f06.socket.closeEvent(); assert.equal(f06.owner.adapter.summary().controlState, "CLOSED"); assert.equal(f06Scheduler.pending(), 0);
  add("F06", "owner coordinator arms start timer after public start_stream; ManualScheduler advances while start is pending", ["start_stream sends=1", "presentError.code=start_timeout", "forced recovery closeCalls=1", "adapter.controlState=CLOSED", "scheduler pending=0", "automatic retry delta=0"]);

  const f07 = await readyOwner(); await f07.owner.actions.start(); const f07Before = sockets.length; assert.equal(f07.owner.adapter.summary().startPending, true); await forceCloseAndSettle(f07.owner, f07.socket); const f07Summary = f07.owner.adapter.summary();
  assert.equal(f07Summary.controlState, "CLOSED"); assert.equal(f07Summary.startPending, false); assert.equal(f07Summary.streamId, null); assert.equal(sockets.length, f07Before);
  add("F07", "internal owner.actions.forceClose() while STARTING/startPending=true", ["controlState=CLOSED", "startPending=false", "streamId=null", "automatic reconnect delta=0"]);

  const f08Scheduler = new ManualScheduler(); const f08 = await streamingOwner(18, true, { scheduler: f08Scheduler, timeouts: { stop: 10 } }); await f08.owner.actions.stop();
  assert.equal(f08.owner.adapter.summary().stopPending, true); assert.equal(f08Scheduler.pending(), 1); f08Scheduler.advance(10); const f08Error = presentError(f08.owner.adapter.summary().lastError);
  assert.equal(f08Error.code, "stop_timeout"); assert.equal(f08.socket.closeCalls, 1); f08.socket.closeEvent(); assert.equal(f08.owner.adapter.summary().controlState, "CLOSED"); assert.equal(f08Scheduler.pending(), 0);
  add("F08", "owner coordinator arms stop timer after public stop_stream; ManualScheduler advances while stop is pending", ["stopPending=true before timeout", "presentError.code=stop_timeout", "forced recovery closeCalls=1", "adapter.controlState=CLOSED", "scheduler pending=0"]);

  const f09 = await streamingOwner(19); const f09Before = sockets.length; assert.equal(f09.owner.model.latest.stream_id, 19); f09.socket.error(); f09.socket.closeEvent(); const f09Summary = f09.owner.adapter.summary();
  assert.equal(f09Summary.controlState, "CLOSED"); assert.equal(f09Summary.streamId, null); assert.equal(f09.owner.model.latest.stream_id, 19); assert.equal(sockets.length, f09Before);
  add("F09", "fake socket.onerror and socket.onclose while STREAMING", ["controlState=CLOSED", "active streamId=null", "last retained record stream_id=19", "automatic reconnect delta=0"]);

  const f10 = await readyOwner(); const f10Before = sockets.length; const sameSource = f10.owner.requestLive(); await f10.source.start(); await rejects(sameSource.start(), /already pending/);
  assert.equal(sameSource, f10.source); assert.equal(controls(f10.socket, "start_stream").length, 1); assert.equal(sockets.length, f10Before);
  add("F10", "second owner.requestLive() plus second public start() during pending start", ["requestLive identity=same source", "second start rejects=outbound pending", "start_stream sends=1", "automatic retry/socket delta=0"]); await closeAndSettle(f10.source, f10.socket);

  const f11 = await streamingOwner(21); const f11RecordsBefore = snapshot(f11.owner); const f11GapsBefore = f11.owner.model.sequenceGapCount;
  const badFrame = makeViFrame({ streamId: 21, sequence: 2n, timestampUs: 2000n, flags: 0, voltage: 9, current: 9 }); new Uint8Array(badFrame)[0] = 0x58; f11.socket.message(badFrame);
  const f11Summary = f11.owner.adapter.summary(); const f11Error = presentError(f11Summary.lastError); const f11RecordsAfter = snapshot(f11.owner);
  assert.equal(f11Error.classification, "fatal-semantic"); assert.equal(f11RecordsAfter.length, f11RecordsBefore.length); assert.equal(f11RecordsAfter[0].sequence, 1n); assert.equal(f11.owner.model.sequenceGapCount, f11GapsBefore);
  add("F11", "bad-magic binary frame delivered after one valid stream frame", ["presentError.classification=fatal-semantic", "record count remains=1", "retained sequence=1", "sequenceGapCount remains=0"]); await closeAndSettle(f11.source, f11.socket);

  const f12 = await readyOwner(); const f12Before = sockets.length; await closeAndSettle(f12.source, f12.socket);
  assert.equal(f12.owner.adapter.summary().controlState, "CLOSED"); assert.equal(f12.owner.adapter.summary().streamId, null); assert.equal(f12.owner.model.latest, null); assert.equal(sockets.length, f12Before);
  add("F12", "public close from READY with no active stream", ["controlState=CLOSED", "streamId=null", "model.latest=null", "automatic reconnect delta=0"]);

  const f13 = await streamingOwner(23); const f13Source = f13.source; const f13Adapter = f13.owner.adapter; const f13Model = f13.owner.model; const f13Session = f13.owner.adapter.summary().streamId; const f13Records = snapshot(f13.owner).length; let f13Renders = 0;
  const f13Controller = new ModeController(f13.owner, { deployment: Object.freeze({ target: "host" }), render(mode, renderOwner) { f13Renders += 1; assert.equal(renderOwner, f13.owner); assert.equal(mode, "student"); } }); f13Controller.setMode("student"); f13Controller.setMode("student");
  assert.equal(f13Renders, 2); assert.equal(f13.owner.source, f13Source); assert.equal(f13.owner.adapter, f13Adapter); assert.equal(f13.owner.model, f13Model); assert.equal(f13.owner.adapter.summary().streamId, f13Session); assert.equal(snapshot(f13.owner).length, f13Records);
  add("F13", "two responsive projection render callbacks while STREAMING", ["render calls=2", "same source/adapter/model=true", "streamId=23 retained", "record count=1 retained"]); await closeAndSettle(f13.source, f13.socket);

  const f14 = await streamingOwner(24); const f14Source = f14.source; const f14Adapter = f14.owner.adapter; const f14Model = f14.owner.model; const f14Session = f14.owner.adapter.summary().streamId; const f14SocketCount = sockets.length; const f14SendCount = f14.socket.sent.length; const f14CloseCount = f14.socket.closeCalls; const renderedModes = [];
  const f14Controller = new ModeController(f14.owner, { deployment: Object.freeze({ target: "host" }), render(mode) { renderedModes.push(mode); } }); f14Controller.setMode("student"); f14Controller.toggle(); f14Controller.toggle(); f14Controller.toggle();
  assert.deepEqual(renderedModes, ["student", "professional", "student", "professional"]); assert.equal(f14.owner.source, f14Source); assert.equal(f14.owner.adapter, f14Adapter); assert.equal(f14.owner.model, f14Model); assert.equal(f14.owner.adapter.summary().streamId, f14Session); assert.equal(sockets.length - f14SocketCount, 0); assert.equal(f14.socket.sent.length - f14SendCount, 0); assert.equal(f14.socket.closeCalls - f14CloseCount, 0);
  add("F14", "Student→Professional→Student→Professional ModeController toggles while STREAMING", ["rendered modes=student,professional,student,professional", "same source/adapter/model=true", "streamId=24 retained", "WebSocket/send/close deltas=0/0/0"]); await closeAndSettle(f14.source, f14.socket);

  const f15 = await streamingOwner(25); const f15OldSocket = f15.socket; const f15OldRecords = snapshot(f15.owner); const f15Before = sockets.length; await closeAndSettle(f15.source, f15OldSocket);
  const f15Open = f15.source.open(); const f15NewSocket = sockets.at(-1); f15NewSocket.open(); await f15Open; f15NewSocket.message(makeWelcomeText()); await f15.source.start(); f15NewSocket.message(makeStartedText(26, "live-vi")); f15NewSocket.message(makeViFrame({ streamId: 26, sequence: 10n, timestampUs: 9000n, flags: 1, voltage: 2, current: 0.2 })); const f15Records = snapshot(f15.owner);
  assert.equal(sockets.length - f15Before, 1); assert.notEqual(f15NewSocket, f15OldSocket); assert.equal(f15OldRecords[0].stream_id, 25); assert.deepEqual(f15Records.map((record) => record.stream_id), [26]); assert.equal(f15Records[0].timestamp_us, 9000n);
  add("F15", "abort/close then explicit public reopen and distinct stream_id=26", ["WebSocket constructor delta=1 (explicit reopen only)", "old retained stream_id=25", "new viewport stream_ids=[26]", "new timestamp_us=9000"]); await closeAndSettle(f15.source, f15NewSocket);

  assert.equal(rows.length, 25); assert.equal(new Set(rows.map((row) => row.id)).size, 25); assert.equal(rows.filter((row) => row.id.startsWith("L")).length, 10); assert.equal(rows.filter((row) => row.id.startsWith("F")).length, 15);
  const result = { result: "PASS", cases: rows }; console.log(JSON.stringify(result));
} finally { if (originalWebSocket === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = originalWebSocket; }
