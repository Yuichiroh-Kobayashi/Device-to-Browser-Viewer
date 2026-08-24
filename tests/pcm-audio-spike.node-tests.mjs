// DOM-free automated tests for the additive experimental pcm-audio spike
// (src/experiments/pcm-audio/). Same invocation convention as
// tests/node-self-tests.mjs: `node --test tests/pcm-audio-spike.node-tests.mjs`
// or `node tests/pcm-audio-spike.node-tests.mjs`.
import assert from "node:assert/strict";
import test from "node:test";

import { createDecoderState } from "../src/protocol/d2b-reference/decoder-state.js";
import { decodeBinaryFrame } from "../src/protocol/d2b-reference/decoder.js";
import { PCM_PARAMETERS } from "../src/protocol/d2b-reference/protocol-constants.js";
import { ProtocolError } from "../src/protocol/d2b-reference/errors.js";

import { PcmAudioModel, MAX_FRAMES, MAX_MARKERS } from "../src/experiments/pcm-audio/pcm-audio-model.js";
import { PcmSessionAdapter } from "../src/experiments/pcm-audio/pcm-session-adapter.js";
import {
  buildPcmScenarioPlan, generateSineSamples, generateHarmonicSamples, makePcmFrame, makeStreamEndFrame,
  makeBadMagicFrame, makeWrongSampleCountFrame, makeTruncatedPayloadFrame, makeHelloText, makeWelcomeText,
  makeStartText, makeStartedText, makeStopText, makeStoppedText, pcmTimestampForSequence,
  PCM_SYNTHETIC_SCENARIOS, ENVELOPE_SIZE, FRAME_SIZE, PAYLOAD_SIZE,
} from "../src/experiments/pcm-audio/synthetic-pcm-source.js";

const FLAG_STREAM_START = 0x01;
const FLAG_DISCONTINUITY = 0x04;
const FLAG_PRODUCER_OVERFLOW = 0x08;
const FLAG_OUTPUT_QUEUE_DROP = 0x10;
const FLAG_TIMEBASE_RESET = 0x40;

function freshDecoderState(streamId = 1, maximumBinaryFrameSize = 65536) {
  return createDecoderState({
    negotiated_version: "0.1",
    session_state: "STREAMING",
    maximum_binary_frame_size: maximumBinaryFrameSize,
    stream_id: streamId,
    profile: "pcm-audio",
    parameters: PCM_PARAMETERS,
  });
}

function silentSamples() {
  return new Int16Array(PCM_PARAMETERS.samples_per_frame);
}

function countZeroCrossings(samples) {
  let crossings = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) crossings += 1;
  }
  return crossings;
}

function readyAdapter() {
  const model = new PcmAudioModel();
  const adapter = new PcmSessionAdapter(model);
  adapter.notifyTransportStatus({ state: "open" });
  assert.equal(adapter.handleControl({ direction: "client_to_server", text: makeHelloText() }), true);
  assert.equal(adapter.handleControl({ direction: "server_to_client", text: makeWelcomeText() }), true);
  assert.equal(adapter.controlState, "READY");
  return { model, adapter };
}

function startPcm(adapter, streamId = 1) {
  assert.equal(adapter.handleControl({ direction: "client_to_server", text: makeStartText() }), true);
  assert.equal(adapter.handleControl({ direction: "server_to_client", text: makeStartedText(streamId) }), true);
  assert.equal(adapter.controlState, "STREAMING");
}

function driveScenario(scenarioId) {
  const { model, adapter } = readyAdapter();
  const acceptedBinary = [];
  const rejectedBinary = [];
  for (const event of buildPcmScenarioPlan(scenarioId)) {
    if (event.kind === "transport") {
      adapter.notifyTransportStatus({ state: event.state });
    } else if (event.kind === "control") {
      assert.equal(adapter.handleControl({ direction: event.direction, text: event.text }), true, `${scenarioId} control rejected: ${event.text}`);
    } else {
      if (adapter.handleBinary(event.buffer)) acceptedBinary.push(event); else rejectedBinary.push(event);
    }
  }
  return { model, adapter, acceptedBinary, rejectedBinary };
}

// --- 1. Exact 544-byte frame acceptance by the reference decoder ---------

