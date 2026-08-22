import assert from "node:assert/strict";
import { createRuntimeOwner } from "../runtime-owner.js";
import { ModeController } from "../presentation/mode-controller.js";
import { setDisplayWindowSeconds } from "../app.js";
import { makeWelcomeText, makeStartedText, makeStoppedText, makeViFrame, makeStreamEndFrame } from "../../source-export/viewer/src/sources/synthetic-source.js";

const counts = { constructor: 0, send: 0, close: 0, binary: 0 };
const sockets = [];
globalThis.WebSocket = class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor() { counts.constructor += 1; this.readyState = 0; sockets.push(this); }
  send() { counts.send += 1; }
  close() { counts.close += 1; this.readyState = 3; this.onclose?.(); }
  driveOpen() { this.readyState = 1; this.onopen?.(); }
  driveMessage(data) { if (data instanceof ArrayBuffer) counts.binary += 1; this.onmessage?.({ data }); }
};

const owner = createRuntimeOwner();
const source = owner.requestLive();
const controller = new ModeController(owner, { deployment: {}, render() {} });
const originalHandleBinary = owner.adapter.handleBinary.bind(owner.adapter);
const accepted = [];
owner.adapter.handleBinary = (buffer) => { const result = originalHandleBinary(buffer); accepted.push(result); return result; };
const rows = [];
function toggle(context, isolate = false) {
  const before = owner.snapshot(); const c = { ...counts }; const a = accepted.length;
  const latest = owner.model.latest; const records = owner.model.records.toArray();
  for (const mode of ["student", "professional", "student", "professional"]) controller.setMode(mode);
  assert.equal(owner.source, before.source); assert.equal(owner.adapter, before.adapter); assert.equal(owner.model, before.model);
  assert.equal(counts.constructor - c.constructor, 0); assert.equal(counts.send - c.send, 0); assert.equal(counts.close - c.close, 0); assert.equal(accepted.length - a, 0);
  assert.equal(owner.model.latest, latest); assert.deepEqual(owner.model.records.toArray(), records);
  if (context === "READY") { assert.equal(latest, null); assert.equal(records.length, 0); rows.push({ context, executed: true, result: "PASS", constructor_delta: 0, send_delta: 0, close_delta: 0, parse_delta: 0, sequence_status: "not_applicable_before_stream", timestamp_status: "not_applicable_before_stream", viewport: "empty_before_stream" }); }
  else { if (latest) assert.ok(latest.sequence !== undefined && latest.timestamp_us !== undefined); rows.push({ context, executed: true, result: "PASS", constructor_delta: 0, send_delta: 0, close_delta: 0, parse_delta: 0, sequence: latest?.sequence?.toString() ?? "not_applicable", timestamp: latest?.timestamp_us?.toString() ?? "not_applicable", viewport_isolated: isolate, viewport: context === "CLOSED" ? "finished_viewport_retained_by_frozen_model" : "retained" }); }
}
let opening = source.open(); sockets.at(-1).driveOpen(); await opening; sockets.at(-1).driveMessage(makeWelcomeText()); toggle("READY");
await source.start(); sockets.at(-1).driveMessage(makeStartedText(7, "live-vi")); sockets.at(-1).driveMessage(makeViFrame({ streamId: 7, sequence: 1n, timestampUs: 1000n, flags: 1, voltage: 1, current: .1 })); assert.equal(accepted.at(-1), true); assert.ok(owner.model.sampleCount > 0); toggle("STREAMING");
const windowIdentity = owner.snapshot(); const windowCounts = { ...counts }; const windowStreamId = owner.adapter.summary().streamId;
assert.equal(owner.model.displayWindowSeconds, 60);
for (const seconds of [10, 30, 60]) { setDisplayWindowSeconds(owner, seconds); assert.equal(owner.model.displayWindowSeconds, seconds); }
assert.throws(() => setDisplayWindowSeconds(owner, 20), RangeError);
assert.throws(() => setDisplayWindowSeconds(owner, "invalid"), RangeError);
assert.equal(owner.source, windowIdentity.source); assert.equal(owner.adapter, windowIdentity.adapter); assert.equal(owner.model, windowIdentity.model);
assert.equal(owner.adapter.summary().streamId, windowStreamId); assert.deepEqual(counts, windowCounts);
sockets.at(-1).driveMessage(makeViFrame({ streamId: 7, sequence: 4n, timestampUs: 4000n, flags: 4, voltage: 1, current: .1 })); assert.equal(accepted.at(-1), true); toggle("after sequence gap");
sockets.at(-1).driveMessage(makeViFrame({ streamId: 7, sequence: 5n, timestampUs: 5000n, validMask: 1, voltage: 1, current: 0 })); assert.equal(accepted.at(-1), true); toggle("after channel-specific invalid");
await source.stop(); sockets.at(-1).driveMessage(makeStreamEndFrame({ streamId: 7, sequence: 6n, timestampUs: 6000n })); sockets.at(-1).driveMessage(makeStoppedText(7)); await source.close(); toggle("CLOSED");
opening = source.open(); sockets.at(-1).driveOpen(); await opening; sockets.at(-1).driveMessage(makeWelcomeText()); await source.start(); sockets.at(-1).driveMessage(makeStartedText(8, "live-vi")); sockets.at(-1).driveMessage(makeViFrame({ streamId: 8, sequence: 1n, timestampUs: 9000n, flags: 1, voltage: 2, current: .2 })); assert.equal(accepted.at(-1), true); assert.ok(owner.model.records.toArray().length > 0 && owner.model.records.toArray().every((record) => record.stream_id === 8)); toggle("after explicit reconnect/new session", true);
assert.ok(counts.constructor >= 2 && counts.send >= 4 && counts.close >= 1 && counts.binary >= 4 && accepted.every(Boolean));
console.log(JSON.stringify({ result: "PASS", contexts: rows, lifecycle_counts: counts, binary_returns: accepted }));
