import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./history-fixture.mjs";

for (const failure of ["start", "hello"]) test(`normal Stop survives pre-acceptance ${failure} timeout`, async () => {
  const f = fixture();
  try {
    await f.start(); f.data(0n); f.data(80_000_000n); f.flush(); await f.stop();
    f.window(10); f.position(0);
    const epoch = f.owner.model.historyEpoch; const records = f.owner.model.recordSnapshot();
    const cursor = f.state().rightEdge;
    if (failure === "hello") {
      await f.owner.actions.close();
      const opening = f.owner.actions.open(); f.socket().open(); await opening;
    } else await f.owner.actions.start();
    assert.equal(f.owner.stoppedHistoryReady, false);
    f.timeout(); f.flush();
    assert.equal(f.owner.adapter.controlState, "CLOSED");
    assert.equal(f.owner.stoppedHistoryReady, true);
    assert.equal(f.owner.model.historyEpoch, epoch);
    assert.deepEqual(f.owner.model.recordSnapshot(), records);
    assert.equal(f.state().rightEdge, cursor);
    const counts = { ...f.counts }; f.timeout(); assert.deepEqual(f.counts, counts, "no automatic reconnect");
    await f.start(2);
    assert.equal(f.owner.stoppedHistoryReady, false);
    assert.notEqual(f.owner.model.historyEpoch, epoch);
    f.socket().disconnect(); assert.equal(f.owner.stoppedHistoryReady, false, "new abnormal epoch cannot inherit A completion");
  } finally { f.dispose(); }
});

test("live absolute count-up uses committed origin even before the first animation frame", async () => {
  const f = fixture();
  try {
    await f.start(); f.window(10);
    f.data(1_000_000n); f.data(13_500_000n);
    f.flush();
    assert.deepEqual(f.state().domain, { minimum: 2.5, maximum: 12.5 });
    f.position(500); f.position(0);
    assert.deepEqual(f.state().domain, { minimum: 2.5, maximum: 12.5 });
    assert.equal(f.state().enabled, false);
    f.data(17_000_000n); f.flush();
    assert.deepEqual(f.state().domain, { minimum: 6, maximum: 16 });
    assert.equal(f.app.graphPolicy.originTimestampUs, 1_000_000n);
  } finally { f.dispose(); }
});

test("mounted range-only review and stopped 10/30/60 windows share one history across modes", async () => {
  const f = fixture();
  try {
    await f.start(); f.window(10);
    for (let i = 0; i <= 2000; i++) f.data(1_000_000n + BigInt(i) * 40_000n);
    await f.stop(); f.flush();
    const records = f.owner.model.recordSnapshot(); const latest = f.owner.model.latest;
    const runtime = f.owner.snapshot(); const modelState = f.owner.model.summary();
    const decoder = f.owner.adapter.decoderState; const counts = { ...f.counts };
    assert.deepEqual(f.state().domain, { minimum: 70, maximum: 80 });
    const slider = f.root.querySelector("[data-history-position]");
    assert.equal(slider.tag, "input"); assert.equal(slider.disabled, false);
    for (const removed of ["back", "forward", "latest", "values"]) assert.equal(f.root.querySelector(`[data-history-${removed}]`), null);
    f.position(500); assert.deepEqual(f.state().domain, { minimum: 35, maximum: 45 });
    f.position(1000); assert.equal(f.state().domain.maximum, 80);
    f.position(0); f.flush(); assert.deepEqual(f.state().domain, { minimum: 0, maximum: 10 });
    assert.strictEqual(f.root.querySelector("[data-history-position]"), slider);
    assert.equal(f.root.querySelector("[data-history-position]").getAttribute("aria-valuetext"), "0.0–10.0 s");
    for (const mode of ["professional", "student"]) {
      f.app.controller.setMode(mode);
      for (const seconds of [10, 30, 60]) {
        f.window(seconds); f.position(0); f.flush();
        assert.deepEqual(f.state().domain, { minimum: 0, maximum: seconds });
        const frames = f.app.graphPolicy.update(records, { originTimestampUs: f.state().originTimestampUs, rightEdgeTimestampUs: f.state().rightEdge });
        assert.equal(frames.voltage.paths.flat().at(-1).x, seconds);
        assert.equal(frames.current.paths.flat().at(-1).x, seconds);
      }
      f.position(1000); f.flush(); assert.deepEqual(f.state().domain, { minimum: 20, maximum: 80 });
    }
    assert.deepEqual(f.counts, counts);
    assert.strictEqual(f.owner.model, runtime.model); assert.strictEqual(f.owner.adapter, runtime.adapter); assert.strictEqual(f.owner.source, runtime.source);
    assert.strictEqual(f.owner.model.latest, latest); assert.strictEqual(f.owner.adapter.decoderState, decoder);
    assert.deepEqual(f.owner.model.recordSnapshot(), records);
    assert.deepEqual(f.owner.model.summary(), modelState);
  } finally { f.dispose(); }
});