test("pcm-audio: a spec-correct 544-byte frame is byte-exact and accepted by the real reference decoder", () => {
  const samples = generateSineSamples({ frequencyHz: 440 });
  const frame = makePcmFrame({ streamId: 7, sequence: 0n, timestampUs: 1_000_000n, flags: FLAG_STREAM_START, samples });
  assert.equal(frame.byteLength, FRAME_SIZE);
  assert.equal(FRAME_SIZE, ENVELOPE_SIZE + PAYLOAD_SIZE);
  assert.equal(frame.byteLength, 544);

  const state = freshDecoderState(7);
  const { decoded, nextState } = decodeBinaryFrame(frame, state);
  assert.equal(decoded.sample_count, 256);
  assert.equal(decoded.payload_length, 512);
  assert.equal(decoded.stream_id, 7);
  assert.equal(decoded.stream_start, true);
  assert.equal(decoded.samples.length, 256);
  assert.equal(nextState.acceptedData, true);
});

// --- 2. BigInt sequence/timestamp handling --------------------------------

test("pcm-audio: decoded sequence, timestamp, and gap fields are BigInt end to end", () => {
  const state = freshDecoderState(1);
  const frame = makePcmFrame({ streamId: 1, sequence: 0n, timestampUs: 2_000_000n, flags: FLAG_STREAM_START, samples: silentSamples() });
  const { decoded } = decodeBinaryFrame(frame, state);
  assert.equal(typeof decoded.first_sample_sequence, "bigint");
  assert.equal(typeof decoded.first_timestamp_us, "bigint");
  assert.equal(typeof decoded.gap_samples, "bigint");
  assert.equal(decoded.first_sample_sequence, 0n);
  assert.equal(decoded.first_timestamp_us, 2_000_000n);

  const model = new PcmAudioModel();
  model.beginStream({ streamId: 1, profile: "pcm-audio", sampleRate: PCM_PARAMETERS.sample_rate, samplesPerFrame: 256 });
  const candidate = model.prepareDecodedFrame({ ...decoded, segment: { streamId: 1, startSequence: 0n, startTimestampUs: 2_000_000n, gapSamples: 0n, causes: { producerOverflow: false, outputQueueDrop: false, sourcePaused: false, timebaseReset: false } } });
  model.commitCandidate(candidate);
  assert.equal(typeof model.latest.sequence, "bigint");
  assert.equal(typeof model.latest.timestamp_us, "bigint");
});

// --- 3. Anchor timestamp + later rational-timestamp validation -----------

test("pcm-audio: anchor timestamp is set by the first frame and later frames are validated against the rational formula", () => {
  const anchorTimestampUs = 3_000_000n;
  let state = freshDecoderState(9);
  const first = makePcmFrame({ streamId: 9, sequence: 0n, timestampUs: anchorTimestampUs, flags: FLAG_STREAM_START, samples: silentSamples() });
  const firstResult = decodeBinaryFrame(first, state);
  assert.equal(firstResult.nextState.anchor.sequence, 0n);
  assert.equal(firstResult.nextState.anchor.timestampUs, anchorTimestampUs);
  state = firstResult.nextState;

  const correctTimestamp = pcmTimestampForSequence(0n, anchorTimestampUs, 256n);
  assert.equal(correctTimestamp, anchorTimestampUs + 16_000n); // 256 samples / 16 kHz = 16 ms = 16,000 us exactly
  const secondGood = makePcmFrame({ streamId: 9, sequence: 256n, timestampUs: correctTimestamp, flags: 0, samples: silentSamples() });
  const secondResult = decodeBinaryFrame(secondGood, state);
  assert.equal(secondResult.decoded.first_timestamp_us, correctTimestamp);

  const wrongTimestamp = correctTimestamp + 500n; // 500 us off: far outside the 1-tick (~1 us) tolerance
  const secondBad = makePcmFrame({ streamId: 9, sequence: 256n, timestampUs: wrongTimestamp, flags: 0, samples: silentSamples() });
  assert.throws(() => decodeBinaryFrame(secondBad, state), (error) => error instanceof ProtocolError && error.code === "pcm_timestamp_out_of_tolerance");
});

// --- 4. 440 Hz vs 880 Hz sample generation correctness --------------------

