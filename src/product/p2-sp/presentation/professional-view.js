import { presentError, qualityFor } from "./view-state.js";
import { measurementWorkspaceMarkup, updateMeasurementWorkspace } from "./measurement-workspace.js";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

const PROFESSIONAL_GRAPH_VISIBILITY = Object.freeze({ voltage: true, current: true });

/**
 * Professional shows the same common measurement workspace as Student --
 * header, Start/Stop, value panels, both graphs -- through the shared
 * measurement-workspace module, so a learner in Professional mode sees the
 * measurement first. Professional's own diagnostics render below it, in a
 * separate section, using selectors namespaced with a "diagnostic-" prefix
 * so they never collide with the shared workspace's own [data-live] nodes
 * (which use the plain "stream" / "quality" / "deployment" / "action-error"
 * names for the same physical concepts, but summarised differently).
 */
export function professionalMarkup(owner, deployment, themeLabel = "", controlsMarkup = "") {
  const s = owner.adapter.summary(); const m = owner.model; const summary = m.summary(); const q = qualityFor(owner); const error = presentError(s.lastError);
  return `<section class="professional" aria-label="専門測定">${measurementWorkspaceMarkup(themeLabel)}${controlsMarkup}
  <section class="professional-diagnostics" aria-label="専門診断"><h2>Professional diagnostics</h2><dl>
    <dt>source / transport / D2B state</dt><dd data-live="control-state">${owner.source?.state ?? "not-created"} / ${s.controlState}</dd><dt>protocol</dt><dd>d2b-stream/0.1</dd><dt>profile</dt><dd data-live="profile">${s.profile ?? "none"}</dd>
    <dt>stream / stream ID</dt><dd data-live="diagnostic-stream">live-vi / ${s.streamId ?? "none"}</dd><dt>sequence / device timestamp</dt><dd data-live="sequence-time">${m.latest?.sequence ?? "none"} / ${m.latest?.timestamp_us ?? "none"}</dd>
    <dt>valid mask</dt><dd data-live="valid-mask">${m.latest?.valid_mask ?? "none"}</dd><dt>sample / segment count</dt><dd data-live="sample-segment">${m.sampleCount} / ${m.segmentCount}</dd>
    <dt>sequence gaps / missing samples</dt><dd data-live="gap-missing">${summary.sequenceGapCount} / ${summary.sequenceGapSamples}</dd>
    <dt>producer overflow / output queue drops</dt><dd data-live="producer-output">${summary.producerOverflowCount} / ${summary.outputQueueDropCount}</dd>
    <dt>invalid V / invalid I</dt><dd data-live="invalid-channels">${summary.invalidVoltageCount} / ${summary.invalidCurrentCount}</dd>
    <dt>viewer evictions total / window / capacity</dt><dd data-live="viewer-evictions">${summary.viewerEvictionCount} / ${summary.viewerWindowEvictionCount} / ${summary.viewerCapacityEvictionCount}</dd>
    <dt>buffer usage / capacity</dt><dd data-live="buffer-usage">${summary.bufferUsage} / ${summary.bufferCapacity}</dd>
    <dt>marker usage / capacity</dt><dd data-live="marker-usage">${summary.markerUsage} / ${summary.markerCapacity}</dd><dt>quality</dt><dd data-live="diagnostic-quality">${q.overall}</dd>
    <dt>bundle/deployment identity</dt><dd data-live="diagnostic-deployment">${deployment.target} / ${deployment.bundleStatus}</dd><dt>bounded diagnostic count</dt><dd data-live="diagnostic-count">${s.diagnosticCount}</dd>
    <dt>last error code/message</dt><dd data-live="last-error">${escapeHtml(error.code || "none")} / ${escapeHtml(error.message || "none")}</dd>
    <dt>action rejection</dt><dd data-live="diagnostic-action-error">0 / none</dd>
  </dl><p>No secrets, raw payloads, MACs, or unbounded history are exposed.</p></section></section>`;
}

function required(root, selector) {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`professional presentation node missing: ${selector}`);
  return node;
}

export function updateProfessionalPresentation(root, owner, deployment, actionDiagnostic, primaryController) {
  updateMeasurementWorkspace(root, owner, deployment, actionDiagnostic, primaryController, PROFESSIONAL_GRAPH_VISIBILITY);
  const state = owner.adapter.summary();
  const model = owner.model;
  const summary = model.summary();
  const quality = qualityFor(owner);
  const error = presentError(state.lastError);
  required(root, '[data-live="control-state"]').textContent = `${owner.source?.state ?? "not-created"} / ${state.controlState}`;
  required(root, '[data-live="profile"]').textContent = state.profile ?? "none";
  required(root, '[data-live="diagnostic-stream"]').textContent = `live-vi / ${state.streamId ?? "none"}`;
  required(root, '[data-live="sequence-time"]').textContent = `${model.latest?.sequence ?? "none"} / ${model.latest?.timestamp_us ?? "none"}`;
  required(root, '[data-live="valid-mask"]').textContent = model.latest?.valid_mask ?? "none";
  required(root, '[data-live="sample-segment"]').textContent = `${model.sampleCount} / ${model.segmentCount}`;
  required(root, '[data-live="gap-missing"]').textContent = `${summary.sequenceGapCount} / ${summary.sequenceGapSamples}`;
  required(root, '[data-live="producer-output"]').textContent = `${summary.producerOverflowCount} / ${summary.outputQueueDropCount}`;
  required(root, '[data-live="invalid-channels"]').textContent = `${summary.invalidVoltageCount} / ${summary.invalidCurrentCount}`;
  required(root, '[data-live="viewer-evictions"]').textContent = `${summary.viewerEvictionCount} / ${summary.viewerWindowEvictionCount} / ${summary.viewerCapacityEvictionCount}`;
  required(root, '[data-live="buffer-usage"]').textContent = `${summary.bufferUsage} / ${summary.bufferCapacity}`;
  required(root, '[data-live="marker-usage"]').textContent = `${summary.markerUsage} / ${summary.markerCapacity}`;
  required(root, '[data-live="diagnostic-quality"]').textContent = quality.overall;
  required(root, '[data-live="diagnostic-deployment"]').textContent = `${deployment.target} / ${deployment.bundleStatus}`;
  required(root, '[data-live="diagnostic-count"]').textContent = state.diagnosticCount;
  required(root, '[data-live="last-error"]').textContent = `${error.code || "none"} / ${error.message || "none"}`;
  required(root, '[data-live="diagnostic-action-error"]').textContent = `${actionDiagnostic.count} / ${actionDiagnostic.lastAction}`;
}
