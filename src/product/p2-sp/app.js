import { createRuntimeOwner } from "./runtime-owner.js";
import { ModeController } from "./presentation/mode-controller.js";
import { studentActionEnabled, studentMarkup } from "./presentation/student-view.js";
import { professionalMarkup } from "./presentation/professional-view.js";
import { assessDeployment, bootstrapDeviceHosted } from "./presentation/deployment-context.js";

const root = document.querySelector("#viewer");
const owner = createRuntimeOwner();
const deploymentTarget = typeof __DEPLOYMENT_TARGET__ === "undefined" ? "external-development" : __DEPLOYMENT_TARGET__;
let deployment = assessDeployment({ target: "external-development", explicitDeveloperConfiguration: true });
const includeProfessional = typeof __INCLUDE_PROFESSIONAL__ === "undefined" ? true : __INCLUDE_PROFESSIONAL__;
const controller = new ModeController(owner, { deployment, render(mode) {
  const professional = includeProfessional && mode === "professional";
  root.innerHTML = `${professional ? professionalMarkup(owner, deployment) : studentMarkup(owner, deployment)}${includeProfessional ? `<button id="toggle">${mode === "student" ? "Professional" : "Student"}</button>` : ""}`;
  const toggle = root.querySelector("#toggle"); if (toggle) toggle.onclick = () => controller.toggle();
  root.querySelectorAll("[data-action]").forEach((button) => { button.onclick = async () => {
    const action = button.dataset.action;
    if (!studentActionEnabled(owner.adapter.summary(), deployment, action)) return;
    try {
      await owner.actions[action]();
    } catch {
      // Rejected transport actions leave the single frozen runtime owner intact.
    }
  }; });
} });
owner.subscribe(() => controller.setMode(controller.mode));
if (deploymentTarget === "device-hosted") {
  bootstrapDeviceHosted({ pageAuthority: location.href, configuredWsAuthority: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/d2b/v0/stream` }).then((result) => { deployment = result; controller.setMode("student"); });
} else controller.setMode("student");