test("pcm-audio: 440 Hz and 880 Hz synthetic sine generation produce distinct, correctly related periods", () => {
  const count = 256 * 4; // several periods at both frequencies within 16 kHz
  const tone440 = generateSineSamples({ frequencyHz: 440, count, amplitude: 0.8 });
  const tone880 = generateSineSamples({ frequencyHz: 880, count, amplitude: 0.8 });
  assert.equal(tone440.length, count);
  assert.equal(tone880.length, count);
  // Every generated sample must be a valid signed 16-bit integer.
  for (const sample of tone440) assert.ok(Number.isInteger(sample) && sample >= -32768 && sample <= 32767);

  const crossings440 = countZeroCrossings(tone440);
  const crossings880 = countZeroCrossings(tone880);
  assert.ok(crossings440 > 0 && crossings880 > 0);
  // 880 Hz has exactly double the frequency of 440 Hz, so over the same
  // sample window it must cross zero roughly twice as often.
  const ratio = crossings880 / crossings440;
  assert.ok(ratio > 1.7 && ratio < 2.3, `expected ~2x zero crossings, got ratio ${ratio}`);

  // Sample-exact spot check against the closed-form definition at t=0 (sin(0)=0).
  assert.equal(tone440[0], 0);
  assert.equal(tone880[0], 0);
});

test("pcm-audio: harmonic generation is the same fundamental pitch as A1 but a visibly different waveform shape", () => {
  const count = 256 * 4;
  const fundamentalOnly = generateSineSamples({ frequencyHz: 440, count, amplitude: 0.6 });
  const withHarmonics = generateHarmonicSamples({ fundamentalHz: 440, count, amplitude: 0.6 });
  const crossingsFundamental = countZeroCrossings(fundamentalOnly);
  const crossingsHarmonics = countZeroCrossings(withHarmonics);
  // Same fundamental pitch: zero-crossing counts (driven by the 440 Hz term)
  // stay close, even though the waveforms differ pointwise.
  assert.ok(Math.abs(crossingsHarmonics - crossingsFundamental) <= 2, "harmonic content should not change the fundamental period materially");
  let differingSamples = 0;
  for (let index = 0; index < count; index += 1) if (fundamentalOnly[index] !== withHarmonics[index]) differingSamples += 1;
  assert.ok(differingSamples > count * 0.5, "harmonic waveform must be visibly different in shape from the pure tone");
});

// --- 5-7: full scenario runs through the REAL reference decoder ----------

test("pcm-audio: every A1-A10 scenario id is enumerated and buildable", () => {
  const ids = PCM_SYNTHETIC_SCENARIOS.map((item) => item.id);
  assert.equal(ids.length, 10);
  for (const id of ids) assert.ok(buildPcmScenarioPlan(id).length > 0);
});

test("pcm-audio A1/A2: sine scenarios fully decode and 880 Hz retains a visibly shorter period than 440 Hz in the retained model", () => {
  const a1 = driveScenario("a1-sine-440");
  const a2 = driveScenario("a2-sine-880");
  assert.equal(a1.rejectedBinary.length, 0);
  assert.equal(a2.rejectedBinary.length, 0);
  assert.equal(a1.model.summary().frameCount, 20);
  assert.equal(a2.model.summary().frameCount, 20);

  const flat440 = a1.model.frameSnapshot().flatMap((frame) => Array.from(frame.samples));
  const flat880 = a2.model.frameSnapshot().flatMap((frame) => Array.from(frame.samples));
  const ratio = countZeroCrossings(flat880) / countZeroCrossings(flat440);
  assert.ok(ratio > 1.7 && ratio < 2.3, `A2 should cross zero ~2x as often as A1, got ${ratio}`);
});

test("pcm-audio A3: harmonics scenario decodes and its waveform differs from A1's pure tone at the same nominal pitch", () => {
  const a1 = driveScenario("a1-sine-440");
  const a3 = driveScenario("a3-harmonics-440");
  assert.equal(a3.rejectedBinary.length, 0);
  const flat1 = a1.model.frameSnapshot().flatMap((frame) => Array.from(frame.samples));
  const flat3 = a3.model.frameSnapshot().flatMap((frame) => Array.from(frame.samples));
  assert.notDeepEqual(flat1, flat3);
  const crossings1 = countZeroCrossings(flat1);
  const crossings3 = countZeroCrossings(flat3);
  assert.ok(Math.abs(crossings1 - crossings3) <= 4, "A3 must keep A1's fundamental period");
});

