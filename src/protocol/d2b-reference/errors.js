// SPDX-License-Identifier: Apache-2.0

/** A stable, protocol-visible validation failure. */
export class ProtocolError extends Error {
  constructor(code, detail = "") {
    super(detail || code);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export function fail(code, detail = "") {
  throw new ProtocolError(code, detail);
}
