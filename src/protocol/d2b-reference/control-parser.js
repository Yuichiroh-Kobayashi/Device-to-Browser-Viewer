// SPDX-License-Identifier: Apache-2.0

import { fail } from "./errors.js";
import { CONTROL_LIMIT, ENVELOPE_SIZE, SAFE_UINT_MAX, STANDARD_PROFILES, UINT32_MAX } from "./protocol-constants.js";
import { child, checkBoolean, checkInteger, checkString, IDENTIFIER_RE, isObject, requireExactFields, validateParameterShape, validateParameters, VERSION_RE } from "./value-validators.js";
import { parseControlBytes, parseControlText } from "./strict-json.js";

const ERROR_CODES = new Set([
  "busy", "unauthorized", "unknown_stream", "unsupported_version", "unsupported_profile",
  "unsupported_parameters", "invalid_message", "invalid_state", "frame_too_large", "internal_error",
]);

const CLIENT_FIELDS = {
  hello: [["type", "protocol", "versions"], ["client_name", "authentication"]],
  start_stream: [["type", "stream", "profile", "parameters"], ["options"]],
  stop_stream: [["type"], ["stream_id", "reason"]],
  ping: [["type", "correlation"], []],
};
const SERVER_FIELDS = {
  welcome: [["type", "protocol", "version", "max_control_message_size", "max_binary_frame_size", "session_state"], ["server_name"]],
  stream_started: [["type", "stream", "profile", "parameters", "stream_id"], []],
  stream_stopped: [["type", "stream_id", "reason"], []],
  status: [["type", "state", "connected_client_count", "producer_drop_count", "output_queue_drop_count", "queued_sample_count", "source_paused", "uptime_us"], ["active_stream_id", "last_error"]],
  error: [["type", "code", "message"], ["correlation", "recoverable"]],
  pong: [["type", "correlation"], []],
};

function validateAuthentication(value, valueNode) {
  requireExactFields(value, ["scheme", "token"]);
  if (value.scheme !== "pairing-token") fail("invalid_message", "invalid authentication scheme");
  checkString(value.token, "token", 1, 256);
  if (new TextEncoder().encode(value.token).byteLength > 256) fail("invalid_message", "token exceeds 256 UTF-8 bytes");
  if (valueNode?.kind !== "object") fail("invalid_message", "invalid authentication");
}

function validateContext(message, direction, context) {
  if (context === undefined || context === null) return;
  if (!isObject(context) || !Object.hasOwn(context, "state")) return;
  if (direction !== "client_to_server" || Object.keys(context).length !== 2 || typeof context.owns_stream !== "boolean") {
    fail("invalid_message", "invalid control context");
  }
  const allowed = {
    CONNECTED: new Set(["hello"]),
    READY: new Set(["start_stream", "ping"]),
    STREAMING: new Set(["stop_stream", "ping"]),
    CLOSED: new Set(),
  };
  if (!Object.hasOwn(allowed, context.state) || !allowed[context.state].has(message.type)) {
    fail("invalid_state", `${message.type} is invalid in ${context.state}`);
  }
  if (context.state === "STREAMING" && message.type === "stop_stream" && !context.owns_stream) {
    fail("invalid_state", "non-owner cannot stop stream");
  }
}