test("pcm-audio A4: a mid-stream amplitude step keeps the period but visibly changes amplitude", () => {
  const a4 = driveScenario("a4-amplitude-step");
  assert.equal(a4.rejectedBinary.length, 0);
  const frames = a4.model.frameSnapshot();
  assert.equal(frames.length, 20);
  const rms = (samples) => Math.sqrt(Array.from(samples).reduce((sum, v) => sum + (v / 32768) ** 2, 0) / samples.length);
  const before = rms(frames[2].samples);
  const after = rms(frames[17].samples);
  assert.ok(after > before * 2, `expected a visible amplitude step, got before=${before} after=${after}`);
  const crossingsBefore = countZeroCrossings(frames[2].samples);
  const crossingsAfter = countZeroCrossings(frames[17].samples);
  assert.ok(Math.abs(crossingsBefore - crossingsAfter) <= 1, "period (crossings per frame) must stay unchanged across the amplitude step");
});

test("pcm-audio A5: a plain sequence gap sets DISCONTINUITY and a sequence-gap marker without a cause flag", () => {
  const { model, rejectedBinary } = driveScenario("a5-gap-discontinuity");
  assert.equal(rejectedBinary.length, 0);
  const summary = model.summary();
  assert.equal(summary.sequenceGapCount, 1);
  assert.equal(summary.sequenceGapSamples, "768"); // 3 omitted frames * 256 samples
  const gapMarker = model.markerSnapshot().find((marker) => marker.kind === "sequence-gap");
  assert.ok(gapMarker, "expected a sequence-gap marker");
  assert.equal(gapMarker.gap_samples, 768n);
  assert.equal(gapMarker.causes.producerOverflow, false);
  assert.equal(gapMarker.causes.outputQueueDrop, false);
});

test("pcm-audio A6: PRODUCER_OVERFLOW cause flag requires and pairs with a positive gap and DISCONTINUITY", () => {
  const { model, rejectedBinary } = driveScenario("a6-producer-overflow");
  assert.equal(rejectedBinary.length, 0);
  assert.equal(model.summary().producerOverflowCount, 1);
  assert.equal(model.summary().sequenceGapSamples, "1024"); // 4 omitted frames * 256
  const marker = model.markerSnapshot().find((entry) => entry.causes.producerOverflow);
  assert.ok(marker);
  assert.ok(marker.gap_samples > 0n);
});

test("pcm-audio A7: OUTPUT_QUEUE_DROP cause flag requires and pairs with a positive gap and DISCONTINUITY", () => {
  const { model, rejectedBinary } = driveScenario("a7-output-queue-drop");
  assert.equal(rejectedBinary.length, 0);
  assert.equal(model.summary().outputQueueDropCount, 1);
  assert.equal(model.summary().sequenceGapSamples, "512"); // 2 omitted frames * 256
  const marker = model.markerSnapshot().find((entry) => entry.causes.outputQueueDrop);
  assert.ok(marker);
  assert.ok(marker.gap_samples > 0n);
});

test("pcm-audio: the reference decoder itself requires DISCONTINUITY whenever a cause flag is set (envelope-level invariant)", () => {
  const state = freshDecoderState(1);
  const first = makePcmFrame({ streamId: 1, sequence: 0n, timestampUs: 1_000_000n, flags: FLAG_STREAM_START, samples: silentSamples() });
  const { nextState } = decodeBinaryFrame(first, state);
  const badTimestamp = pcmTimestampForSequence(0n, 1_000_000n, 512n);
  const causeWithoutDiscontinuity = makePcmFrame({ streamId: 1, sequence: 512n, timestampUs: badTimestamp, flags: FLAG_PRODUCER_OVERFLOW, samples: silentSamples() });
  assert.throws(() => decodeBinaryFrame(causeWithoutDiscontinuity, nextState), (error) => error instanceof ProtocolError && error.code === "missing_discontinuity_flag");
});

test("pcm-audio: a cause flag with DISCONTINUITY but zero actual gap is rejected (cause_flag_without_gap)", () => {
  const state = freshDecoderState(1);
  const first = makePcmFrame({ streamId: 1, sequence: 0n, timestampUs: 1_000_000n, flags: FLAG_STREAM_START, samples: silentSamples() });
  const { nextState } = decodeBinaryFrame(first, state);
  const contiguousTimestamp = pcmTimestampForSequence(0n, 1_000_000n, 256n);
  const noGapButCause = makePcmFrame({ streamId: 1, sequence: 256n, timestampUs: contiguousTimestamp, flags: FLAG_DISCONTINUITY | FLAG_OUTPUT_QUEUE_DROP, samples: silentSamples() });
  assert.throws(() => decodeBinaryFrame(noGapButCause, nextState), (error) => error instanceof ProtocolError && error.code === "cause_flag_without_gap");
});

