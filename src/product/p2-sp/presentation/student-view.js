import { displayValue, qualityFor, presentError } from "./view-state.js";

const STUDENT_ACTIONS = Object.freeze(["open", "start", "stop", "close"]);

export function studentActionEnabled(state, deployment, action) {
  if (!STUDENT_ACTIONS.includes(action)) return false;
  if (state.startPending || state.stopPending) return false;
  if (state.controlState === "CLOSED") return action === "open";
  if (state.controlState === "READY") return action === "start" ? deployment.startAllowed : action === "close";
  return state.controlState === "STREAMING" && action === "stop";
}

function actionMarkup(state, deployment) {
  return STUDENT_ACTIONS.map((action) => `<button data-action="${action}"${studentActionEnabled(state, deployment, action) ? "" : " disabled"}>${action[0].toUpperCase()}${action.slice(1)}</button>`).join("");
}

export function studentMarkup(owner, deployment) {
  const state = owner.adapter.summary(); const error = presentError(state.lastError);
  const quality = qualityFor(owner);
  const latest = owner.model.latest;
  return `<section class="student" aria-label="生徒向け測定">
    <header><strong>VAMeter / V-I measurement</strong><span>接続: ${state.controlState}</span><span>測定: ${state.streamId ?? "none"}</span></header>
    <p class="deployment" data-deployment-status="${deployment.bundleStatus}">配備状態: ${deployment.bundleStatus}; ${deployment.message}</p>
    <p class="quality">データ品質: ${quality.overall}; 電圧: ${quality.voltage}; 電流: ${quality.current}; gap: ${quality.gap ? "あり" : "なし"}</p>
    <div class="values"><output>Voltage ${displayValue(latest?.voltage_V, "V", quality.voltage)}</output><output>Current ${displayValue(latest?.current_A, "A", quality.current)}</output></div>
    <div class="graphs"><section aria-label="Voltage graph">Voltage graph: device-time axis; gaps are not joined</section><section aria-label="Current graph">Current graph: device-time axis; invalid is not zero</section></div>
    <p class="error">recoverable error: ${error.classification === "recoverable" ? error.code : "none"}; fatal-semantic error: ${error.classification === "fatal-semantic" ? error.code : "none"}</p>
    <div class="actions">${actionMarkup(state, deployment)}<span>busy / meter-in-use: ${state.startPending ? "yes" : "no"}</span></div>
    <p>State-appropriate action only; forced Close is never the ordinary Student action.</p>
  </section>`;
}
