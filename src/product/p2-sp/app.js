import { createRuntimeOwner } from "./runtime-owner.js";
import { createAnimationFrameQueue, createBoundedActionDiagnostics, createPresentationCoordinator, ModeController } from "./presentation/mode-controller.js";
import { studentMarkup, updateStudentPresentation } from "./presentation/student-view.js";
import { professionalMarkup, updateProfessionalPresentation } from "./presentation/professional-view.js";
import { assessDeployment, bootstrapDeviceHosted } from "./presentation/deployment-context.js";
import { GraphPolicyController } from "./graph/graph-core.js";
import { GraphWaveformCanvas } from "./graph/waveform-canvas.js";
import { StudentPrimaryActionController } from "./student-primary-action-controller.js";
import { createThemeController, createThemeMediaQuery, themeControlMarkup } from "./presentation/theme-controller.js";

const BUILD_INCLUDE_PROFESSIONAL = typeof __INCLUDE_PROFESSIONAL__ === "undefined" ? true : __INCLUDE_PROFESSIONAL__;

export function professionalModeAllowed(buildIncludeProfessional, runtimeRequested, mode) {
  return buildIncludeProfessional === true && runtimeRequested !== false && mode === "professional";
}

const DISPLAY_WINDOW_SECONDS = Object.freeze([10, 30, 60]);

export function setDisplayWindowSeconds(owner, value) {
  const seconds = Number(value);
  if (!DISPLAY_WINDOW_SECONDS.includes(seconds)) throw new RangeError("display window must be exactly 10, 30, or 60 seconds");
  owner.model.setDisplayWindowSeconds(seconds);
}

function displayWindowMarkup(seconds) {
  return `<label class="display-window">Display window
    <select data-display-window aria-label="Device-time display window">
      ${DISPLAY_WINDOW_SECONDS.map((value) => `<option value="${value}"${value === seconds ? " selected" : ""}>${value} seconds</option>`).join("")}
    </select>
  </label>`;
}

