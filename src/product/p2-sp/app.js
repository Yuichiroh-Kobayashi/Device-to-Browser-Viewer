import { createRuntimeOwner } from "./runtime-owner.js";
import { createBoundedActionDiagnostics, createPresentationCoordinator, ModeController } from "./presentation/mode-controller.js";
import { studentActionEnabled, studentMarkup, updateStudentPresentation } from "./presentation/student-view.js";
import { professionalMarkup, updateProfessionalPresentation } from "./presentation/professional-view.js";
import { assessDeployment, bootstrapDeviceHosted } from "./presentation/deployment-context.js";

export function createViewerApplication({
  root,
  owner = createRuntimeOwner(),
  deploymentTarget = typeof __DEPLOYMENT_TARGET__ === "undefined" ? "external-development" : __DEPLOYMENT_TARGET__,
  includeProfessional = typeof __INCLUDE_PROFESSIONAL__ === "undefined" ? true : __INCLUDE_PROFESSIONAL__,
  pageLocation = globalThis.location,
} = {}) {
  if (!root) throw new TypeError("viewer root is required");
  let deployment = assessDeployment({ target: "external-development", explicitDeveloperConfiguration: true });
  const actionDiagnostics = createBoundedActionDiagnostics();
  let controller;
  let presentation;

  function update(mode) {
    const diagnostic = actionDiagnostics.snapshot();
    if (includeProfessional && mode === "professional") updateProfessionalPresentation(root, owner, deployment, diagnostic);
    else updateStudentPresentation(root, owner, deployment, diagnostic);
  }

  function mount(mode) {
    const professional = includeProfessional && mode === "professional";
    root.innerHTML = `${professional ? professionalMarkup(owner, deployment) : studentMarkup()}${includeProfessional ? `<button id="toggle">${mode === "student" ? "Professional" : "Student"}</button>` : ""}`;
    const toggle = root.querySelector("#toggle");
    if (toggle) toggle.onclick = () => controller.toggle();
    root.querySelectorAll("[data-action]").forEach((button) => {
      button.onclick = async () => {
        const action = button.dataset.action;
        if (!studentActionEnabled(owner.adapter.summary(), deployment, action)) return;
        try {
          await owner.actions[action]();
        } catch {
          actionDiagnostics.record(action);
          presentation.update();
        }
      };
    });
  }

  presentation = createPresentationCoordinator({ mount, update });
  controller = new ModeController(owner, { deployment, render: (mode) => presentation.setMode(mode) });
  const unsubscribe = owner.subscribe(() => presentation.update());
  controller.setMode("student");
  if (deploymentTarget === "device-hosted") {
    const configuredWsAuthority = `${pageLocation.protocol === "https:" ? "wss:" : "ws:"}//${pageLocation.host}/d2b/v0/stream`;
    bootstrapDeviceHosted({ pageAuthority: pageLocation.href, configuredWsAuthority }).then((result) => {
      deployment = result;
      presentation.update();
    });
  }
  return Object.freeze({ owner, controller, presentation, actionDiagnostics, destroy: unsubscribe });
}

if (typeof document !== "undefined") createViewerApplication({ root: document.querySelector("#viewer") });
