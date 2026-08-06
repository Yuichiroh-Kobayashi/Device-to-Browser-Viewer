// SPDX-License-Identifier: Apache-2.0

import { fail } from "./errors.js";
import { FRAME_STREAM_END, UINT32_MAX, UINT64_MAX } from "./protocol-constants.js";
import { validateParameters } from "./value-validators.js";

function cloneParameters(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function freezeDeep(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function asUint64(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) invalidState(`invalid ${field}`);
  return BigInt(value);
}

function invalidState(detail) {
  fail("invalid_state", detail);
}

function isUint64(value) {
  return typeof value === "bigint" && value >= 0n && value <= UINT64_MAX;
}

function validatePreviousState(previous, profile) {
  if (previous === null || typeof previous !== "object" ||
      !isUint64(previous.firstSequence) ||
      typeof previous.sampleCount !== "bigint" || previous.sampleCount < 1n || previous.sampleCount > BigInt(UINT32_MAX) ||
      !isUint64(previous.firstTimestampUs)) {
    invalidState("invalid previous frame state");
  }
  if (previous.firstSequence + previous.sampleCount - 1n > UINT64_MAX) {
    invalidState("previous frame sequence overflow");
  }
  if (profile === "vi-measurement" && !isUint64(previous.lastTimestampUs)) {
    invalidState("invalid previous V/I timestamp state");
  }
}

function validateAnchorState(anchor) {
  if (anchor === null || typeof anchor !== "object" || !isUint64(anchor.sequence) || !isUint64(anchor.timestampUs)) {
    invalidState("invalid PCM anchor state");
  }
}

function pcmTimestampMatchesAnchor(previous, anchor, parameters) {
  const rate = parameters.sample_rate;
  const numerator = BigInt(rate.numerator);
  const expectedNumerator = anchor.timestampUs * numerator +
    (previous.firstSequence - anchor.sequence) * BigInt(rate.denominator) * 1000000n;
  const actualNumerator = previous.firstTimestampUs * numerator;
  const difference = actualNumerator >= expectedNumerator ? actualNumerator - expectedNumerator : expectedNumerator - actualNumerator;
  if (difference > numerator) invalidState("previous PCM timestamp is inconsistent with anchor");
}

/** Build an isolated decoder state from a golden-vector context or app session. */
export function createDecoderState(context = undefined) {
  if (context === undefined || context === null) return null;
  const { negotiated_version: version, session_state: sessionState, maximum_binary_frame_size: maximumBinaryFrameSize, stream_id: streamId, profile, parameters } = context;
  if (typeof version !== "string" || !["READY", "STREAMING", "CLOSED"].includes(sessionState) || !Number.isSafeInteger(maximumBinaryFrameSize) || maximumBinaryFrameSize < 32 || !Number.isSafeInteger(streamId) || streamId < 1 || streamId > 0xffffffff || (profile !== "vi-measurement" && profile !== "pcm-audio")) {
    invalidState("invalid decoder context");
  }
  try {
    validateParameters(parameters, profile);
  } catch (error) {
    invalidState(`invalid decoder parameters: ${error?.message || "unknown"}`);
  }
  const previousFields = ["previous_first_sample_sequence", "previous_sample_count", "previous_first_timestamp_us", "previous_last_timestamp_us"];
  const previousPresent = previousFields.some((key) => Object.hasOwn(context, key));
  const basePreviousFields = previousFields.slice(0, 3);
  if (previousPresent && !basePreviousFields.every((key) => Object.hasOwn(context, key))) invalidState("incomplete previous frame context");
  if (profile === "vi-measurement" && previousPresent && !Object.hasOwn(context, "previous_last_timestamp_us")) invalidState("V/I last timestamp required");
  if (profile === "pcm-audio" && Object.hasOwn(context, "previous_last_timestamp_us")) invalidState("PCM previous frame has an invalid last timestamp");
  const anchorPresent = ["session_anchor_sequence", "session_anchor_timestamp_us"].some((key) => Object.hasOwn(context, key));
  if (anchorPresent && !["session_anchor_sequence", "session_anchor_timestamp_us"].every((key) => Object.hasOwn(context, key))) invalidState("incomplete PCM anchor context");
  if (profile === "pcm-audio" && previousPresent && !anchorPresent) invalidState("continued PCM context requires an anchor");
  if (profile === "pcm-audio" && !previousPresent && anchorPresent) invalidState("fresh PCM context must not preload an anchor");
  if (profile === "vi-measurement" && anchorPresent) invalidState("V/I anchor is invalid");
  const previous = previousPresent ? {
    firstSequence: asUint64(context.previous_first_sample_sequence, "previous_first_sample_sequence"),
    sampleCount: asUint64(context.previous_sample_count, "previous_sample_count"),
    firstTimestampUs: asUint64(context.previous_first_timestamp_us, "previous_first_timestamp_us"),
    lastTimestampUs: profile === "vi-measurement" ? asUint64(context.previous_last_timestamp_us, "previous_last_timestamp_us") : undefined,
  } : null;
  const anchor = anchorPresent ? {
    sequence: asUint64(context.session_anchor_sequence, "session_anchor_sequence"),
    timestampUs: asUint64(context.session_anchor_timestamp_us, "session_anchor_timestamp_us"),
  } : null;
  const state = {
    version, sessionState, maximumBinaryFrameSize, streamId, profile, parameters: cloneParameters(parameters),
    acceptedData: previous !== null, previous, anchor, ended: false, nextSegmentId: previous ? 1 : 0,
  };
  requireActiveDecoderState(state, 0);
  return freezeState(state);
}

export function cloneDecoderState(state) {
  if (state === null) return null;
  return {
    ...state,
    parameters: cloneParameters(state.parameters),
    previous: state.previous ? { ...state.previous } : null,
    anchor: state.anchor ? { ...state.anchor } : null,
  };
}

export function requireActiveDecoderState(state, byteLength) {
  if (state === null || typeof state !== "object") invalidState("negotiated decoder state is required");
  if (state.version !== "0.1") invalidState("unsupported negotiated version state");
  if (state.sessionState !== "STREAMING") invalidState("binary data outside streaming state");
  if (!Number.isSafeInteger(state.maximumBinaryFrameSize) || state.maximumBinaryFrameSize < 32 || state.maximumBinaryFrameSize > UINT32_MAX) invalidState("invalid maximum binary frame size state");
  if (!Number.isSafeInteger(state.streamId) || state.streamId < 1 || state.streamId > UINT32_MAX) invalidState("invalid stream ID state");
  if (state.profile !== "vi-measurement" && state.profile !== "pcm-audio") invalidState("unsupported negotiated profile state");
  try {
    validateParameters(state.parameters, state.profile);
  } catch (error) {
    invalidState(`invalid negotiated parameters: ${error?.message || "unknown"}`);
  }
  if (typeof state.acceptedData !== "boolean" || typeof state.ended !== "boolean") invalidState("invalid decoder lifecycle state");
  if (!Number.isSafeInteger(state.nextSegmentId) || state.nextSegmentId < 0) invalidState("invalid segment identifier state");
  if (state.acceptedData) {
    validatePreviousState(state.previous, state.profile);
    if (state.nextSegmentId < 1) invalidState("continued decoder state has no segment identifier");
  } else {
    if (state.previous !== null) invalidState("fresh decoder state carries previous frame state");
    if (state.nextSegmentId !== 0) invalidState("fresh decoder state has a segment identifier");
  }
  if (state.profile === "pcm-audio") {
    if (state.acceptedData) {
      validateAnchorState(state.anchor);
      if (state.previous.sampleCount !== BigInt(state.parameters.samples_per_frame)) invalidState("previous PCM sample count is inconsistent with parameters");
      if (state.previous.firstSequence < state.anchor.sequence) invalidState("previous PCM sequence precedes anchor");
      pcmTimestampMatchesAnchor(state.previous, state.anchor, state.parameters);
    } else if (state.anchor !== null) {
      invalidState("fresh PCM decoder state carries an anchor");
    }
  } else if (state.anchor !== null) {
    invalidState("V/I decoder state carries a PCM anchor");
  } else if (state.acceptedData) {
    if (state.previous.lastTimestampUs < state.previous.firstTimestampUs) invalidState("previous V/I timestamp order is invalid");
    if (state.previous.sampleCount === 1n && state.previous.lastTimestampUs !== state.previous.firstTimestampUs) invalidState("single-record V/I timestamps differ");
  }
  if (state.ended) invalidState("binary data after stream end");
  if (byteLength > state.maximumBinaryFrameSize) fail("frame_too_large");
}

export function publishCandidate(state, envelope, profileResult, continuity, segment) {
  if (state === null) return null;
  const next = cloneDecoderState(state);
  if (envelope.frameType === FRAME_STREAM_END) {
    next.ended = true;
    return freezeState(next);
  }
  next.acceptedData = true;
  next.previous = {
    firstSequence: envelope.firstSequence,
    sampleCount: BigInt(envelope.sampleCount),
    firstTimestampUs: envelope.firstTimestampUs,
    lastTimestampUs: state.profile === "vi-measurement" ? profileResult.lastTimestampUs : undefined,
  };
  next.anchor = continuity.anchor;
  if (segment !== null) next.nextSegmentId += 1;
  return freezeState(next);
}

function freezeState(state) {
  return freezeDeep({
    ...state,
    parameters: freezeDeep(state.parameters),
    previous: state.previous ? freezeDeep({ ...state.previous }) : null,
    anchor: state.anchor ? freezeDeep({ ...state.anchor }) : null,
  });
}