test("normal end gate excludes early stopped, abort, timeout and disconnect, but preserves normal owned close", async () => {
  for (const outcome of ["normal", "abort", "timeout", "disconnect"]) {
    const f = fixture();
    try {
      assert.equal(f.owner.stoppedHistoryReady, false);
      await f.start(); f.data(0n); f.data(20_000_000n);
      f.stopped(); assert.equal(f.owner.stoppedHistoryReady, false);
      await f.owner.actions.stop(); f.end(); assert.equal(f.owner.stoppedHistoryReady, false);
      if (outcome === "normal") {
        f.stopped(); assert.equal(f.owner.stoppedHistoryReady, true);
        await f.owner.actions.close(); assert.equal(f.owner.adapter.controlState, "CLOSED");
        assert.equal(f.owner.stoppedHistoryReady, true);
      } else {
        if (outcome === "abort") f.socket().error();
        if (outcome === "timeout") f.timeout();
        if (outcome === "disconnect") f.socket().disconnect();
        assert.equal(f.owner.stoppedHistoryReady, false);
        f.position(0); assert.equal(f.state().enabled, false);
      }
    } finally { f.dispose(); }
  }
});

test("new stream including reused ID after reconnect isolates epoch and clears review cursor", async () => {
  const f = fixture();
  try {
    await f.start(1); f.data(0n); f.data(80_000_000n); await f.stop();
    f.window(10); f.position(0); const epoch = f.owner.model.historyEpoch;
    await f.owner.actions.close(); await f.start(1);
    assert.equal(f.owner.model.records.size, 0); assert.equal(f.owner.model.historyEpoch, epoch + 1);
    assert.equal(f.state().enabled, false); assert.equal(f.app.historyReview.rightEdgeTimestampUs, null);
    f.data(9_000_000_000n); f.data(9_020_000_000n); await f.stop();
    assert.deepEqual(f.state().domain, { minimum: 10, maximum: 20 });
    assert.equal(f.owner.model.recordSnapshot().length, 2);
  } finally { f.dispose(); }
});

test("TIMEBASE_RESET and gap/invalid records preserve exact stopped geometry without bridging", async () => {
  const f = fixture();
  try {
    await f.start(); f.window(10); f.data(50_000_000n); f.flush();
    await f.stop(); await f.start(2);
    f.data(1_000_000n, { flags: 0x45 }); f.data(1_040_000n);
    f.data(1_200_000n, { sequence: 7n, flags: 4 });
    f.data(1_240_000n, { validMask: 1 }); f.data(1_280_000n);
    await f.stop(); f.flush();
    assert.equal(f.owner.model.historyOriginTimestampUs, 1_000_000n);
    assert.equal(f.owner.model.records.size, 5);
    const frame = f.app.graphPolicy.update(f.owner.model.recordSnapshot(), { originTimestampUs: f.state().originTimestampUs, rightEdgeTimestampUs: f.state().rightEdge });
    assert.deepEqual(frame.current.paths.map(path => path.map(point => point.x)), [[0, 0.04]]);
    assert.deepEqual(frame.current.invalid, [{ seconds: 0.24 }]);
    assert.deepEqual(frame.voltage.paths.map(path => path.map(point => point.x)), [[0, 0.04], [0.2, 0.24, 0.28]]);
    assert.equal(frame.current.domain.minimum, 0);
  } finally { f.dispose(); }
});

