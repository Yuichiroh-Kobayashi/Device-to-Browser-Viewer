// SPDX-License-Identifier: Apache-2.0

import { fail } from "./errors.js";
import {
  ENVELOPE_SIZE, FLAG_DISCONTINUITY, FLAG_OUTPUT_QUEUE_DROP, FLAG_PRODUCER_OVERFLOW,
  FLAG_RESERVED, FLAG_SOURCE_PAUSED, FLAG_STREAM_END, FLAG_STREAM_START,
  FLAG_TIMEBASE_RESET, FRAME_FIXED_RATE, FRAME_STREAM_END, FRAME_TIMESTAMPED,
  UINT64_MAX,
} from "./protocol-constants.js";

export function parseVersion(version) {
  if (typeof version !== "string" || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(version)) {
    fail("invalid_message", "invalid negotiated version");
  }
  return version.split(".").map(Number);
}

export function parseEnvelope(buffer, negotiatedVersion = "0.1") {
  if (!(buffer instanceof ArrayBuffer)) fail("invalid_message", "binary input is not an ArrayBuffer");
  if (buffer.byteLength < ENVELOPE_SIZE) fail("envelope_too_short");
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== "D2BS") fail("bad_magic");
  const [major, minor] = parseVersion(negotiatedVersion);
  const protocolMajor = view.getUint8(4);
  const protocolMinor = view.getUint8(5);
  if (protocolMajor !== major || protocolMinor !== minor) fail("version_mismatch");

  const frameType = view.getUint8(6);
  const flags = view.getUint8(7);
  const streamId = view.getUint32(8, true);
  const sampleCount = view.getUint32(12, true);
  const firstSequence = view.getBigUint64(16, true);
  const firstTimestampUs = view.getBigUint64(24, true);
  if (flags & FLAG_RESERVED) fail("reserved_flag_set");
  if ((flags & FLAG_STREAM_START) && (flags & FLAG_STREAM_END)) fail("stream_start_end_conflict");
  if (frameType === FRAME_STREAM_END) {
    if (!(flags & FLAG_STREAM_END)) fail("stream_end_flag_missing");
    if (flags !== FLAG_STREAM_END) fail("invalid_stream_end_flags");
  } else if (flags & FLAG_STREAM_END) {
    fail("data_stream_end_flag");
  }
  const causes = FLAG_PRODUCER_OVERFLOW | FLAG_OUTPUT_QUEUE_DROP | FLAG_SOURCE_PAUSED | FLAG_TIMEBASE_RESET;
  if ((flags & causes) && !(flags & FLAG_DISCONTINUITY)) fail("missing_discontinuity_flag");
  if ((flags & FLAG_TIMEBASE_RESET) && !(flags & FLAG_STREAM_START)) fail("timebase_reset_requires_new_session");
  if (![FRAME_FIXED_RATE, FRAME_TIMESTAMPED, FRAME_STREAM_END].includes(frameType)) fail("unknown_frame_type");
  if (streamId === 0) fail("invalid_stream_id");
  if (frameType === FRAME_STREAM_END) {
    if (sampleCount !== 0) fail("invalid_stream_end");
  } else {
    if (sampleCount === 0) fail("sample_count_zero");
    if (firstSequence + BigInt(sampleCount) - 1n > UINT64_MAX) fail("sequence_overflow");
  }
  return Object.freeze({
    magic, protocolMajor, protocolMinor, frameType, flags, streamId, sampleCount,
    firstSequence, firstTimestampUs, payloadLength: buffer.byteLength - ENVELOPE_SIZE,
  });
}
