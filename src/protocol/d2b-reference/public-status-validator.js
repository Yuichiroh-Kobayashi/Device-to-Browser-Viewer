// SPDX-License-Identifier: Apache-2.0

import { fail } from "./errors.js";
import { SAFE_UINT_MAX } from "./protocol-constants.js";
import { checkInteger, requireExactFields } from "./value-validators.js";

const REQUIRED_FIELDS = Object.freeze(["protocol", "version", "state", "uptime_us"]);
const OPTIONAL_METRICS = Object.freeze([
  "producer_drop_count",
  "output_queue_drop_count",
  "queued_sample_count",
  "connected_client_count",
]);

// invalid_public_status is local to this reference validator. It is not a new
// WebSocket wire error.code value.
export function validatePublicStatus(value) {
  requireExactFields(value, REQUIRED_FIELDS, OPTIONAL_METRICS, "invalid_public_status");
  if (value.protocol !== "d2b-stream" || value.version !== "0.1" || !["idle", "streaming"].includes(value.state)) {
    fail("invalid_public_status", "wrong public status identity or state");
  }
  for (const field of ["uptime_us", ...OPTIONAL_METRICS]) {
    if (Object.hasOwn(value, field)) {
      checkInteger(value[field], field, SAFE_UINT_MAX, 0, undefined, "invalid_public_status");
    }
  }
  return value;
}
