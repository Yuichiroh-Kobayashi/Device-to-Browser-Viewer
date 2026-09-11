import { createRuntimeOwner } from "./runtime-owner.js";
import { createAnimationFrameQueue, createBoundedActionDiagnostics, createPresentationCoordinator, ModeController } from "./presentation/mode-controller.js";
import { studentMarkup, updateStudentPresentation } from "./presentation/student-view.js";
import { professionalMarkup, updateProfessionalPresentation } from "./presentation/professional-view.js";
import { assessDeployment, bootstrapDeviceHosted } from "./presentation/deployment-context.js";
import { DISPLAY_WINDOWS, GraphPolicyController } from "./graph/graph-core.js";
import { GraphWaveformCanvas } from "./graph/waveform-canvas.js";
import { StudentPrimaryActionController } from "./student-primary-action-controller.js";
import { createThemeController, createThemeMediaQuery } from "./presentation/theme-controller.js";
import { HistoryReviewController, historyReviewMarkup, updateHistoryReview } from "./presentation/history-review.js";
import { createLocalCsvDownload, createStoppedHistoryCsv, csvExportState, historyCsvFilename } from "./history-csv.js";
import { GraphInteractionController } from "./presentation/graph-interaction.js";
import { channelScales, syncGraphControls } from "./presentation/graph-controls.js";

const BUILD_INCLUDE_PROFESSIONAL = typeof __INCLUDE_PROFESSIONAL__ === "undefined" ? true : __INCLUDE_PROFESSIONAL__;

export function professionalModeAllowed(buildIncludeProfessional, runtimeRequested, mode) {
  return buildIncludeProfessional === true && runtimeRequested !== false && mode === "professional";
}

export function setDisplayWindowSeconds(owner, value) {
  const seconds = Number(value);
  if (!DISPLAY_WINDOWS.includes(seconds)) throw new RangeError("unsupported display window");
  owner.model.setDisplayWindowSeconds(seconds);
}

