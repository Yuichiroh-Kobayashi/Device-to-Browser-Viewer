// SPDX-License-Identifier: Apache-2.0

import { fail } from "../errors.js";
import { ENVELOPE_SIZE, FRAME_FIXED_RATE } from "../protocol-constants.js";

export function decodePcmAudio(buffer, envelope, parameters) {
  if (envelope.frameType !== FRAME_FIXED_RATE) fail("pcm_frame_type_mismatch");
  if (envelope.sampleCount !== parameters.samples_per_frame) fail("pcm_sample_count_mismatch");
  const expectedPayload = envelope.sampleCount * parameters.channel_count * 2;
  if (expectedPayload !== envelope.payloadLength) fail("pcm_payload_length_mismatch");
  const view = new DataView(buffer);
  const samples = [];
  for (let index = 0; index < envelope.sampleCount; index += 1) {
    samples.push(view.getInt16(ENVELOPE_SIZE + index * 2, true));
  }
  return Object.freeze({ samples: Object.freeze(samples), firstPcmValue: samples[0], lastPcmValue: samples.at(-1) });
}
