// SPDX-License-Identifier: Apache-2.0

import { fail } from "../errors.js";
import { ENVELOPE_SIZE, FRAME_TIMESTAMPED, UINT64_MAX } from "../protocol-constants.js";

export function decodeViMeasurement(buffer, envelope) {
  if (envelope.frameType !== FRAME_TIMESTAMPED) fail("vi_frame_type_mismatch");
  if (envelope.sampleCount * 16 !== envelope.payloadLength) fail("vi_payload_length_mismatch");
  const view = new DataView(buffer);
  const records = [];
  let previousDelta = -1;
  let lastTimestampUs = envelope.firstTimestampUs;
  for (let index = 0; index < envelope.sampleCount; index += 1) {
    const offset = ENVELOPE_SIZE + index * 16;
    const deltaUs = view.getUint32(offset, true);
    const validMask = view.getUint32(offset + 4, true);
    const voltage = view.getFloat32(offset + 8, true);
    const current = view.getFloat32(offset + 12, true);
    if (index === 0 && deltaUs !== 0) fail("vi_first_delta_nonzero");
    if (deltaUs < previousDelta) fail("vi_delta_regression");
    if (validMask & ~3) fail("vi_invalid_valid_mask");
    if ((validMask & 1) && !Number.isFinite(voltage)) fail("vi_nonfinite_valid_value");
    if ((validMask & 2) && !Number.isFinite(current)) fail("vi_nonfinite_valid_value");
    const timestampUs = envelope.firstTimestampUs + BigInt(deltaUs);
    if (timestampUs > UINT64_MAX) fail("timestamp_overflow");
    const measurements = Object.create(null);
    if (validMask & 1) measurements.voltage = voltage;
    if (validMask & 2) measurements.current = current;
    records.push(Object.freeze({
      sequence: envelope.firstSequence + BigInt(index), timestampUs, deltaUs, validMask,
      measurements: Object.freeze(measurements),
    }));
    previousDelta = deltaUs;
    lastTimestampUs = timestampUs;
  }
  return Object.freeze({
    records: Object.freeze(records),
    lastTimestampUs,
    firstDeltaUs: records[0].deltaUs,
    lastDeltaUs: records.at(-1).deltaUs,
    firstValidMask: records[0].validMask,
    firstVoltage: records[0].measurements.voltage,
    firstCurrent: records[0].measurements.current,
  });
}