function displayWindowMarkup(seconds) {
  return `<div class="axis-controls"><label class="display-window">Display window
    <select data-display-window aria-label="Device-time display window">
      ${DISPLAY_WINDOWS.map((value) => `<option value="${value}"${value === seconds ? " selected" : ""}>${value} seconds</option>`).join("")}
    </select>
  </label><button type="button" data-zoom-in="x">横軸 拡大 / Zoom in</button>
  <button type="button" data-zoom-out="x">横軸 縮小 / Zoom out</button></div>`;
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
  csvDownload = createLocalCsvDownload(),
} = {}) {
  if (!root) throw new TypeError("viewer root is required");
  let deployment = deploymentTarget === "device-hosted"
    ? assessDeployment({ target: "device-hosted" })
    : assessDeployment({ target: "external-development", explicitDeveloperConfiguration: true });
  const actionDiagnostics = createBoundedActionDiagnostics();
  const studentPrimaryAction = new StudentPrimaryActionController(owner);
  const graphPolicy = new GraphPolicyController({ windowSeconds: owner.model.displayWindowSeconds });
  const historyReview = new HistoryReviewController();
  const reviewState = () => historyReview.snapshot(owner.model.historySummary(), owner.stoppedHistoryReady, owner.model.displayWindowSeconds);
  // Application-lifetime presentation state. It is deliberately not reachable
  // from owner/adapter/model, and is rebuilt as "system" on every construction.
  const theme = createThemeController({ media: themeMedia, root: themeRoot });
  let controller;
  let presentation;
  let waveforms = null;
  let interactions = [];
  let observedHistoryEpoch = owner.model.historyEpoch;
  let lastLifecycleRecord = null;
  let destroyed = false;
  const waveformRender = createAnimationFrameQueue(animationScheduler, () => {
    if (!waveforms) return;
    const records = owner.model.recordSnapshot();
    const markers = owner.model.markerSnapshot();
    const review = reviewState();
    const frames = graphPolicy.update(records, { originTimestampUs: review.originTimestampUs,
      rightEdgeTimestampUs: review.enabled ? review.rightEdge : null,
      // Freeze the last live frame's scales at Stop, including pending RAFs.
      // Reopening or a failed Start cannot overwrite those presentation values.
      autoscale: owner.adapter.controlState === "STREAMING" });
    syncGraphControls(root, graphPolicy, review.enabled);
    if (!waveforms.voltage.canvas.closest("[data-graph-panel]")?.hidden) waveforms.voltage.draw(frames.voltage, markers, frames.precision);
    if (!waveforms.current.canvas.closest("[data-graph-panel]")?.hidden) waveforms.current.draw(frames.current, markers, frames.precision);
  });

  function destroyWaveforms() {
    waveformRender.cancel();
    interactions.forEach(interaction => interaction.destroy());
    interactions = [];
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
      voltage: new GraphWaveformCanvas(voltageCanvas, { channel: "voltage", unit: "V", title: "Voltage", onResize, readout: root.querySelector('[data-scale-readout="voltage"]') }),
      current: new GraphWaveformCanvas(currentCanvas, { channel: "current", unit: "A", title: "Current", onResize, readout: root.querySelector('[data-scale-readout="current"]') }),
    });
    interactions = ["voltage", "current"].map(channel => new GraphInteractionController(waveforms[channel].canvas, {
      channel,
      getState: () => ({ windowSeconds: graphPolicy.windowSeconds,
        yScale: channelScales(channel)[graphPolicy.scaleIndices[channel]], review: reviewState() }),
      changeWindow, changeScale,
      panTo: timestamp => {
        historyReview.panTo(timestamp, owner.model.historySummary(), owner.stoppedHistoryReady, graphPolicy.windowSeconds);
        presentation.update();
      },
    }));
  }

  function changeWindow(value) {
    setDisplayWindowSeconds(owner, value);
    graphPolicy.setWindowSeconds(owner.model.displayWindowSeconds);
    presentation.update();
  }

  function changeScale(channel, value) {
    graphPolicy.setStoppedScale(channel, Number(value), reviewState().enabled);
    presentation.update();
  }

  function update(mode) {
    updateHistoryReview(root, owner.model.historySummary(), reviewState());
    const csvState = csvExportState(owner.model.historySummary(), owner.stoppedHistoryReady);
    root.querySelector("[data-history-export]").disabled = !csvState.enabled;
    root.querySelector("[data-history-export-reason]").textContent = csvState.reason;
    if (!csvState.enabled) root.querySelector("[data-history-export-result]").textContent = "";
    syncGraphControls(root, graphPolicy, reviewState().enabled);
    const diagnostic = actionDiagnostics.snapshot();
    if (BUILD_INCLUDE_PROFESSIONAL) {
      if (professionalModeAllowed(BUILD_INCLUDE_PROFESSIONAL, includeProfessional, mode)) {
        updateProfessionalPresentation(root, owner, deployment, diagnostic, studentPrimaryAction);
        waveformRender.request();
        return;
      }
    }
    updateStudentPresentation(root, owner, deployment, diagnostic, studentPrimaryAction);
    waveformRender.request();
  }

  // Shared by both modes and placed by studentMarkup/professionalMarkup right
  // after the common measurement workspace -- ahead of Professional's own
  // diagnostics section, so returning to Student never requires scrolling
  // past the whole diagnostics list.
  function controlsMarkup(mode) {
    const toggle = BUILD_INCLUDE_PROFESSIONAL && includeProfessional ? `<button id="toggle">${mode === "student" ? "Professional" : "Student"}</button>` : "";
    return `${displayWindowMarkup(owner.model.displayWindowSeconds)}${toggle}${historyReviewMarkup()}
      <button type="button" data-history-export aria-describedby="history-export-reason" disabled>CSVを保存 / Export CSV</button>
      <p id="history-export-reason" class="quality" data-history-export-reason></p>
      <p role="status" data-history-export-result></p>`;
  }

  function mount(mode) {
    destroyWaveforms();
    let professional = false;
    if (BUILD_INCLUDE_PROFESSIONAL) {
      professional = professionalModeAllowed(BUILD_INCLUDE_PROFESSIONAL, includeProfessional, mode);
      root.innerHTML = professional ? professionalMarkup(owner, deployment, theme.label, controlsMarkup(mode)) : studentMarkup(theme.label, controlsMarkup(mode));
    } else {
      root.innerHTML = studentMarkup(theme.label, controlsMarkup(mode));
    }
    mountWaveforms();
    const displayWindow = root.querySelector("[data-display-window]");
    displayWindow.onchange = () => {
      try {
        changeWindow(displayWindow.value);
      } catch {
        displayWindow.value = String(owner.model.displayWindowSeconds);
      }
    };
    for (const axis of ["x", "voltage", "current"]) {
      if (axis !== "x") {
        const select = root.querySelector(`[data-y-scale="${axis}"]`);
        select.onchange = () => changeScale(axis, select.value);
      }
      for (const [direction, delta] of [["in", -1], ["out", 1]]) {
        const button = root.querySelector(`[data-zoom-${direction}="${axis}"]`);
        button.onclick = () => {
          if (button.disabled) return;
          const scales = axis === "x" ? DISPLAY_WINDOWS : channelScales(axis);
          const index = axis === "x" ? scales.indexOf(graphPolicy.windowSeconds) : graphPolicy.scaleIndices[axis];
          if (axis === "x") changeWindow(scales[index + delta]);
          else changeScale(axis, scales[index + delta]);
        };
      }
    }
    const toggle = root.querySelector("#toggle");
    const moveHistory = (action, position = null) => {
      historyReview.move(action, owner.model.historySummary(), owner.stoppedHistoryReady, owner.model.displayWindowSeconds, position);
      presentation.update();
    };
    for (const action of ["back", "forward", "latest"]) root.querySelector(`[data-history-${action}]`).onclick = () => moveHistory(action);
    const position = root.querySelector("[data-history-position]");
    position.oninput = () => moveHistory("position", position.value);
    root.querySelector("[data-history-export]").onclick = () => {
      try {
        const csv = createStoppedHistoryCsv(owner.model, owner.stoppedHistoryReady);
        csvDownload.save(csv, historyCsvFilename());
        root.querySelector("[data-history-export-result]").textContent = "CSVの保存を要求しました。 / Download requested.";
      } catch {
        root.querySelector("[data-history-export-result]").textContent = "CSVを保存できませんでした。 / CSV export unavailable.";
      }
    };
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
  // Only the label node is rewritten, so the icon node beside it survives
  // every theme change untouched.
  function syncThemeControl() {
    const themeLabel = root.querySelector("[data-theme-toggle-label]");
    if (themeLabel) themeLabel.textContent = theme.label;
  }
  const unsubscribeTheme = theme.subscribe(() => { syncThemeControl(); waveformRender.request(); });
  presentation = createPresentationCoordinator({ mount, update });
  controller = new ModeController(owner, { deployment, render: (mode) => presentation.setMode(mode) });
  const observeGraphLifecycle = () => {
    const state = owner.adapter.summary(); const latest = owner.model.latest;
    const newRecord = latest !== null && latest !== lastLifecycleRecord;
    graphPolicy.observeLifecycle({ controlState: state.controlState, streamId: state.streamId, timebaseReset: newRecord && Boolean(latest.flags?.timebase_reset) });
    if (observedHistoryEpoch !== owner.model.historyEpoch) {
      interactions.forEach(interaction => interaction.cancel());
      observedHistoryEpoch = owner.model.historyEpoch;
    }
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
    historyReview,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      unsubscribeTheme();
      theme.dispose();
      studentPrimaryAction.dispose();
      csvDownload.dispose();
      destroyWaveforms();
    },
  });
}

if (typeof document !== "undefined") createViewerApplication({ root: document.querySelector("#viewer") });
