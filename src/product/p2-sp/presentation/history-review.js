import { makeTimeDomain, timePrecision } from "../graph/graph-core.js";

const clamp = (value, minimum, maximum) => value < minimum ? minimum : value > maximum ? maximum : value;

/** Presentation cursor only. Inputs are snapshots, with no mutation authority. */
export class HistoryReviewController {
  constructor() { this.epoch = null; this.rightEdgeTimestampUs = null; }

  snapshot(history, ready, windowSeconds) {
    if (this.epoch !== history.epoch) this.rightEdgeTimestampUs = null;
    this.epoch = history.epoch;
    const enabled = ready === true && history.count > 0;
    const latest = history.latestTimestampUs;
    const width = BigInt(windowSeconds) * 1_000_000n;
    const earliest = latest === null ? null : clamp(history.firstTimestampUs + width, history.firstTimestampUs, latest);
    if (this.rightEdgeTimestampUs !== null && latest !== null) this.rightEdgeTimestampUs = clamp(this.rightEdgeTimestampUs, earliest, latest);
    const rightEdge = this.rightEdgeTimestampUs ?? latest;
    const span = latest === null ? 0n : latest - earliest;
    const position = span > 0n ? Number((rightEdge - earliest) * 1000n / span) : 1000;
    const domain = makeTimeDomain(history.originTimestampUs, rightEdge, windowSeconds);
    return Object.freeze({ enabled, earliest, latest, rightEdge, position, domain,
      canBack: enabled && rightEdge > earliest, canForward: enabled && rightEdge < latest,
      // Cursor endpoints retain sub-second detail; 10 s grid ticks are integers.
      originTimestampUs: history.originTimestampUs, precision: windowSeconds === 10 ? 1 : timePrecision(windowSeconds) });
  }

  move(action, history, ready, windowSeconds, position = null) {
    const state = this.snapshot(history, ready, windowSeconds);
    if (!state.enabled) return false;
    if (action === "latest") this.rightEdgeTimestampUs = null;
    else if (action === "position") {
      const value = Number(position);
      if (!Number.isInteger(value) || value < 0 || value > 1000) return false;
      this.rightEdgeTimestampUs = state.earliest + (state.latest - state.earliest) * BigInt(value) / 1000n;
    } else if (action === "back" || action === "forward") {
      const step = BigInt(windowSeconds) * 500_000n;
      this.rightEdgeTimestampUs = clamp(state.rightEdge + (action === "back" ? -step : step), state.earliest, state.latest);
    } else return false;
    return true;
  }

  panTo(timestampUs, history, ready, windowSeconds) {
    const state = this.snapshot(history, ready, windowSeconds);
    if (!state.enabled || typeof timestampUs !== "bigint") return false;
    this.rightEdgeTimestampUs = clamp(timestampUs, state.earliest, state.latest);
    return true;
  }
}

export function historyReviewMarkup() {
  return `<section class="history-review" aria-label="停止後の波形確認 / Stopped history">
    <p data-history-status></p>
    <label class="history-position">表示する時間 / Review time
      <input type="range" min="0" max="1000" step="1" value="1000" data-history-position aria-label="表示する時間 / Review time" disabled>
    </label>
    <output data-history-window></output>
  </section>`;
}

export function updateHistoryReview(root, history, state) {
  const node = (selector) => root.querySelector(selector);
  const status = history.truncated
    ? `履歴上限: 古い測定値は削除されています (${history.count}/${history.capacity})。 / Earlier measurements were discarded.`
    : `保持した測定値: ${history.count}/${history.capacity} / Retained measurements`;
  node("[data-history-status]").textContent = `${status}${history.markersTruncated ? " 一部の境界注記は保持されていません。 / Some boundary labels were discarded." : ""}`;
  const slider = node("[data-history-position]");
  slider.disabled = !state.enabled || state.earliest === state.latest;
  slider.value = String(state.position);
  const label = `${state.domain.minimum.toFixed(state.precision)}–${state.domain.maximum.toFixed(state.precision)} s`;
  slider.setAttribute("aria-valuetext", label);
  node("[data-history-window]").textContent = state.enabled ? `表示中の時間 / Displayed time: ${label}` : "正常に測定を終了すると履歴を確認できます。 / Review after normal Stop.";
}
