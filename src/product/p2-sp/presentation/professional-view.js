import { presentError, qualityFor } from "./view-state.js";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function professionalMarkup(owner, deployment) {
  const s = owner.adapter.summary(); const m = owner.model; const q = qualityFor(owner); const error = presentError(s.lastError);
  return `<section class="professional" aria-label="専門診断"><h2>Professional diagnostics</h2><dl>
    <dt>WebSocket / D2B state</dt><dd>${s.controlState}</dd><dt>protocol</dt><dd>d2b-stream/0.1</dd><dt>profile</dt><dd>${s.profile ?? "none"}</dd>
    <dt>stream / stream ID</dt><dd>live-vi / ${s.streamId ?? "none"}</dd><dt>sequence / device timestamp</dt><dd>${m.latest?.sequence ?? "none"} / ${m.latest?.timestamp_us ?? "none"}</dd>
    <dt>valid mask</dt><dd>${m.latest?.valid_mask ?? "none"}</dd><dt>sample / segment count</dt><dd>${m.sampleCount} / ${m.segmentCount}</dd>
    <dt>gap/drop counters</dt><dd>${m.sequenceGapCount} / ${m.producerOverflowCount + m.outputQueueDropCount}</dd><dt>quality</dt><dd>${q.overall}</dd>
    <dt>bundle/deployment identity</dt><dd>${deployment.target} / ${deployment.bundleStatus}</dd><dt>bounded diagnostic count</dt><dd>${s.diagnosticCount}</dd>
    <dt>last error code/message</dt><dd>${escapeHtml(error.code || "none")} / ${escapeHtml(error.message || "none")}</dd>
  </dl><p>No secrets, raw payloads, MACs, or unbounded history are exposed.</p></section>`;
}
