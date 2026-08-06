// SPDX-License-Identifier: Apache-2.0

import { fail } from "./errors.js";
import { parseEnvelope } from "./binary-envelope.js";
import {
  FLAG_DISCONTINUITY, FLAG_OUTPUT_QUEUE_DROP, FLAG_PRODUCER_OVERFLOW, FLAG_SOURCE_PAUSED,
  FLAG_STREAM_START, FLAG_TIMEBASE_RESET, FRAME_STREAM_END, UINT64_MAX,
} from "./protocol-constants.js";
import { requireActiveDecoderState, publishCandidate } from "./decoder-state.js";
import { decodeViMeasurement } from "./profiles/vi-measurement.js";
import { decodePcmAudio } from "./profiles/pcm-audio.js";

const STRUCTURAL_PCM_PARAMETERS = Object.freeze({
  sample_format: "pcm-s16le-interleaved",
  channel_count: 1,
  channel_mask: 1,
  sample_rate: Object.freeze({ numerator: 16000, denominator: 1 }),
  samples_per_frame: 256,
});

function flags(envelope) {
  return Object.freeze({
    discontinuity: Boolean(envelope.flags & FLAG_DISCONTINUITY),
    producerOverflow: Boolean(envelope.flags & FLAG_PRODUCER_OVERFLOW),
    outputQueueDrop: Boolean(envelope.flags & FLAG_OUTPUT_QUEUE_DROP),
    streamStart: Boolean(envelope.flags & FLAG_STREAM_START),
    streamEnd: envelope.frameType === FRAME_STREAM_END,
    sourcePaused: Boolean(envelope.flags & FLAG_SOURCE_PAUSED),
    timebaseReset: Boolean(envelope.flags & FLAG_TIMEBASE_RESET),
  });
}

function validateContinuity(envelope, state, decodedFlags) {
  const result = { gapSamples: 0n, anchor: state?.anchor ?? null };
  if (state === null) return result;
  if (envelope.streamId !== state.streamId) fail("stream_id_mismatch");
  const isData = envelope.frameType !== FRAME_STREAM_END;
  if (isData && !state.acceptedData && !decodedFlags.streamStart) fail("missing_stream_start");
  if (decodedFlags.timebaseReset && state.acceptedData) fail("timebase_reset_requires_new_session");
  if (decodedFlags.streamStart && state.acceptedData) fail("unexpected_stream_start");
  if (state.acceptedData) {
    const expected = state.previous.firstSequence + state.previous.sampleCount;
    if (expected > UINT64_MAX) fail("sequence_overflow");
    if (envelope.firstSequence < expected) fail("sequence_regression");
    result.gapSamples = envelope.firstSequence - expected;
    if (result.gapSamples > 0n && !decodedFlags.discontinuity) fail("missing_discontinuity_flag");
    if (state.profile === "pcm-audio" && isData && (decodedFlags.producerOverflow || decodedFlags.outputQueueDrop || decodedFlags.sourcePaused) && result.gapSamples === 0n) fail("cause_flag_without_gap");
    const previousTimestamp = state.profile === "vi-measurement" ? state.previous.lastTimestampUs : state.previous.firstTimestampUs;
    if (envelope.firstTimestampUs < previousTimestamp) fail("timestamp_regression");
  }
  if (state.profile === "pcm-audio" && isData) {
    const anchor = state.anchor ?? { sequence: envelope.firstSequence, timestampUs: envelope.firstTimestampUs };
    if (envelope.firstSequence < anchor.sequence) fail("sequence_regression");
    const rate = state.parameters.sample_rate;
    const numerator = BigInt(rate.numerator);
    const expectedNumerator = anchor.timestampUs * numerator + (envelope.firstSequence - anchor.sequence) * BigInt(rate.denominator) * 1000000n;
    const actualNumerator = envelope.firstTimestampUs * numerator;
    const difference = actualNumerator >= expectedNumerator ? actualNumerator - expectedNumerator : expectedNumerator - actualNumerator;
    if (difference > numerator) fail("pcm_timestamp_out_of_tolerance");
    result.anchor = anchor;
    result.pcmExpectedTimestampFloorUs = expectedNumerator / numerator;
  }
  return result;
}

function newSegment(state, envelope, decodedFlags, continuity) {
  if (state === null || envelope.frameType === FRAME_STREAM_END) return null;
  if (!(!state.acceptedData || decodedFlags.streamStart || decodedFlags.discontinuity || decodedFlags.timebaseReset || continuity.gapSamples > 0n)) return null;
  return Object.freeze({
    id: state.nextSegmentId,
    streamId: envelope.streamId,
    startSequence: envelope.firstSequence,
    startTimestampUs: envelope.firstTimestampUs,
    gapSamples: continuity.gapSamples,
    causes: Object.freeze({
      producerOverflow: decodedFlags.producerOverflow,
      outputQueueDrop: decodedFlags.outputQueueDrop,
      sourcePaused: decodedFlags.sourcePaused,
      timebaseReset: decodedFlags.timebaseReset,
    }),
  });
}

