// SPDX-License-Identifier: Apache-2.0

import { fail } from "./errors.js";
import { ENVELOPE_SIZE, STANDARD_PROFILES, UINT32_MAX } from "./protocol-constants.js";
import { canonicalValue, checkBoolean, checkInteger, checkString, IDENTIFIER_RE, isObject, requireExactFields, validateParameterShape, validateParameters } from "./value-validators.js";

function capability(condition, detail) {
  if (!condition) fail("invalid_capabilities", detail);
}

export function validateCapabilities(value) {
  try {
    requireExactFields(value, ["protocol", "version", "maximum_binary_frame_size", "maximum_control_message_size", "maximum_active_stream_sessions", "maximum_control_connections", "persistent_capture_supported", "security_mode", "streams"], [], "invalid_capabilities");
    capability(value.protocol === "d2b-stream" && value.version === "0.1", "wrong protocol or version");
    checkInteger(value.maximum_binary_frame_size, "maximum_binary_frame_size", UINT32_MAX, ENVELOPE_SIZE, undefined, "invalid_capabilities");
    checkInteger(value.maximum_control_connections, "maximum_control_connections", UINT32_MAX, 1, undefined, "invalid_capabilities");
    capability(value.maximum_control_message_size === 2048 && value.maximum_active_stream_sessions === 1, "invalid fixed capability");
    checkBoolean(value.persistent_capture_supported, "persistent_capture_supported", "invalid_capabilities");
    capability(["isolated", "unauthenticated-read-only", "pairing-token"].includes(value.security_mode), "invalid security mode");
    capability(Array.isArray(value.streams) && value.streams.length >= 1 && value.streams.length <= 64, "invalid streams");

    const streamIds = new Set();
    let hasStandardProfile = false;
    for (const stream of value.streams) {
      requireExactFields(stream, ["id", "label", "profiles"], [], "invalid_capabilities");
      capability(typeof stream.id === "string" && IDENTIFIER_RE.test(stream.id) && !streamIds.has(stream.id), "invalid or duplicate stream id");
      streamIds.add(stream.id);
      checkString(stream.label, "stream label", 1, 128, "invalid_capabilities");
      capability(Array.isArray(stream.profiles) && stream.profiles.length >= 1 && stream.profiles.length <= 32, "invalid profiles");
      const profileIds = new Set();
      for (const descriptor of stream.profiles) {
        requireExactFields(descriptor, ["profile", "parameter_sets"], [], "invalid_capabilities");
        capability(typeof descriptor.profile === "string" && IDENTIFIER_RE.test(descriptor.profile) && !profileIds.has(descriptor.profile), "invalid or duplicate profile");
        profileIds.add(descriptor.profile);
        if (STANDARD_PROFILES.has(descriptor.profile)) hasStandardProfile = true;
        capability(Array.isArray(descriptor.parameter_sets) && descriptor.parameter_sets.length >= 1 && descriptor.parameter_sets.length <= 32, "invalid parameter_sets");
        const parameterSets = new Set();
        for (const parameters of descriptor.parameter_sets) {
          validateParameterShape(parameters, undefined, "invalid_capabilities");
          const canonical = canonicalValue(parameters);
          capability(!parameterSets.has(canonical), "duplicate complete parameter set");
          parameterSets.add(canonical);
          if (STANDARD_PROFILES.has(descriptor.profile)) {
            validateParameters(parameters, descriptor.profile, undefined, "invalid_capabilities");
            const requiredSize = descriptor.profile === "vi-measurement" ? 48 : ENVELOPE_SIZE + parameters.samples_per_frame * parameters.channel_count * 2;
            capability(value.maximum_binary_frame_size >= requiredSize, "maximum_binary_frame_size cannot carry advertised frame");
          }
        }
      }
    }
    capability(hasStandardProfile, "capabilities advertises no standard profile");
    return value;
  } catch (error) {
    if (error?.code === "invalid_capabilities") throw error;
    fail("invalid_capabilities", error?.message || "invalid capabilities");
  }
}
