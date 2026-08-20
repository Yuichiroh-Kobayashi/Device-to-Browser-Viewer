import { presentError, qualityFor } from "./view-state.js";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function professionalMarkup(owner, deployment) {
  const s = owner.adapter.summary(); const m = owner.model; const q = qualityFor(owner); const error = presentError(s.lastError);
  return `<section class="professional" aria-label="専門診断"><h2>Professional diagnostics</h2><dl>
    <dt>WebSocket / D2B state</dt><dd data-live="control-state">${s.controlState}</dd><dt>protocol</dt><dd>d2b-stream/0.1</dd><dt>profile</dt><dd data-live="profile">${s.profile ?? "none"}</dd>
    <dt>stream / stream ID</dt><dd data-live="stream">live-vi / ${s.streamId ?? "none"}</dd><dt>sequence / device timestamp</dt><dd data-live="sequence-time">${m.latest?.sequence ?? "none"} / ${m.latest?.timestamp_us ?? "none"}</dd>
    <dt>valid mask</dt><dd data-live="valid-mask">${m.latest?.valid_mask ?? "none"}</dd><dt>sample / segment count</dt><dd data-live="sample-segment">${m.sampleCount} / ${m.segmentCount}</dd>
    <dt>gap/drop counters</dt><dd data-live="gap-drop">${m.sequenceGapCount} / ${m.producerOverflowCount + m.outputQueueDropCount}</dd><dt>quality</dt><dd data-live="quality">${q.overall}</dd>
    <dt>bundle/deployment identity</dt><dd data-live="deployment">${deployment.target} / ${deployment.bundleStatus}</dd><dt>bounded diagnostic count</dt><dd data-live="diagnostic-count">${s.diagnosticCount}</dd>
    <dt>last error code/message</dt><dd data-live="last-error">${escapeHtml(error.code || "none")} / ${escapeHtml(error.message || "none")}</dd>
    <dt>action rejection</dt><dd data-live="action-error">0 / none</dd>
  </dl><p>No secrets, raw payloads, MACs, or unbounded history are exposed.</p></section>`;
}

function required(root, selector) {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`professional presentation node missing: ${selector}`);
  return node;
}

export function updateProfessionalPresentation(root, owner, deployment, actionDiagnostic) {
  const state = owner.adapter.summary();
  const model = owner.model;
  const quality = qualityFor(owner);
  const error = presentError(state.lastError);
  required(root, '[data-live="control-state"]').textContent = state.controlState;
  required(root, '[data-live="profile"]').textContent = state.profile ?? "none";
  required(root, '[data-live="stream"]').textContent = `live-vi / ${state.streamId ?? "none"}`;
  required(root, '[data-live="sequence-time"]').textContent = `${model.latest?.sequence ?? "none"} / ${model.latest?.timestamp_us ?? "none"}`;
  required(root, '[data-live="valid-mask"]').textContent = model.latest?.valid_mask ?? "none";
  required(root, '[data-live="sample-segment"]').textContent = `${model.sampleCount} / ${model.segmentCount}`;
  required(root, '[data-live="gap-drop"]').textContent = `${model.sequenceGapCount} / ${model.producerOverflowCount + model.outputQueueDropCount}`;
  required(root, '[data-live="quality"]').textContent = quality.overall;
  required(root, '[data-live="deployment"]').textContent = `${deployment.target} / ${deployment.bundleStatus}`;
  required(root, '[data-live="diagnostic-count"]').textContent = state.diagnosticCount;
  required(root, '[data-live="last-error"]').textContent = `${error.code || "none"} / ${error.message || "none"}`;
  required(root, '[data-live="action-error"]').textContent = `${actionDiagnostic.count} / ${actionDiagnostic.lastAction}`;
}