function validateAst(document, direction, context) {
  const { root } = document;
  if (root.kind !== "object") fail("invalid_message", "message is not an object");
  const message = root.value;
  const fields = direction === "client_to_server" ? CLIENT_FIELDS : direction === "server_to_client" ? SERVER_FIELDS : null;
  if (fields === null) fail("invalid_message", "invalid message direction");
  const typeNode = child(root, "type");
  if (typeNode?.kind !== "string" || !Object.hasOwn(fields, message.type)) fail("invalid_message", "unknown message type");
  const [required, optional] = fields[message.type];
  requireExactFields(message, required, optional);

  if (message.type === "hello") {
    if (message.protocol !== "d2b-stream") fail("invalid_message", "invalid protocol");
    const versionsNode = child(root, "versions");
    if (versionsNode?.kind !== "array" || message.versions.length < 1 || message.versions.length > 16 || new Set(message.versions).size !== message.versions.length || versionsNode.items.some((item) => item.kind !== "string" || !VERSION_RE.test(item.value))) fail("invalid_message", "invalid versions");
    if (Object.hasOwn(message, "client_name")) checkString(message.client_name, "client_name", 1, 128);
    if (Object.hasOwn(message, "authentication")) validateAuthentication(message.authentication, child(root, "authentication"));
  } else if (message.type === "welcome") {
    checkInteger(message.max_control_message_size, "max_control_message_size", CONTROL_LIMIT, CONTROL_LIMIT, child(root, "max_control_message_size"));
    if (message.protocol !== "d2b-stream" || message.version !== "0.1" || message.session_state !== "ready") fail("invalid_message", "invalid welcome");
    checkInteger(message.max_binary_frame_size, "max_binary_frame_size", UINT32_MAX, ENVELOPE_SIZE, child(root, "max_binary_frame_size"));
    if (Object.hasOwn(message, "server_name")) checkString(message.server_name, "server_name", 1, 128);
  } else if (message.type === "start_stream" || message.type === "stream_started") {
    if (typeof message.stream !== "string" || !IDENTIFIER_RE.test(message.stream)) fail("invalid_message", "invalid stream");
    if (typeof message.profile !== "string" || !IDENTIFIER_RE.test(message.profile)) fail("invalid_message", "invalid profile identifier");
    validateParameterShape(message.parameters, child(root, "parameters"));
    if (!STANDARD_PROFILES.has(message.profile)) fail("unsupported_profile", "unsupported profile");
    validateParameters(message.parameters, message.profile, child(root, "parameters"));
    if (Object.hasOwn(message, "options") && (!isObject(message.options) || Object.keys(message.options).length > 32)) fail("invalid_message", "invalid options");
    if (message.type === "stream_started") checkInteger(message.stream_id, "stream_id", UINT32_MAX, 1, child(root, "stream_id"));
  } else if (message.type === "stop_stream" || message.type === "stream_stopped") {
    if (Object.hasOwn(message, "stream_id")) checkInteger(message.stream_id, "stream_id", UINT32_MAX, 1, child(root, "stream_id"));
    if (Object.hasOwn(message, "reason")) checkString(message.reason, "reason", 1, 256);
  } else if (message.type === "status") {
    if (message.state !== "idle" && message.state !== "streaming") fail("invalid_message", "invalid status state");
    const hasId = Object.hasOwn(message, "active_stream_id");
    if (hasId !== (message.state === "streaming")) fail("invalid_message", "active_stream_id/state mismatch");
    if (hasId) checkInteger(message.active_stream_id, "active_stream_id", UINT32_MAX, 1, child(root, "active_stream_id"));
    checkInteger(message.connected_client_count, "connected_client_count", UINT32_MAX, 0, child(root, "connected_client_count"));
    checkInteger(message.producer_drop_count, "producer_drop_count", SAFE_UINT_MAX, 0, child(root, "producer_drop_count"));
    checkInteger(message.output_queue_drop_count, "output_queue_drop_count", SAFE_UINT_MAX, 0, child(root, "output_queue_drop_count"));
    checkInteger(message.queued_sample_count, "queued_sample_count", UINT32_MAX, 0, child(root, "queued_sample_count"));
    checkInteger(message.uptime_us, "uptime_us", SAFE_UINT_MAX, 0, child(root, "uptime_us"));
    checkBoolean(message.source_paused, "source_paused");
    if (Object.hasOwn(message, "last_error") && message.last_error !== null) {
      requireExactFields(message.last_error, ["code", "message"]);
      if (!ERROR_CODES.has(message.last_error.code)) fail("invalid_message", "invalid last_error code");
      checkString(message.last_error.message, "last_error.message", 1, 512);
    }
  } else if (message.type === "error") {
    if (!ERROR_CODES.has(message.code)) fail("invalid_message", "invalid error code");
    checkString(message.message, "message", 1, 512);
    if (Object.hasOwn(message, "correlation")) checkString(message.correlation, "correlation", 1, 128);
    if (Object.hasOwn(message, "recoverable")) checkBoolean(message.recoverable, "recoverable");
  } else if (message.type === "ping" || message.type === "pong") {
    checkString(message.correlation, "correlation", 1, 128);
  }
  validateContext(message, direction, context);
  return message;
}

export function parseControlMessageBytes(bytes, direction, context) {
  return validateAst(parseControlBytes(bytes), direction, context);
}

export function parseControlMessageText(text, direction, context) {
  return validateAst(parseControlText(text), direction, context);
}