test("truncated retained history has a visible warning in Student and Professional", async () => {
  const f = fixture();
  try {
    await f.start();
    for (let i = 0; i < 4097; i++) f.data(BigInt(i) * 40_000n);
    await f.stop();
    for (const mode of ["student", "professional"]) {
      f.app.controller.setMode(mode);
      assert.match(f.root.querySelector("[data-history-status]").textContent, /古い測定値は削除/);
      f.position(0); assert.ok(Math.abs(f.state().domain.minimum - 0.04) < 1e-12);
      f.position(1000);
      f.pointer("current", "down", 1); f.pointer("current", "move", 1, 100000); f.pointer("current", "up", 1);
      assert.ok(Math.abs(f.state().domain.minimum - 0.04) < 1e-12, "pan clamps to oldest retained timestamp after eviction");
    }
  } finally { f.dispose(); }
});

test("numeric cards show no stopped-value suffix before data and retain valid final values after normal Stop", async () => {
  const f = fixture();
  const card = channel => f.root.querySelector(`[data-live="${channel}"]`).textContent;
  try {
    for (const mode of ["student", "professional"]) {
      f.app.controller.setMode(mode);
      for (const channel of ["voltage", "current"]) { assert.match(card(channel), /—.*データなし/); assert.doesNotMatch(card(channel), /停止時の値/); }
    }
    await f.start(); f.data(0n, { validMask: 0 }); await f.stop();
    for (const channel of ["voltage", "current"]) assert.doesNotMatch(card(channel), /停止時の値/);
    await f.start(2); f.data(0n, { voltage: 3.25, current: -0.0001 }); f.flush();
    assert.match(card("voltage"), /3.25 V/); assert.match(card("current"), /-0.1 mA/);
    assert.doesNotMatch(card("current"), /停止時の値/);
    await f.stop();
    for (const mode of ["student", "professional"]) {
      f.app.controller.setMode(mode);
      assert.match(card("voltage"), /3.25 V.*停止時の値/); assert.match(card("current"), /-0.1 mA.*停止時の値/);
    }
    assert.ok(f.owner.model.latest.current_A < 0 && Math.abs(f.owner.model.latest.current_A) < 0.001, "model remains signed A");
  } finally { f.dispose(); }
});

test("classroom controls have axis-specific accessible names, range-only review and mode toggle last", async () => {
  const f = fixture();
  try {
    for (const mode of ["student", "professional"]) {
      f.app.controller.setMode(mode);
      const html = f.root.innerHTML;
      assert.match(html, /横軸 \/ Display window/);
      for (const seconds of [1,2,5,10,30,60]) assert.ok(html.includes(`${seconds} 秒 / ${seconds === 1 ? "second" : "seconds"}</option>`));
      for (const channel of ["voltage", "current"]) {
        for (const direction of ["in", "out"]) assert.match(f.root.querySelector(`[data-zoom-${direction}="${channel}"]`).getAttribute("aria-label"), new RegExp(`${channel === "voltage" ? "Voltage" : "Current"} scale zoom ${direction}`));
        assert.equal(f.root.querySelector(`[data-scale-readout="${channel}"]`), null);
      }
      assert.doesNotMatch(html, /disabled>電[圧流].*(?:拡大|縮小)|[µμ]A|data-history-(?:back|forward|latest|values)/);
      assert.match(html, />拡大 \/ Zoom in<\/button>/); assert.match(html, />縮小 \/ Zoom out<\/button>/);
      for (const earlier of ["data-display-window", "data-history-status", "data-history-position", "data-history-window"]) assert.ok(html.indexOf(earlier) < html.indexOf('id="toggle"'));
    }
    await f.start(); f.data(0n); f.data(12_500_000n); await f.stop(); f.window(10);
    assert.match(f.root.querySelector("[data-history-window]").textContent, /^表示中の時間 \/ Displayed time: 2.5–12.5 s$/);
  } finally { f.dispose(); }
});
