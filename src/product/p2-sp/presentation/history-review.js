import { makeTimeDomain, timePrecision } from "../graph/graph-core.js";

const clamp = (value, minimum, maximum) => value < minimum ? minimum : value > maximum ? maximum : value;

/** Presentation cursor only. Inputs are snapshots, with no mutation authority. */
export class HistoryReviewController {
  constructor() { this.epoch = null; this.rightEdgeTimestampUs = null; }

  snapshot(history, ready, windowSeconds) {
    if (this.epoch !== history.epoch || !ready) this.rightEdgeTimestampUs = null;
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
      originTimestampUs: history.originTimestampUs, precision: timePrecision(windowSeconds) });
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
}

export function historyReviewMarkup() {
  return `<section class="history-review" aria-label="停止後の波形確認 / Stopped history">
    <p data-history-status></p>
    <div class="history-actions">
      <button type="button" data-history-back disabled>前へ / Back</button>
      <button type="button" data-history-forward disabled>次へ / Forward</button>
      <button type="button" data-history-latest disabled>最新 / Latest</button>
    </div>
    <label class="history-position">表示する時間 / Review time
      <input type="range" min="0" max="1000" step="1" value="1000" data-history-position aria-label="表示する時間 / Review time" disabled>
    </label>
    <output data-history-window></output>
    <p class="quality" data-history-values hidden>数値欄は停止時の値です。 / Numeric values remain at Stop.</p>
  </section>`;
}

export function updateHistoryReview(root, history, state) {
  const node = (selector) => root.querySelector(selector);
  const status = history.truncated
    ? `履歴上限: 古い測定値は削除されています (${history.count}/${history.capacity})。 / Earlier measurements were discarded.`
    : `保持した測定値: ${history.count}/${history.capacity} / Retained measurements`;
  node("[data-history-status]").textContent = `${status}${history.markersTruncated ? " 一部の境界注記は保持されていません。 / Some boundary labels were discarded." : ""}`;
  node("[data-history-back]").disabled = !state.canBack;
  node("[data-history-forward]").disabled = !state.canForward;
  node("[data-history-latest]").disabled = !state.canForward;
  const slider = node("[data-history-position]");
  slider.disabled = !state.enabled || state.earliest === state.latest;
  slider.value = String(state.position);
  const label = `${state.domain.minimum.toFixed(state.precision)}–${state.domain.maximum.toFixed(state.precision)} s`;
  slider.setAttribute("aria-valuetext", label);
  node("[data-history-window]").textContent = state.enabled ? `停止後の表示 / Review: ${label}` : "正常に測定を終了すると履歴を確認できます。 / Review after normal Stop.";
  node("[data-history-values]").hidden = !state.enabled;
}