function decodedView(envelope, decodedFlags, continuity, profileResult) {
  return Object.freeze({
    magic: envelope.magic,
    protocol_major: envelope.protocolMajor,
    protocol_minor: envelope.protocolMinor,
    frame_type: envelope.frameType,
    flags: envelope.flags,
    stream_id: envelope.streamId,
    sample_count: envelope.sampleCount,
    first_sample_sequence: envelope.firstSequence,
    first_timestamp_us: envelope.firstTimestampUs,
    payload_length: envelope.payloadLength,
    discontinuity: decodedFlags.discontinuity,
    producer_overflow: decodedFlags.producerOverflow,
    output_queue_drop: decodedFlags.outputQueueDrop,
    stream_start: decodedFlags.streamStart,
    stream_end: decodedFlags.streamEnd,
    source_paused: decodedFlags.sourcePaused,
    timebase_reset: decodedFlags.timebaseReset,
    gap_samples: continuity.gapSamples,
    pcm_expected_timestamp_floor_us: continuity.pcmExpectedTimestampFloorUs,
    pcm_timestamp_within_1us: continuity.pcmExpectedTimestampFloorUs === undefined ? undefined : true,
    records: profileResult.records,
    samples: profileResult.samples,
    first_delta_us: profileResult.firstDeltaUs,
    last_delta_us: profileResult.lastDeltaUs,
    first_valid_mask: profileResult.firstValidMask,
    first_voltage: profileResult.firstVoltage,
    first_current: profileResult.firstCurrent,
    first_pcm_value: profileResult.firstPcmValue,
    last_pcm_value: profileResult.lastPcmValue,
  });
}

function decodeWithNegotiatedState(buffer, state) {
  requireActiveDecoderState(state, buffer.byteLength);
  const envelope = parseEnvelope(buffer, state.version);
  const decodedFlags = flags(envelope);
  let profileResult = Object.freeze({});
  if (envelope.frameType === FRAME_STREAM_END) {
    if (envelope.payloadLength !== 0) fail("invalid_stream_end");
  } else if (state.profile === "vi-measurement") {
    profileResult = decodeViMeasurement(buffer, envelope);
  } else if (state.profile === "pcm-audio") {
    profileResult = decodePcmAudio(buffer, envelope, state.parameters);
  } else {
    fail("invalid_state", "unsupported negotiated profile");
  }
  const continuity = validateContinuity(envelope, state, decodedFlags);
  const segment = newSegment(state, envelope, decodedFlags, continuity);
  const decoded = decodedView(envelope, decodedFlags, continuity, profileResult);
  const nextState = publishCandidate(state, envelope, profileResult, continuity, segment);
  return Object.freeze({ decoded, nextState, segment });
}

/** Public reusable API: negotiated state is mandatory and owns all dispatch. */
export function decodeBinaryFrame(buffer, state) {
  if (!(buffer instanceof ArrayBuffer)) fail("invalid_message", "binary input is not an ArrayBuffer");
  if (state === null || typeof state !== "object") fail("invalid_state", "negotiated decoder state is required");
  return decodeWithNegotiatedState(buffer, state);
}

/**
 * Test-only structural path for context-free malformed golden vectors. It does
 * not represent a usable stream decoder and is never used by the public API.
 */
export function decodeBinaryFrameStructural(buffer, profile) {
  if (!(buffer instanceof ArrayBuffer)) fail("invalid_message", "binary input is not an ArrayBuffer");
  if (profile !== "vi-measurement" && profile !== "pcm-audio") fail("unsupported_profile");
  const envelope = parseEnvelope(buffer, "0.1");
  const decodedFlags = flags(envelope);
  let profileResult = Object.freeze({});
  if (envelope.frameType === FRAME_STREAM_END) {
    if (envelope.payloadLength !== 0) fail("invalid_stream_end");
  } else if (profile === "vi-measurement") {
    profileResult = decodeViMeasurement(buffer, envelope);
  } else {
    profileResult = decodePcmAudio(buffer, envelope, STRUCTURAL_PCM_PARAMETERS);
  }
  const continuity = validateContinuity(envelope, null, decodedFlags);
  return Object.freeze({ decoded: decodedView(envelope, decodedFlags, continuity, profileResult), nextState: null, segment: null });
}
