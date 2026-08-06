// SPDX-License-Identifier: Apache-2.0

import { fail } from "./errors.js";
import { UINT32_MAX, SAFE_UINT_MAX } from "./protocol-constants.js";
import { isIntegerToken, objectProperty } from "./strict-json.js";

export const IDENTIFIER_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const VERSION_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function codePointLength(value) {
  return [...value].length;
}

export function checkString(value, field, minimum, maximum, code = "invalid_message") {
  if (typeof value !== "string" || codePointLength(value) < minimum || codePointLength(value) > maximum) {
    fail(code, `invalid ${field}`);
  }
}

export function checkInteger(value, field, maximum = UINT32_MAX, minimum = 0, node, code = "invalid_message") {
  if (
    (node !== undefined && !isIntegerToken(node)) ||
    !Number.isSafeInteger(value) || value < minimum || value > maximum
  ) {
    fail(code, `invalid ${field}`);
  }
}

export function checkBoolean(value, field, code = "invalid_message") {
  if (typeof value !== "boolean") fail(code, `invalid ${field}`);
}

export function requireExactFields(value, required, optional = [], code = "invalid_message") {
  if (!isObject(value)) fail(code, "expected object");
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    fail(code, "wrong object fields");
  }
}

export function child(node, key) {
  return objectProperty(node, key);
}

export function validateParameterShape(parameters, parameterNode, code = "invalid_message") {
  if (!isObject(parameters) || Object.keys(parameters).length > 32) {
    fail(code, "parameters is not a bounded object");
  }
  for (const key of Object.keys(parameters)) {
    if (!IDENTIFIER_RE.test(key)) fail(code, "invalid parameter name");
  }
  if (Object.hasOwn(parameters, "sample_format")) {
    checkString(parameters.sample_format, "sample_format", 1, 64, code);
  }
  if (Object.hasOwn(parameters, "channel_count")) {
    checkInteger(parameters.channel_count, "channel_count", 32, 1, child(parameterNode, "channel_count"), code);
  }
  if (Object.hasOwn(parameters, "channel_mask")) {
    checkInteger(parameters.channel_mask, "channel_mask", UINT32_MAX, 0, child(parameterNode, "channel_mask"), code);
  }
  if (Object.hasOwn(parameters, "sample_rate")) {
    const rate = parameters.sample_rate;
    const rateNode = child(parameterNode, "sample_rate");
    requireExactFields(rate, ["numerator", "denominator"], [], code);
    checkInteger(rate.numerator, "sample_rate.numerator", UINT32_MAX, 0, child(rateNode, "numerator"), code);
    checkInteger(rate.denominator, "sample_rate.denominator", UINT32_MAX, 0, child(rateNode, "denominator"), code);
  }
  if (Object.hasOwn(parameters, "samples_per_frame")) {
    checkInteger(parameters.samples_per_frame, "samples_per_frame", UINT32_MAX, 1, child(parameterNode, "samples_per_frame"), code);
  }
  return parameters;
}

export function validateParameters(parameters, profile, parameterNode, code = "unsupported_parameters") {
  validateParameterShape(parameters, parameterNode, "invalid_message");
  if (profile === "vi-measurement") {
    requireExactFields(parameters, ["sample_format", "channel_count", "channel_mask", "sample_rate"], [], code);
    const { numerator, denominator } = parameters.sample_rate;
    if (
      parameters.sample_format !== "vi-f32le" || parameters.channel_count !== 2 ||
      parameters.channel_mask !== 3 || ((numerator === 0) !== (denominator === 0))
    ) fail(code, "unsupported V/I parameter set");
    return parameters;
  }
  if (profile === "pcm-audio") {
    requireExactFields(parameters, ["sample_format", "channel_count", "channel_mask", "sample_rate", "samples_per_frame"], [], code);
    const { numerator, denominator } = parameters.sample_rate;
    if (
      popcount32(parameters.channel_mask) !== parameters.channel_count ||
      parameters.sample_format !== "pcm-s16le-interleaved" || parameters.channel_count !== 1 ||
      parameters.channel_mask !== 1 || numerator !== 16000 || denominator !== 1 ||
      parameters.samples_per_frame !== 256
    ) fail(code, "unsupported PCM parameter set");
    return parameters;
  }
  fail("unsupported_profile", "unknown profile");
}

export function popcount32(value) {
  let count = 0;
  let remaining = value >>> 0;
  while (remaining !== 0) {
    count += remaining & 1;
    remaining >>>= 1;
  }
  return count;
}

export function canonicalValue(value) {
  if (value === null) return "null";
  if (typeof value === "string") return `s:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return value ? "b:true" : "b:false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_capabilities", "non-finite capability value");
    return `n:${value === 0 ? "0" : String(value)}`;
  }
  if (Array.isArray(value)) return `a:[${value.map(canonicalValue).join(",")}]`;
  if (isObject(value)) {
    return `o:{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}=${canonicalValue(value[key])}`).join(",")}}`;
  }
  fail("invalid_capabilities", "non-JSON capability value");
}

export { SAFE_UINT_MAX };
