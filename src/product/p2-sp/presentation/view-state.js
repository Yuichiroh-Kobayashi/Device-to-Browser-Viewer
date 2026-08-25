export function qualityFor(owner) {
  const record = owner.model.latest;
  if (!record) return Object.freeze({ overall: "no-valid-data", voltage: "no-valid-data", current: "no-valid-data", gap: false });
  const gap = Boolean(record.flags?.gap_samples > 0n || record.flags?.discontinuity);
  const stale = owner.adapter.summary().controlState !== "STREAMING";
  return Object.freeze({
    overall: stale ? "stale" : gap ? "gap" : "normal",
    voltage: record.voltage_V === null ? "invalid" : stale ? "stale" : "normal",
    current: record.current_A === null ? "invalid" : stale ? "stale" : "normal",
    gap,
  });
}

export function displayValue(value, unit, state) {
  const suffix = state ? ` (${state})` : "";
  return value === null || value === undefined ? `—${suffix}` : `${value.toFixed(3)} ${unit}${suffix}`;
}

const FATAL_CODES = new Set(["bad_magic", "control_rejected", "binary_rejected", "invalid_message", "invalid_welcome", "unsupported_protocol"]);
const RECOVERABLE_CODES = new Set(["open_failed", "transport_error", "hello_timeout", "start_timeout", "stop_timeout", "server_busy", "server_rejected", "source_abort"]);
export function presentError(error) {
  if (!error) return Object.freeze({ classification: "none", code: "", message: "" });
  const code = String(error.code || "unknown").slice(0, 96); const message = String(error.message || "").slice(0, 512);
  return Object.freeze({ classification: FATAL_CODES.has(code) ? "fatal-semantic" : RECOVERABLE_CODES.has(code) ? "recoverable" : "recoverable", code, message });
}
