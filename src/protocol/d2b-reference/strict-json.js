// SPDX-License-Identifier: Apache-2.0

import { CONTROL_LIMIT } from "./protocol-constants.js";
import { fail } from "./errors.js";

const INTEGER_TOKEN = /^-?(?:0|[1-9][0-9]*)$/;
const NUMBER_TOKEN = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function node(kind, value, extra = {}) {
  return Object.freeze({ kind, value, ...extra });
}

class Scanner {
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  parse() {
    this.skipWhitespace();
    const result = this.value();
    this.skipWhitespace();
    if (this.index !== this.text.length) fail("invalid_message", "trailing JSON data");
    return result;
  }

  skipWhitespace() {
    while (this.index < this.text.length && " \t\r\n".includes(this.text[this.index])) {
      this.index += 1;
    }
  }

  value() {
    this.skipWhitespace();
    const current = this.text[this.index];
    if (current === "{") return this.object();
    if (current === "[") return this.array();
    if (current === '"') return this.string();
    if (current === "t") return this.literal("true", true);
    if (current === "f") return this.literal("false", false);
    if (current === "n") return this.literal("null", null);
    if (current === "-" || (current >= "0" && current <= "9")) return this.number();
    fail("invalid_message", "invalid JSON token");
  }

  literal(token, value) {
    if (this.text.slice(this.index, this.index + token.length) !== token) {
      fail("invalid_message", "invalid JSON literal");
    }
    this.index += token.length;
    return node(token === "null" ? "null" : "boolean", value);
  }

  string() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      const character = this.text[this.index];
      if (character === '"') {
        this.index += 1;
        const raw = this.text.slice(start, this.index);
        try {
          return node("string", JSON.parse(raw), { raw });
        } catch {
          fail("invalid_message", "invalid JSON string");
        }
      }
      if (code < 0x20) fail("invalid_message", "control character in JSON string");
      if (character === "\\") {
        this.index += 1;
        const escape = this.text[this.index];
        if ('"\\/bfnrt'.includes(escape)) {
          this.index += 1;
          continue;
        }
        if (escape === "u") {
          const digits = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) fail("invalid_message", "invalid unicode escape");
          this.index += 5;
          continue;
        }
        fail("invalid_message", "invalid JSON escape");
      }
      this.index += 1;
    }
    fail("invalid_message", "unterminated JSON string");
  }

  number() {
    NUMBER_TOKEN.lastIndex = this.index;
    const match = NUMBER_TOKEN.exec(this.text);
    if (!match) fail("invalid_message", "invalid JSON number");
    const raw = match[0];
    this.index += raw.length;
    const value = Number(raw);
    if (!Number.isFinite(value)) fail("invalid_message", "non-finite JSON number");
    return node("number", value, { raw, integerToken: INTEGER_TOKEN.test(raw) });
  }

  object() {
    this.index += 1;
    this.skipWhitespace();
    const value = Object.create(null);
    const properties = new Map();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return node("object", value, { properties });
    }
    while (true) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') fail("invalid_message", "object key must be a string");
      const key = this.string().value;
      if (properties.has(key)) fail("invalid_message", "duplicate JSON object key");
      this.skipWhitespace();
      if (this.text[this.index] !== ":") fail("invalid_message", "object member lacks colon");
      this.index += 1;
      const child = this.value();
      properties.set(key, child);
      value[key] = child.value;
      this.skipWhitespace();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return node("object", value, { properties });
      }
      if (this.text[this.index] !== ",") fail("invalid_message", "object member separator missing");
      this.index += 1;
    }
  }

  array() {
    this.index += 1;
    this.skipWhitespace();
    const value = [];
    const items = [];
    if (this.text[this.index] === "]") {
      this.index += 1;
      return node("array", value, { items });
    }
    while (true) {
      const child = this.value();
      items.push(child);
      value.push(child.value);
      this.skipWhitespace();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return node("array", value, { items });
      }
      if (this.text[this.index] !== ",") fail("invalid_message", "array element separator missing");
      this.index += 1;
    }
  }
}

function parseText(text) {
  if (typeof text !== "string") fail("invalid_message", "control input is not text");
  return new Scanner(text).parse();
}

/**
 * The authoritative strict-control entry point for raw message bytes. It checks
 * the byte limit before fatal UTF-8 decoding and preserves number-token nodes.
 */
export function parseControlBytes(input) {
  const bytes = input instanceof Uint8Array
    ? input
    : input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : null;
  if (bytes === null) fail("invalid_message", "control bytes are required");
  if (bytes.byteLength > CONTROL_LIMIT) fail("frame_too_large", "control message too large");
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    fail("invalid_message", "invalid UTF-8 control message");
  }
  return Object.freeze({ text, root: parseText(text), byteLength: bytes.byteLength, wireKind: "bytes" });
}

/**
 * This validates the UTF-8 encoding of a JavaScript string for sizing only.
 * It cannot reconstruct or validate the original WebSocket wire bytes.
 */
export function parseControlText(text) {
  if (typeof text !== "string") fail("invalid_message", "control text is required");
  const byteLength = encoder.encode(text).byteLength;
  if (byteLength > CONTROL_LIMIT) fail("frame_too_large", "control message too large");
  return Object.freeze({ text, root: parseText(text), byteLength, wireKind: "string" });
}

export function isIntegerToken(value) {
  return value?.kind === "number" && value.integerToken === true;
}

export function objectProperty(objectNode, key) {
  return objectNode?.kind === "object" ? objectNode.properties.get(key) : undefined;
}
