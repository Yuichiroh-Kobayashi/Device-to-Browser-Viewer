import { displayValue, qualityFor, presentError } from "./view-state.js";

const STUDENT_ACTIONS = Object.freeze(["open", "start", "stop", "close"]);

export function studentGraphVisibility(deployment) {
  if (deployment?.target !== "device-hosted") return Object.freeze({ voltage: true, current: true });
  if (deployment.displayName === "Voltage") return Object.freeze({ voltage: true, current: false });
  if (deployment.displayName === "Current") return Object.freeze({ voltage: false, current: true });
  if (deployment.displayName === "Both") return Object.freeze({ voltage: true, current: true });
  return Object.freeze({ voltage: false, current: false });
}

export function studentActionEnabled(state, deployment, action) {
  if (!STUDENT_ACTIONS.includes(action)) return false;
  if (state.startPending || state.stopPending) return false;
  if (state.controlState === "CLOSED") return action === "open";
  if (state.controlState === "READY") return action === "start" ? deployment.startAllowed : action === "close";
  return state.controlState === "STREAMING" && action === "stop";
}

function actionMarkup() {
  return STUDENT_ACTIONS.map((action) => `<button data-action="${action}" disabled>${action[0].toUpperCase()}${action.slice(1)}</button>`).join("");
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
    <p class="quality" data-live="quality"></p>
    <div class="values"><output data-live="voltage"></output><output data-live="current"></output></div>
    <div class="graphs">
      <section class="graph-panel" data-graph-panel="voltage" aria-label="Voltage graph"><canvas data-waveform="voltage" role="img" aria-label="Voltage graph over device time; gaps are not joined"></canvas></section>
      <section class="graph-panel" data-graph-panel="current" aria-label="Current graph"><canvas data-waveform="current" role="img" aria-label="Current graph over device time; invalid samples are not zero"></canvas></section>
    </div>
    <p class="error" data-live="error"></p>
    <p class="error" data-live="action-error"></p>
    <div class="actions">${actionMarkup()}<span data-live="busy"></span></div>
    <p>State-appropriate action only; forced Close is never the ordinary Student action.</p>
  </section>`;
}

export function updateStudentPresentation(root, owner, deployment, actionDiagnostic) {
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
  required(root, '[data-live="quality"]').textContent = `データ品質: ${quality.overall}; 電圧: ${quality.voltage}; 電流: ${quality.current}; gap: ${quality.gap ? "あり" : "なし"}`;
  required(root, '[data-live="voltage"]').textContent = `Voltage ${displayValue(latest?.voltage_V, "V", quality.voltage)}`;
  required(root, '[data-live="current"]').textContent = `Current ${displayValue(latest?.current_A, "A", quality.current)}`;
  required(root, '[data-live="error"]').textContent = `recoverable error: ${error.classification === "recoverable" ? error.code : "none"}; fatal-semantic error: ${error.classification === "fatal-semantic" ? error.code : "none"}`;
  required(root, '[data-live="action-error"]').textContent = `action rejection: ${actionDiagnostic.count}; last: ${actionDiagnostic.lastAction}`;
  required(root, '[data-live="busy"]').textContent = `busy / meter-in-use: ${state.startPending ? "yes" : "no"}`;
  required(root, '[data-graph-panel="voltage"]').hidden = !graphVisibility.voltage;
  required(root, '[data-graph-panel="current"]').hidden = !graphVisibility.current;
  root.querySelectorAll("[data-action]").forEach((button) => {
    const enabled = studentActionEnabled(state, deployment, button.dataset.action);
    button.disabled = !enabled;
    button.setAttribute("aria-disabled", String(!enabled));
  });
}
