import { formatScaleReadout, formatYAxisTick, makeXAxisTicks } from "./graph-core.js";

const style = (canvas, role, fallback) => getComputedStyle(canvas).getPropertyValue(`--graph-${role}`).trim() || fallback;
export function formatMarkerLabel(marker) {
  const causes = []; if (marker.causes?.producerOverflow) causes.push("producer overflow"); if (marker.causes?.outputQueueDrop) causes.push("output drop"); if (marker.causes?.sourcePaused) causes.push("source paused"); if (marker.causes?.timebaseReset) causes.push("timebase reset");
  const base = marker.kind === "sequence-gap" ? `gap ${marker.gap_samples}` : "segment";
  return `${base}${causes.length ? `: ${causes.join(", ")}` : ""}`.slice(0, 56);
}
export class GraphWaveformCanvas {
  constructor(canvas, { channel, title, unit, onResize = null }) {
    if (!canvas?.getContext) throw new TypeError("a canvas element is required");
    this.canvas = canvas; this.context = canvas.getContext("2d"); this.channel = channel; this.title = title; this.unit = unit; this.onResize = onResize;
    this.observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => this.onResize?.()) : null;
    this.observer?.observe(canvas);
  }
  destroy() { this.observer?.disconnect(); }
  draw(frame, markers = [], precision = 0) {
    const rect = this.canvas.getBoundingClientRect(); const width = Math.max(1, Math.floor(rect.width)); const height = Math.max(1, Math.floor(rect.height));
    const ratio = Math.max(1, globalThis.devicePixelRatio || 1); if (this.canvas.width !== width * ratio || this.canvas.height !== height * ratio) { this.canvas.width = width * ratio; this.canvas.height = height * ratio; }
    const c = this.context; c.setTransform(ratio, 0, 0, ratio, 0, 0); c.clearRect(0, 0, width, height); c.fillStyle = style(this.canvas, "background", "#101821"); c.fillRect(0, 0, width, height);
    const pad = { left: 64, right: 34, top: 36, bottom: 34 }; const pw = Math.max(1, width - pad.left - pad.right); const ph = Math.max(1, height - pad.top - pad.bottom);
    c.font = "600 13px system-ui,sans-serif"; c.fillStyle = style(this.canvas, "foreground", "#dfeaff"); c.fillText(`${this.title} (${this.unit})`, 10, 17);
    const readout = formatScaleReadout(frame.scale, this.channel); c.textAlign = "right"; c.fillText(readout, width - 10, 17); c.textAlign = "left";
    c.font = "11px ui-monospace,monospace"; c.strokeStyle = style(this.canvas, "grid", "#405064"); c.lineWidth = 1;
    for (let i = 0; i <= 9; i += 1) { const y = pad.top + ph * (9 - i) / 9; c.beginPath(); c.moveTo(pad.left, y); c.lineTo(pad.left + pw, y); c.stroke(); c.fillStyle = style(this.canvas, "foreground", "#dfeaff"); c.fillText(formatYAxisTick(i * frame.scale, this.channel, frame.scale), 3, y + 4); }
    c.strokeStyle = style(this.canvas, "zero-boundary", "#8491a5"); c.beginPath(); c.moveTo(pad.left, pad.top + ph); c.lineTo(pad.left + pw, pad.top + ph); c.stroke();
    const ticks = makeXAxisTicks(frame.domain, precision, pw);
    c.strokeStyle = style(this.canvas, "grid", "#405064");
    for (const tick of ticks) { const x = pad.left + (tick.value - frame.domain.minimum) / (frame.domain.maximum - frame.domain.minimum) * pw; c.beginPath(); c.moveTo(x, pad.top); c.lineTo(x, pad.top + ph); c.stroke(); c.fillText(tick.label, Math.max(2, Math.min(x - 12, pad.left + pw - 24)), height - 11); }
    c.fillText("s", width - 12, height - 11);
    const xOf = (x) => pad.left + (x - frame.domain.minimum) / (frame.domain.maximum - frame.domain.minimum) * pw; const yOf = (y) => pad.top + ph - y / (frame.scale * 9) * ph;
    c.save(); c.beginPath(); c.rect(pad.left, pad.top, pw, ph); c.clip(); c.strokeStyle = style(this.canvas, this.channel === "voltage" ? "voltage-accent" : "current-accent", "#6dd6ff"); c.lineWidth = 1.7;
    for (const path of frame.paths) { c.beginPath(); c.moveTo(xOf(path[0].x), yOf(path[0].y)); for (const point of path.slice(1)) c.lineTo(xOf(point.x), yOf(point.y)); c.stroke(); }
    c.restore();
    c.fillStyle = style(this.canvas, "invalid", "#d67eff"); for (const entry of frame.invalid) { const x = xOf(entry.seconds); c.fillRect(x - 1, pad.top + ph - 5, 2, 5); }
    c.strokeStyle = style(this.canvas, "gap", "#f6c45d"); c.fillStyle = c.strokeStyle; c.lineWidth = 1; c.font = "10px system-ui,sans-serif";
    for (const marker of markers) {
      if (typeof marker.timestamp_us !== "bigint" || typeof frame.originTimestampUs !== "bigint") continue;
      const seconds = Number(marker.timestamp_us - frame.originTimestampUs) / 1e6; if (seconds < frame.domain.minimum || seconds > frame.domain.maximum) continue;
      const x = xOf(seconds); c.setLineDash([3, 3]); c.beginPath(); c.moveTo(x, pad.top); c.lineTo(x, pad.top + ph); c.stroke(); c.setLineDash([]);
      let label = formatMarkerLabel(marker); while (label.length > 1 && c.measureText(label).width > ph - 16) label = label.slice(0, -1);
      c.save(); c.translate(x + 3, pad.top + ph - 4); c.rotate(-Math.PI / 2); c.fillText(label, 0, 0); c.restore();
    }
    if (frame.measurementState === "no-valid-data") { c.fillStyle = style(this.canvas, "muted", "#9eadbf"); c.fillText("データなし", pad.left, pad.top + 20); }
  }
}
