import { createRuntimeOwner } from "./runtime-owner.js";
import { createAnimationFrameQueue, createBoundedActionDiagnostics, createPresentationCoordinator, ModeController } from "./presentation/mode-controller.js";
import { studentActionEnabled, studentMarkup, updateStudentPresentation } from "./presentation/student-view.js";
import { professionalMarkup, updateProfessionalPresentation } from "./presentation/professional-view.js";
import { assessDeployment, bootstrapDeviceHosted } from "./presentation/deployment-context.js";
import { WaveformCanvas } from "../source-export/viewer/src/render/waveform-canvas.js";

export function createViewerApplication({
  root,
  owner = createRuntimeOwner(),
  deploymentTarget = typeof __DEPLOYMENT_TARGET__ === "undefined" ? "external-development" : __DEPLOYMENT_TARGET__,
  includeProfessional = typeof __INCLUDE_PROFESSIONAL__ === "undefined" ? true : __INCLUDE_PROFESSIONAL__,
  pageLocation = globalThis.location,
  animationScheduler = globalThis,
} = {}) {
  if (!root) throw new TypeError("viewer root is required");
  let deployment = assessDeployment({ target: "external-development", explicitDeveloperConfiguration: true });
  const actionDiagnostics = createBoundedActionDiagnostics();
  let controller;
  let presentation;
  let waveforms = null;
  const waveformRender = createAnimationFrameQueue(animationScheduler, () => {
    if (!waveforms) return;
    const records = owner.model.recordSnapshot();
    const markers = owner.model.markerSnapshot();
    waveforms.voltage.draw(records, markers);
    waveforms.current.draw(records, markers);
  });

  function destroyWaveforms() {
    waveformRender.cancel();
    waveforms?.voltage.destroy();
    waveforms?.current.destroy();
    waveforms = null;
  }

  function mountWaveforms() {
    const voltageCanvas = root.querySelector('[data-waveform="voltage"]');
    const currentCanvas = root.querySelector('[data-waveform="current"]');
    if (!voltageCanvas || !currentCanvas) throw new Error("waveform canvas nodes are missing");
    const onResize = () => waveformRender.request();
    waveforms = Object.freeze({
      voltage: new WaveformCanvas(voltageCanvas, { channel: "voltage", unit: "V", title: "Voltage", onResize }),
      current: new WaveformCanvas(currentCanvas, { channel: "current", unit: "A", title: "Current", onResize }),
    });
  }

  function update(mode) {
    const diagnostic = actionDiagnostics.snapshot();
    if (includeProfessional && mode === "professional") updateProfessionalPresentation(root, owner, deployment, diagnostic);
    else {
      updateStudentPresentation(root, owner, deployment, diagnostic);
      waveformRender.request();
    }
  }

  function mount(mode) {
    destroyWaveforms();
    const professional = includeProfessional && mode === "professional";
    root.innerHTML = `${professional ? professionalMarkup(owner, deployment) : studentMarkup()}${includeProfessional ? `<button id="toggle">${mode === "student" ? "Professional" : "Student"}</button>` : ""}`;
    if (!professional) mountWaveforms();
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
  return Object.freeze({
    owner,
    controller,
    presentation,
    actionDiagnostics,
    destroy() {
      unsubscribe();
      destroyWaveforms();
    },
  });
}

if (typeof document !== "undefined") createViewerApplication({ root: document.querySelector("#viewer") });