test("pcm-audio A8: reconnect breaks continuity into two independently-valid streams and does not join them visually", () => {
  const { model, rejectedBinary } = driveScenario("a8-reconnect");
  assert.equal(rejectedBinary.length, 0);
  const frames = model.frameSnapshot();
  // The second stream's beginStream() clears the viewport, so only the
  // post-reconnect stream remains retained; every retained frame must be one
  // consistent stream/epoch (a rendering break was already enforced by the
  // model boundary, this proves no cross-stream frame survived in the ring).
  assert.ok(frames.length > 0);
  const streamIds = new Set(frames.map((frame) => frame.stream_id));
  assert.deepEqual([...streamIds], [2]);
  const epochIds = new Set(frames.map((frame) => frame.epoch_id));
  assert.equal(epochIds.size, 1);
});

test("pcm-audio A9: TIMEBASE_RESET carries a new stream_id, STREAM_START, and DISCONTINUITY, and starts a fresh epoch", () => {
  const { model, adapter, rejectedBinary } = driveScenario("a9-timebase-reset");
  assert.equal(rejectedBinary.length, 0);
  const frames = model.frameSnapshot();
  assert.ok(frames.length > 0);
  const first = frames[0];
  assert.equal(first.stream_id, 2, "post-reset frames must carry a new stream_id");
  assert.equal(first.flags.timebase_reset, true);
  assert.equal(first.flags.stream_start, true);
  assert.equal(first.flags.discontinuity, true);
  const streamIds = new Set(frames.map((frame) => frame.stream_id));
  assert.deepEqual([...streamIds], [2], "no pre-reset stream_id 1 frame may remain visually joined");
  assert.equal(adapter.controlState, "READY");
});

// --- 8. Bounded-state cap enforcement (proved by exceeding it) -----------

function decodedPcmFrame({ streamId, sequence, timestampUs, flags = 0, gapSamples = 0n, withSegment = true }) {
  return {
    stream_id: streamId,
    sample_count: 256,
    samples: Array.from(silentSamples()),
    flags,
    gap_samples: gapSamples,
    first_sample_sequence: sequence,
    first_timestamp_us: timestampUs,
    stream_start: Boolean(flags & FLAG_STREAM_START),
    stream_end: false,
    discontinuity: Boolean(flags & FLAG_DISCONTINUITY),
    producer_overflow: Boolean(flags & FLAG_PRODUCER_OVERFLOW),
    output_queue_drop: false,
    source_paused: false,
    timebase_reset: Boolean(flags & FLAG_TIMEBASE_RESET),
    segment: withSegment ? {
      streamId, startSequence: sequence, startTimestampUs: timestampUs, gapSamples,
      causes: { producerOverflow: false, outputQueueDrop: false, sourcePaused: false, timebaseReset: Boolean(flags & FLAG_TIMEBASE_RESET) },
    } : null,
  };
}

test("pcm-audio: MAX_FRAMES is the model's real cap and PcmAudioModel rejects a larger explicit capacity", () => {
  assert.throws(() => new PcmAudioModel({ capacity: MAX_FRAMES + 1 }), RangeError);
  assert.throws(() => new PcmAudioModel({ capacity: 0 }), RangeError);
});

test("pcm-audio: the retained-frame ring is bounded and evicts oldest-first once exceeded (proved by exceeding it, not just documented)", () => {
  const capacity = 5;
  const model = new PcmAudioModel({ capacity });
  model.beginStream({ streamId: 1, profile: "pcm-audio", sampleRate: PCM_PARAMETERS.sample_rate, samplesPerFrame: 256 });
  const totalFrames = capacity + 7;
  for (let index = 0; index < totalFrames; index += 1) {
    const sequence = BigInt(index) * 256n;
    const timestampUs = pcmTimestampForSequence(0n, 1_000_000n, sequence);
    const flags = index === 0 ? FLAG_STREAM_START : 0;
    const candidate = model.prepareDecodedFrame(decodedPcmFrame({ streamId: 1, sequence, timestampUs, flags, withSegment: index === 0 }));
    model.commitCandidate(candidate);
  }
  const summary = model.summary();
  assert.equal(summary.bufferCapacity, capacity);
  assert.equal(summary.bufferUsage, capacity, "ring must never grow past its declared capacity");
  assert.equal(summary.frameCount, totalFrames, "the running counter still counts every accepted frame");
  assert.equal(summary.viewerEvictionCount, totalFrames - capacity, "eviction count must equal exactly the overflow");
  const retained = model.frameSnapshot();
  assert.equal(retained.length, capacity);
  assert.equal(retained[0].sequence, BigInt(totalFrames - capacity) * 256n, "the ring must hold exactly the newest `capacity` frames");
});

