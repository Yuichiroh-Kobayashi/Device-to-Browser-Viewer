import { CURRENT_SCALES, DISPLAY_WINDOWS, VOLTAGE_SCALES, formatYAxisTick } from "../graph/graph-core.js";

export const channelScales = (channel) => channel === "voltage" ? VOLTAGE_SCALES : CURRENT_SCALES;

export function yScaleMarkup(channel) {
  const title = channel === "voltage" ? "電圧 Voltage" : "電流 Current";
  const unit = channel === "voltage" ? "V" : "A";
  return `<div class="axis-controls" aria-label="${title} scale">
    <label>${title} / 目盛
      <select data-y-scale="${channel}" aria-label="${title} per division" disabled>
        ${channelScales(channel).map(value => `<option value="${value}">${channel === "current" ? formatYAxisTick(value, channel, value) : `${value} ${unit}`}</option>`).join("")}
      </select>
    </label>
    <button type="button" data-zoom-in="${channel}" aria-label="${title} scale zoom in" disabled>拡大 / Zoom in</button>
    <button type="button" data-zoom-out="${channel}" aria-label="${title} scale zoom out" disabled>縮小 / Zoom out</button>
    <button type="button" data-y-auto="${channel}" aria-label="${title} auto scale" aria-pressed="true" disabled>自動 / Auto</button>
  </div>`;
}

export function syncGraphControls(root, policy, stoppedReady) {
  const window = root.querySelector("[data-display-window]");
  window.value = String(policy.windowSeconds);
  for (const axis of ["x", "voltage", "current"]) {
    const scales = axis === "x" ? DISPLAY_WINDOWS : channelScales(axis);
    const index = axis === "x" ? scales.indexOf(policy.windowSeconds) : policy.scaleIndices[axis];
    const enabled = axis === "x" || stoppedReady;
    if (axis !== "x") {
      const select = root.querySelector(`[data-y-scale="${axis}"]`);
      select.value = String(scales[index]); select.disabled = !enabled;
      // Auto stays mounted in LIVE, where it is disabled because LIVE already
      // is the zero-origin autoscale state. aria-pressed carries that "already
      // Auto" fact natively rather than through a second label or DOM node.
      const auto = root.querySelector(`[data-y-auto="${axis}"]`);
      const { mode } = policy.yPresentation(axis);
      auto.disabled = !enabled;
      auto.dataset.yMode = mode;
      auto.setAttribute("aria-pressed", String(mode === "LIVE_AUTO_ZERO" || mode === "STOPPED_AUTO_ZERO"));
    }
    root.querySelector(`[data-zoom-in="${axis}"]`).disabled = !enabled || index === 0;
    root.querySelector(`[data-zoom-out="${axis}"]`).disabled = !enabled || index === scales.length - 1;
  }
}
