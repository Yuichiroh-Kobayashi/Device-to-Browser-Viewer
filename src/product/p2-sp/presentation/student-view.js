import { measurementWorkspaceMarkup, studentPrimaryActionState, updateMeasurementWorkspace } from "./measurement-workspace.js";

export { studentPrimaryActionState };

export function studentGraphVisibility(deployment) {
  if (deployment?.target !== "device-hosted") return Object.freeze({ voltage: true, current: true });
  if (deployment.displayName === "Voltage") return Object.freeze({ voltage: true, current: false });
  if (deployment.displayName === "Current") return Object.freeze({ voltage: false, current: true });
  if (deployment.displayName === "Both") return Object.freeze({ voltage: true, current: true });
  return Object.freeze({ voltage: false, current: false });
}

export function studentMarkup(themeLabel = "", controlsMarkup = "") {
  return `<section class="student" aria-label="生徒向け測定">${measurementWorkspaceMarkup(themeLabel)}${controlsMarkup}</section>`;
}

export function updateStudentPresentation(root, owner, deployment, actionDiagnostic, primaryController) {
  updateMeasurementWorkspace(root, owner, deployment, actionDiagnostic, primaryController, studentGraphVisibility(deployment));
}
