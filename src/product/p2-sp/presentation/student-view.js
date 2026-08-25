import { displayValue, qualityFor, presentError } from "./view-state.js";

export function studentGraphVisibility(deployment) {
  if (deployment?.target !== "device-hosted") return Object.freeze({ voltage: true, current: true });
  if (deployment.displayName === "Voltage") return Object.freeze({ voltage: true, current: false });
  if (deployment.displayName === "Current") return Object.freeze({ voltage: false, current: true });
  if (deployment.displayName === "Both") return Object.freeze({ voltage: true, current: true });
  return Object.freeze({ voltage: false, current: false });
}

export function studentPrimaryActionState(state, deployment, operation) {
  if (operation.inFlight) return Object.freeze({ enabled: false, busy: true, label: operation.operationKind === "stop" ? "終了中… / Stopping…" : "開始中… / Starting…" });
  if (state.startPending) return Object.freeze({ enabled: false, busy: true, label: "開始中… / Starting…" });
  if (state.stopPending) return Object.freeze({ enabled: false, busy: true, label: "終了中… / Stopping…" });
  if (state.controlState === "STREAMING") return Object.freeze({ enabled: true, busy: false, label: "測定終了 / Stop" });
  const enabled = (state.controlState === "CLOSED" || state.controlState === "READY") && deployment.startAllowed === true;
  return Object.freeze({ enabled, busy: false, label: "測定開始 / Start" });
}

function required(root, selector) {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`student presentation node missing: ${selector}`);
  return node;
}

export function studentMarkup() {
  return `<section class="student" aria-label="生徒向け測定">
    <header><strong>VAMeter / V-I measurement</strong><span data-live="connection"></span><span data-live="stream"></span></header>
    <p class="deployment" data-live="deployment"></p>
    <div class="primary-action"><button data-student-primary-action disabled>測定開始 / Start</button></div>
    <div class="values"><output data-value-panel="voltage" data-live="voltage"></output><output data-value-panel="current" data-live="current"></output></div>
    <div class="graphs" data-student-graphs>
      <section class="graph-panel" data-graph-panel="voltage" aria-label="Voltage graph"><canvas data-waveform="voltage" role="img" aria-label="Voltage graph over device time; gaps are not joined"></canvas></section>
      <section class="graph-panel" data-graph-panel="current" aria-label="Current graph"><canvas data-waveform="current" role="img" aria-label="Current graph over device time; invalid samples are not zero"></canvas></section>
    </div>
    <p class="quality" data-live="quality"></p>
    <p class="error" data-live="error"></p>
    <p class="error" data-live="action-error"></p>
  </section>`;
}

function visibleQuality(value) {
  return value === "stale" ? "停止時の値" : value === "invalid" ? "無効" : value === "no-valid-data" ? "データなし" : "";
}

export function updateStudentPresentation(root, owner, deployment, actionDiagnostic, primaryController) {
  const state = owner.adapter.summary();
  const error = presentError(state.lastError);
  const quality = qualityFor(owner);
  const latest = owner.model.latest;
  const graphVisibility = studentGraphVisibility(deployment);
  required(root, '[data-live="connection"]').textContent = `接続: ${state.controlState}`;
  required(root, '[data-live="stream"]').textContent = `測定: ${state.streamId ?? "none"}`;
  const deploymentNode = required(root, '[data-live="deployment"]');
  deploymentNode.dataset.deploymentStatus = deployment.bundleStatus;
  deploymentNode.textContent = `配備状態: ${deployment.bundleStatus}; ${deployment.message}`;
  const qualityParts = [visibleQuality(quality.overall), quality.gap ? "欠落あり" : ""].filter(Boolean);
  required(root, '[data-live="quality"]').textContent = qualityParts.join(" · ");
  required(root, '[data-live="voltage"]').textContent = `電圧 Voltage ${displayValue(latest?.voltage_V, "V", visibleQuality(quality.voltage))}`.trim();
  required(root, '[data-live="current"]').textContent = `電流 Current ${displayValue(latest?.current_A, "A", visibleQuality(quality.current))}`.trim();
  required(root, '[data-live="error"]').textContent = error.classification === "none" ? "" : `測定エラー: ${error.code}`;
  required(root, '[data-live="action-error"]').textContent = actionDiagnostic.count ? `操作を完了できませんでした (${actionDiagnostic.lastAction})` : "";
  required(root, '[data-value-panel="voltage"]').hidden = !graphVisibility.voltage;
  required(root, '[data-value-panel="current"]').hidden = !graphVisibility.current;
  required(root, '[data-graph-panel="voltage"]').hidden = !graphVisibility.voltage;
  required(root, '[data-graph-panel="current"]').hidden = !graphVisibility.current;
  required(root, "[data-student-graphs]").dataset.layout = graphVisibility.voltage && graphVisibility.current ? "both" : "single";
  const primaryState = studentPrimaryActionState(state, deployment, primaryController.snapshot());
  const button = required(root, "[data-student-primary-action]");
  button.textContent = primaryState.label;
  button.disabled = !primaryState.enabled;
  button.setAttribute("aria-disabled", String(!primaryState.enabled));
  button.setAttribute("aria-busy", String(primaryState.busy));
}
