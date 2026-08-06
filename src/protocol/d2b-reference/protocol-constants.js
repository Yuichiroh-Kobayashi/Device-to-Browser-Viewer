// SPDX-License-Identifier: Apache-2.0

export const CONTROL_LIMIT = 2048;
export const ENVELOPE_SIZE = 32;
export const UINT32_MAX = 0xffffffff;
export const UINT64_MAX = (1n << 64n) - 1n;
export const SAFE_UINT_MAX = 9007199254740991;

export const FRAME_FIXED_RATE = 0x01;
export const FRAME_TIMESTAMPED = 0x02;
export const FRAME_STREAM_END = 0x10;

export const FLAG_STREAM_START = 0x01;
export const FLAG_STREAM_END = 0x02;
export const FLAG_DISCONTINUITY = 0x04;
export const FLAG_PRODUCER_OVERFLOW = 0x08;
export const FLAG_OUTPUT_QUEUE_DROP = 0x10;
export const FLAG_SOURCE_PAUSED = 0x20;
export const FLAG_TIMEBASE_RESET = 0x40;
export const FLAG_RESERVED = 0x80;

export const VI_PARAMETERS = Object.freeze({
  sample_format: "vi-f32le",
  channel_count: 2,
  channel_mask: 3,
  sample_rate: Object.freeze({ numerator: 0, denominator: 0 }),
});

export const PCM_PARAMETERS = Object.freeze({
  sample_format: "pcm-s16le-interleaved",
  channel_count: 1,
  channel_mask: 1,
  sample_rate: Object.freeze({ numerator: 16000, denominator: 1 }),
  samples_per_frame: 256,
});

export const STANDARD_PROFILES = new Set(["vi-measurement", "pcm-audio"]);
