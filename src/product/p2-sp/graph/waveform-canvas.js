import { formatYAxisTick, makeXAxisGrid, tickLabelX } from "./graph-core.js";

export function plotGeometry(rect) {
  const width = Math.max(1, Math.floor(rect.width)); const height = Math.max(1, Math.floor(rect.height));
  const pad = { left: 64, right: 34, top: 36, bottom: 34 };
  return { width, height, pad, pw: Math.max(1, width - pad.left - pad.right), ph: Math.max(1, height - pad.top - pad.bottom) };
}

const style = (canvas, role, fallback) => getComputedStyle(canvas).getPropertyValue(`--graph-${role}`).trim() || fallback;
export function formatMarkerLabel(marker) {
  const causes = []; if (marker.causes?.producerOverflow) causes.push("producer overflow"); if (marker.causes?.outputQueueDrop) causes.push("output drop"); if (marker.causes?.sourcePaused) causes.push("source paused"); if (marker.causes?.timebaseReset) causes.push("timebase reset");
  const base = marker.kind === "sequence-gap" ? `GAP ${marker.gap_samples}` : "SEGMENT";
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
    const { width, height, pad, pw, ph } = plotGeometry(this.canvas.getBoundingClientRect());
    const ratio = Math.max(1, globalThis.devicePixelRatio || 1); if (this.canvas.width !== width * ratio || this.canvas.height !== height * ratio) { this.canvas.width = width * ratio; this.canvas.height = height * ratio; }
    const c = this.context; c.setTransform(ratio, 0, 0, ratio, 0, 0); c.clearRect(0, 0, width, height); c.fillStyle = style(this.canvas, "background", "#ffffff"); c.fillRect(0, 0, width, height);
    c.font = "600 13px system-ui,sans-serif"; c.fillStyle = style(this.canvas, "foreground", "#18212f"); c.fillText(`${this.title} (${this.unit})`, 10, 17);
    c.font = "11px ui-monospace,monospace"; c.strokeStyle = style(this.canvas, "grid", "#8a8a8a"); c.lineWidth = 1;
    // One presentation origin drives the numeric tick values and the waveform
    // transform below, so the axis and the trace can never disagree. At the
    // LIVE and latched-Stop origin of 0 this is the previous geometry exactly.
    const origin = frame.origin ?? 0;
    const yOf = (y) => pad.top + ph - (y - origin) / (frame.scale * 9) * ph;
    for (let i = 0; i <= 9; i += 1) { const y = pad.top + ph * (9 - i) / 9; c.beginPath(); c.moveTo(pad.left, y); c.lineTo(pad.left + pw, y); c.stroke(); c.fillStyle = style(this.canvas, "foreground", "#18212f"); c.fillText(formatYAxisTick(origin + i * frame.scale, this.channel, frame.scale), 3, y + 4); }
    // The zero boundary marks the value 0, not the bottom of the plot. A
    // manual origin can move it inside the plot or off it entirely; it is
    // never redrawn at the viewport floor under a non-zero origin.
    const zeroY = yOf(0);
    if (zeroY >= pad.top && zeroY <= pad.top + ph) { c.strokeStyle = style(this.canvas, "zero-boundary", "#4a5666"); c.beginPath(); c.moveTo(pad.left, zeroY); c.lineTo(pad.left + pw, zeroY); c.stroke(); }
    const { ticks } = makeXAxisGrid(frame.domain, precision, pw);
    const labels = ticks.map(tick => {
      const x = pad.left + (tick.value - frame.domain.minimum) / (frame.domain.maximum - frame.domain.minimum) * pw;
      const textWidth = c.measureText(tick.label).width;
      return { ...tick, x, left: tickLabelX(x, textWidth, width), textWidth };
    });
    // Keep every 1 s label on narrow 10 s views. Two rows avoid collisions
    // as absolute elapsed labels grow, without changing other window layouts.
    const stagger = frame.domain.maximum - frame.domain.minimum === 10
      && labels.some((label, index) => index > 0 && label.left < labels[index - 1].left + labels[index - 1].textWidth + 2);
    c.strokeStyle = style(this.canvas, "grid", "#8a8a8a");
    for (const [index, tick] of labels.entries()) { c.beginPath(); c.moveTo(tick.x, pad.top); c.lineTo(tick.x, pad.top + ph); c.stroke(); c.fillText(tick.label, tick.left, height - 11 - (stagger && index % 2 === 0 ? 13 : 0)); }
    c.fillText("s", width - 12, height - 11);
    const xOf = (x) => pad.left + (x - frame.domain.minimum) / (frame.domain.maximum - frame.domain.minimum) * pw;
    c.save(); c.beginPath(); c.rect(pad.left, pad.top, pw, ph); c.clip(); c.strokeStyle = style(this.canvas, this.channel === "voltage" ? "voltage-accent" : "current-accent", "#005aff"); c.lineWidth = 1.7;
    for (const path of frame.paths) { c.beginPath(); c.moveTo(xOf(path[0].x), yOf(path[0].y)); for (const point of path.slice(1)) c.lineTo(xOf(point.x), yOf(point.y)); c.stroke(); }
    c.restore();
    c.fillStyle = style(this.canvas, "invalid", "#b3006b"); for (const entry of frame.invalid) { const x = xOf(entry.seconds); c.fillRect(x - 1, pad.top + ph - 5, 2, 5); }
    c.lineWidth = 1; c.font = "10px system-ui,sans-serif";
    for (const marker of markers) {
      if (typeof marker.timestamp_us !== "bigint" || typeof frame.originTimestampUs !== "bigint") continue;
      const seconds = Number(marker.timestamp_us - frame.originTimestampUs) / 1e6; if (seconds < frame.domain.minimum || seconds > frame.domain.maximum) continue;
      // A data gap and a segment/timebase boundary are different events, so they
      // differ by dash pattern and by label text, never by colour alone.
      const isGap = marker.kind === "sequence-gap";
      c.strokeStyle = isGap ? style(this.canvas, "gap", "#c58cff") : style(this.canvas, "segment", "#9eadbf"); c.fillStyle = c.strokeStyle;
      const x = xOf(seconds); c.setLineDash(isGap ? [3, 3] : [1, 4]); c.beginPath(); c.moveTo(x, pad.top); c.lineTo(x, pad.top + ph); c.stroke(); c.setLineDash([]);
      let label = formatMarkerLabel(marker); while (label.length > 1 && c.measureText(label).width > ph - 16) label = label.slice(0, -1);
      c.save(); c.translate(x + 3, pad.top + ph - 4); c.rotate(-Math.PI / 2); c.fillText(label, 0, 0); c.restore();
    }
    if (frame.measurementState === "no-valid-data") { c.fillStyle = style(this.canvas, "muted", "#4a5666"); c.fillText("データなし", pad.left, pad.top + 20); }
  }
}