test("pcm-audio: the marker ring is independently bounded (MAX_MARKERS) and evicts oldest-first once exceeded", () => {
  const markerCapacity = 4;
  const model = new PcmAudioModel({ markerCapacity });
  model.beginStream({ streamId: 1, profile: "pcm-audio", sampleRate: PCM_PARAMETERS.sample_rate, samplesPerFrame: 256 });
  const totalGaps = markerCapacity + 6;
  let sequence = 0n;
  for (let index = 0; index < totalGaps; index += 1) {
    const timestampUs = pcmTimestampForSequence(0n, 1_000_000n, sequence);
    const flags = index === 0 ? FLAG_STREAM_START : FLAG_DISCONTINUITY;
    const candidate = model.prepareDecodedFrame(decodedPcmFrame({ streamId: 1, sequence, timestampUs, flags, gapSamples: index === 0 ? 0n : 256n, withSegment: true }));
    model.commitCandidate(candidate);
    sequence += 256n * 2n; // always leave a one-frame gap so every later frame carries a fresh marker
  }
  const summary = model.summary();
  assert.equal(summary.markerCapacity, markerCapacity);
  assert.equal(summary.markerUsage, markerCapacity);
  assert.equal(model.markerSnapshot().length, markerCapacity);
  assert.ok(MAX_MARKERS >= markerCapacity);
});

// --- 9. Malformed-frame transactional rollback ----------------------------

test("pcm-audio A10: malformed frames (bad magic, wrong sample_count, truncated payload) are rejected and never mutate the model (transactional rollback)", () => {
  const { model, adapter } = readyAdapter();
  startPcm(adapter, 1);
  const samples = generateSineSamples({ frequencyHz: 440 });
  const good = makePcmFrame({ streamId: 1, sequence: 0n, timestampUs: 1_000_000n, flags: FLAG_STREAM_START, samples });
  assert.equal(adapter.handleBinary(good), true);

  // rejectedFrameCount is an intentional rejection-diagnostic counter (see
  // PcmAudioModel.noteRejectedFrame) and is expected to increment; every
  // other field describes retained measurement state and must not move.
  const withoutRejectedCount = (summary) => {
    const { rejectedFrameCount, ...rest } = summary;
    return JSON.stringify(rest);
  };
  const beforeSummary = withoutRejectedCount(model.summary());
  const beforeLatest = model.latest;
  const beforeFrameCount = model.frameSnapshot().length;

  const nextSequence = 256n;
  const nextTimestamp = pcmTimestampForSequence(0n, 1_000_000n, nextSequence);
  const badMagic = makeBadMagicFrame({ streamId: 1, sequence: nextSequence, timestampUs: nextTimestamp, samples });
  const wrongCount = makeWrongSampleCountFrame({ streamId: 1, sequence: nextSequence, timestampUs: nextTimestamp, samples });
  const truncated = makeTruncatedPayloadFrame({ streamId: 1, sequence: nextSequence, timestampUs: nextTimestamp, samples });

  let expectedRejections = 0;
  for (const malformed of [badMagic, wrongCount, truncated]) {
    assert.equal(adapter.handleBinary(malformed), false, "malformed frame must be rejected");
    expectedRejections += 1;
    assert.equal(withoutRejectedCount(model.summary()), beforeSummary, "model summary (excluding the rejection counter itself) must be byte-identical after a rejected frame");
    assert.equal(model.summary().rejectedFrameCount, expectedRejections, "the rejection counter is the only thing allowed to move");
    assert.equal(model.latest, beforeLatest, "model.latest must be the same object reference: no mutation occurred");
    assert.equal(model.frameSnapshot().length, beforeFrameCount, "ring size must not change on rejection");
  }
  assert.ok(adapter.diagnostics().length >= 3, "each rejection must be diagnosed");

  // Proves the decoder/model state was not corrupted by the rejections: the
  // *same* next-sequence valid frame is still accepted afterward.
  const goodNext = makePcmFrame({ streamId: 1, sequence: nextSequence, timestampUs: nextTimestamp, flags: 0, samples });
  assert.equal(adapter.handleBinary(goodNext), true);
  assert.equal(model.summary().frameCount, 2);
});

