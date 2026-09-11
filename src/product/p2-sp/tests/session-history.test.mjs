import test from "node:test";
import assert from "node:assert/strict";
import { HISTORY_CAPACITY, SessionHistoryModel } from "../session-history-model.js";
import { StreamModel } from "../../source-export/viewer/src/model/stream-model.js";
import { SessionAdapter } from "../../source-export/viewer/src/protocol/session-adapter.js";
import { makeHelloText, makeStartText, makeStartedText, makeWelcomeText, makeViFrame } from "../../source-export/viewer/src/sources/synthetic-source.js";

function setup(Model = SessionHistoryModel) {
  const model = new Model(); const adapter = new SessionAdapter(model);
  adapter.notifyTransportStatus("open");
  assert.equal(adapter.handleControl("client_to_server", makeHelloText()), true);
  assert.equal(adapter.handleControl("server_to_client", makeWelcomeText()), true);
  assert.equal(adapter.handleControl("client_to_server", makeStartText()), true);
  assert.equal(adapter.handleControl("server_to_client", makeStartedText(1)), true);
  return { model, adapter };
}

test("the sole committed ring survives display-window eviction without cloning records", () => {
  const history = setup(); const legacy = setup(StreamModel);
  let candidate;
  const original = history.model.prepareDecodedFrame.bind(history.model);
  history.model.prepareDecodedFrame = decoded => { candidate = original(decoded); return candidate; };
  for (const f of [history, legacy]) f.model.setDisplayWindowSeconds(10);
  for (let i = 0; i <= 2000; i++) {
    const frame = makeViFrame({ streamId: 1, sequence: BigInt(i + 1), timestampUs: 9_000_000n + BigInt(i) * 40_000n, flags: i === 0 ? 1 : 0, voltage: 2, current: -0.125 });
    assert.equal(history.adapter.handleBinary(frame), true);
    assert.strictEqual(history.model.latest, candidate.records[0]);
    assert.equal(legacy.adapter.handleBinary(frame), true);
  }
  assert.equal(history.model.recordSnapshot().length, 2001);
  assert.equal(legacy.model.recordSnapshot().length, 251);
  assert.equal(history.model.historyOriginTimestampUs, 9_000_000n);
  assert.equal(history.model.viewerWindowEvictionCount, 0);
  assert.equal(history.model.historyTruncated, false);
  const before = history.model.recordSnapshot();
  for (const seconds of [30, 60, 10]) history.model.setDisplayWindowSeconds(seconds);
  assert.deepEqual(history.model.recordSnapshot(), before);
  assert.equal(history.model.latest.current_A, -0.125);
});

test("explicit 4096-record FIFO capacity, observable truncation and original epoch origin", () => {
  assert.equal(HISTORY_CAPACITY, 4096);
  const { model, adapter } = setup();
  for (let i = 0; i < HISTORY_CAPACITY + 2; i++) {
    assert.equal(adapter.handleBinary(makeViFrame({ streamId: 1, sequence: BigInt(i + 1), timestampUs: BigInt(i) * 40_000n, flags: i === 0 ? 1 : 0 })), true);
    if (i === HISTORY_CAPACITY - 1) assert.equal(model.historyTruncated, false);
  }
  assert.equal(model.records.size, HISTORY_CAPACITY);
  assert.equal(model.records.peek().sequence, 3n);
  assert.equal(model.historyTruncated, true);
  assert.equal(model.historyOriginTimestampUs, 0n);
  assert.equal(model.viewerCapacityEvictionCount, 2);
  assert.equal(model.historySummary().firstTimestampUs, 80_000n);
  model.finishStream();
  assert.equal(model.historyTruncated, true, "Stop retains truncation");
  assert.throws(() => model.beginStream({ streamId: 0, profile: "vi-measurement" }));
  assert.equal(model.records.size, HISTORY_CAPACITY, "rejected stream does not clear history");
  model.beginStream({ streamId: 2, profile: "vi-measurement" });
  assert.equal(model.historyTruncated, false);
  assert.equal(model.historyMarkersTruncated, false);
  assert.equal(model.records.size, 0);
  assert.equal(model.historyOriginTimestampUs, null);
});

test("rejected reset is atomic; accepted TIMEBASE_RESET clears records, markers and truncation", () => {
  const { model, adapter } = setup();
  assert.equal(adapter.handleBinary(makeViFrame({ streamId: 1, sequence: 1n, timestampUs: 99_000_000n, flags: 1 })), true);
  const before = model.historySummary(); const records = model.recordSnapshot();
  const reset = makeViFrame({ streamId: 1, sequence: 2n, timestampUs: 100n, flags: 0x44 });
  const invalid = reset.slice(0); new Uint8Array(invalid)[0] = 0;
  assert.equal(adapter.handleBinary(invalid), false);
  assert.deepEqual(model.historySummary(), before);
  assert.deepEqual(model.recordSnapshot(), records);
  assert.equal(adapter.handleBinary(reset), false);
  assert.equal(adapter.summary().lastError.code, "timebase_reset_requires_new_session");
  assert.deepEqual(model.historySummary(), before);
  adapter.notifyTransportStatus("closed"); adapter.notifyTransportStatus("open");
  adapter.handleControl("client_to_server", makeHelloText());
  adapter.handleControl("server_to_client", makeWelcomeText());
  adapter.handleControl("client_to_server", makeStartText());
  adapter.handleControl("server_to_client", makeStartedText(2));
  assert.equal(adapter.handleBinary(makeViFrame({ streamId: 2, sequence: 1n, timestampUs: 100n, flags: 0x45 })), true);
  assert.equal(model.historySummary().epoch, before.epoch + 2);
  assert.equal(model.historyOriginTimestampUs, 100n);
  assert.equal(model.records.size, 1);
  assert.equal(model.markerSnapshot().length, 1);
  assert.equal(model.historyTruncated, false);
});

test("marker retention is bounded and annotation loss is independently observable", () => {
  const { model, adapter } = setup();
  for (let i = 0; i < 514; i++) assert.equal(adapter.handleBinary(makeViFrame({ streamId: 1, sequence: BigInt(i + 1), timestampUs: BigInt(i) * 40_000n, flags: i === 0 ? 1 : 4 })), true);
  assert.equal(model.markers.size, 512);
  assert.equal(model.historyMarkersTruncated, true);
  assert.equal(model.historyTruncated, false);
  assert.equal(model.recordSnapshot().length, 514);
  assert.notEqual(model.recordSnapshot()[511].segment_id, model.latest.segment_id);
});