export function createViewerApplication({
  root,
  owner = createRuntimeOwner(),
  deploymentTarget = typeof __DEPLOYMENT_TARGET__ === "undefined" ? "external-development" : __DEPLOYMENT_TARGET__,
  includeProfessional = true,
  pageLocation = globalThis.location,
  animationScheduler = globalThis,
  themeMedia = createThemeMediaQuery(globalThis),
  themeRoot = globalThis.document?.documentElement ?? null,
} = {}) {
  if (!root) throw new TypeError("viewer root is required");
  let deployment = deploymentTarget === "device-hosted"
    ? assessDeployment({ target: "device-hosted" })
    : assessDeployment({ target: "external-development", explicitDeveloperConfiguration: true });
  const actionDiagnostics = createBoundedActionDiagnostics();
  const studentPrimaryAction = new StudentPrimaryActionController(owner);
  const graphPolicy = new GraphPolicyController({ windowSeconds: owner.model.displayWindowSeconds });
  // Application-lifetime presentation state. It is deliberately not reachable
  // from owner/adapter/model, and is rebuilt as "system" on every construction.
  const theme = createThemeController({ media: themeMedia, root: themeRoot });
  let controller;
  let presentation;
  let waveforms = null;
  let lastLifecycleRecord = null;
  let destroyed = false;
  const waveformRender = createAnimationFrameQueue(animationScheduler, () => {
    if (!waveforms) return;
    const records = owner.model.recordSnapshot();
    const markers = owner.model.markerSnapshot();
    const frames = graphPolicy.update(records);
    if (!waveforms.voltage.canvas.closest("[data-graph-panel]")?.hidden) waveforms.voltage.draw(frames.voltage, markers, frames.precision);
    if (!waveforms.current.canvas.closest("[data-graph-panel]")?.hidden) waveforms.current.draw(frames.current, markers, frames.precision);
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
      voltage: new GraphWaveformCanvas(voltageCanvas, { channel: "voltage", unit: "V", title: "Voltage", onResize }),
      current: new GraphWaveformCanvas(currentCanvas, { channel: "current", unit: "A", title: "Current", onResize }),
    });
  }

  function update(mode) {
    const diagnostic = actionDiagnostics.snapshot();
    if (BUILD_INCLUDE_PROFESSIONAL) {
      if (professionalModeAllowed(BUILD_INCLUDE_PROFESSIONAL, includeProfessional, mode)) {
        updateProfessionalPresentation(root, owner, deployment, diagnostic);
        waveformRender.request();
        return;
      }
    }
    updateStudentPresentation(root, owner, deployment, diagnostic, studentPrimaryAction);
    waveformRender.request();
  }

  function mount(mode) {
    destroyWaveforms();
    let professional = false;
    if (BUILD_INCLUDE_PROFESSIONAL) {
      professional = professionalModeAllowed(BUILD_INCLUDE_PROFESSIONAL, includeProfessional, mode);
      root.innerHTML = `${themeControlMarkup(theme.label)}${professional ? professionalMarkup(owner, deployment) : studentMarkup()}${displayWindowMarkup(owner.model.displayWindowSeconds)}${includeProfessional ? `<button id="toggle">${mode === "student" ? "Professional" : "Student"}</button>` : ""}`;
    } else {
      root.innerHTML = `${themeControlMarkup(theme.label)}${studentMarkup()}${displayWindowMarkup(owner.model.displayWindowSeconds)}`;
    }
    mountWaveforms();
    const displayWindow = root.querySelector("[data-display-window]");
    displayWindow.onchange = () => {
      try {
        setDisplayWindowSeconds(owner, displayWindow.value);
        graphPolicy.setWindowSeconds(owner.model.displayWindowSeconds);
        waveformRender.request();
      } catch {
        displayWindow.value = String(owner.model.displayWindowSeconds);
      }
    };
    const toggle = root.querySelector("#toggle");
    if (toggle) toggle.onclick = () => controller.toggle();
    const themeButton = root.querySelector("[data-theme-toggle]");
    if (themeButton) themeButton.onclick = () => theme.toggle();
    const studentButton = root.querySelector("[data-student-primary-action]");
    if (studentButton) {
      studentButton.onclick = async () => {
        try {
          await studentPrimaryAction.activate(deployment);
        } catch {
          actionDiagnostics.record(studentPrimaryAction.snapshot().lastAttemptedOperation);
        } finally {
          presentation.update();
        }
      };
    }
  }

  // Repainting the canvas and relabelling the existing control is the whole
  // theme effect: no remount, and nothing here touches transport or model.
  function syncThemeControl() {
    const themeButton = root.querySelector("[data-theme-toggle]");
    if (themeButton) themeButton.textContent = theme.label;
  }
  const unsubscribeTheme = theme.subscribe(() => { syncThemeControl(); waveformRender.request(); });
  presentation = createPresentationCoordinator({ mount, update });
  controller = new ModeController(owner, { deployment, render: (mode) => presentation.setMode(mode) });
  const observeGraphLifecycle = () => {
    const state = owner.adapter.summary(); const latest = owner.model.latest;
    const newRecord = latest !== null && latest !== lastLifecycleRecord;
    graphPolicy.observeLifecycle({ controlState: state.controlState, streamId: state.streamId, timebaseReset: newRecord && Boolean(latest.flags?.timebase_reset) });
    lastLifecycleRecord = latest;
  };
  observeGraphLifecycle();
  const unsubscribe = owner.subscribe(() => { observeGraphLifecycle(); presentation.update(); });
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
    theme,
    actionDiagnostics,
    graphPolicy,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      unsubscribeTheme();
      theme.dispose();
      studentPrimaryAction.dispose();
      destroyWaveforms();
    },
  });
}

if (typeof document !== "undefined") createViewerApplication({ root: document.querySelector("#viewer") });