// --- 10. Open/Start/Stop/Close lifecycle, including a wrong-state negative case ---

test("pcm-audio: full Open/Start/Stop/Close control lifecycle succeeds in order", () => {
  const { model, adapter } = readyAdapter();
  startPcm(adapter, 1);
  const samples = generateSineSamples({ frequencyHz: 440 });
  assert.equal(adapter.handleBinary(makePcmFrame({ streamId: 1, sequence: 0n, timestampUs: 1_000_000n, flags: FLAG_STREAM_START, samples })), true);
  const nextSequence = 256n;
  const nextTimestamp = pcmTimestampForSequence(0n, 1_000_000n, nextSequence);

  assert.equal(adapter.handleControl({ direction: "client_to_server", text: makeStopText(1) }), true);
  assert.equal(adapter.stopRequested, true);
  assert.equal(adapter.handleBinary(makeStreamEndFrame({ streamId: 1, sequence: nextSequence, timestampUs: nextTimestamp })), true);
  assert.equal(adapter.handleControl({ direction: "server_to_client", text: makeStoppedText(1) }), true);
  assert.equal(adapter.controlState, "READY");

  adapter.notifyTransportStatus({ state: "closed" });
  assert.equal(adapter.controlState, "CLOSED");
  assert.equal(model.summary().frameCount, 1);
});

test("pcm-audio: wrong-state negative cases are rejected without corrupting state (Start before READY, Stop outside STREAMING, binary outside STREAMING)", () => {
  const model = new PcmAudioModel();
  const adapter = new PcmSessionAdapter(model);
  // start_stream is illegal before CONNECTED/READY.
  assert.equal(adapter.handleControl({ direction: "client_to_server", text: makeStartText() }), false);
  assert.equal(adapter.controlState, "CLOSED");

  adapter.notifyTransportStatus({ state: "open" });
  assert.equal(adapter.handleControl({ direction: "client_to_server", text: makeHelloText() }), true);
  assert.equal(adapter.handleControl({ direction: "server_to_client", text: makeWelcomeText() }), true);
  assert.equal(adapter.controlState, "READY");

  // stop_stream is illegal while READY (nothing is streaming yet).
  assert.equal(adapter.handleControl({ direction: "client_to_server", text: makeStopText(1) }), false);
  assert.equal(adapter.controlState, "READY");
  assert.equal(adapter.stopRequested, false);

  // Binary data is illegal outside STREAMING.
  const samples = generateSineSamples({ frequencyHz: 440 });
  const frame = makePcmFrame({ streamId: 1, sequence: 0n, timestampUs: 1_000_000n, flags: FLAG_STREAM_START, samples });
  assert.equal(adapter.handleBinary(frame), false);
  assert.equal(model.summary().frameCount, 0);
  assert.ok(adapter.diagnostics().some((entry) => entry.code === "binary_outside_streaming"));

  // Now drive it forward correctly to prove the earlier rejections did not corrupt anything.
  startPcm(adapter, 1);
  assert.equal(adapter.handleBinary(frame), true);
  assert.equal(model.summary().frameCount, 1);
});

test("pcm-audio: outbound control reservation commit/rollback pattern behaves transactionally", () => {
  const model = new PcmAudioModel();
  const adapter = new PcmSessionAdapter(model);
  adapter.notifyTransportStatus({ state: "open" });

  const token = adapter.prepareOutboundControl(makeHelloText());
  assert.equal(adapter.helloSeen, false);
  adapter.rollbackOutboundControl(token);
  assert.equal(adapter.helloSeen, false);
  assert.equal(adapter._helloReserved, false);

  const secondToken = adapter.prepareOutboundControl(makeHelloText());
  adapter.commitOutboundControl(secondToken);
  assert.equal(adapter.helloSeen, true);

  assert.throws(() => adapter.commitOutboundControl(secondToken), TypeError);
});
