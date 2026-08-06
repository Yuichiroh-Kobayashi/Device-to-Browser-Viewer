import { deviceTimeDomain, formatValue, mapLinear, relativeDeviceSeconds, robustFiniteScale } from "./scale.js";

function color(canvas, variable, fallback) {
  return getComputedStyle(canvas).getPropertyValue(variable).trim() || fallback;
}

function validValue(record, channel) {
  const value = channel === "voltage" ? record.voltage_V : record.current_A;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function channelSegment(record, channel) {
  return channel === "voltage" ? record.voltage_segment_id : record.current_segment_id;
}

export class WaveformCanvas {
  constructor(canvas, { channel, unit, title, onResize = null }) {
    if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError("a canvas element is required");
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.channel = channel;
    this.unit = unit;
    this.title = title;
    this.onResize = typeof onResize === "function" ? onResize : null;
    this._resizeObserver = new ResizeObserver(() => this.onResize?.());
    this._resizeObserver.observe(canvas);
  }

  destroy() { this._resizeObserver.disconnect(); }

  draw(records, markers) {
    const context = this.context;
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const ratio = Math.max(1, globalThis.devicePixelRatio || 1);
    if (this.canvas.width !== width * ratio || this.canvas.height !== height * ratio) {
      this.canvas.width = width * ratio;
      this.canvas.height = height * ratio;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const background = color(this.canvas, "--canvas-bg", "#101821");
    const foreground = color(this.canvas, "--canvas-fg", "#dfeaff");
    const grid = color(this.canvas, "--canvas-grid", "#405064");
    const accent = color(this.canvas, "--canvas-accent", this.channel === "voltage" ? "#6dd6ff" : "#87f4b4");
    const markerColor = color(this.canvas, "--canvas-marker", "#f6c45d");
    const invalidColor = color(this.canvas, "--canvas-invalid", "#d67eff");
    context.clearRect(0, 0, width, height);
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);

    const padding = { left: 58, right: 14, top: 25, bottom: 31 };
    const plotWidth = Math.max(1, width - padding.left - padding.right);
    const plotHeight = Math.max(1, height - padding.top - padding.bottom);
    context.fillStyle = foreground;
    context.font = "600 13px system-ui, sans-serif";
    context.fillText(`${this.title} (${this.unit})`, 10, 16);

    const domain = deviceTimeDomain(records);
    const scale = robustFiniteScale(records.map((record) => validValue(record, this.channel)));
    if (!domain || !scale) {
      context.fillStyle = color(this.canvas, "--canvas-muted", "#9eadbf");
      context.font = "13px system-ui, sans-serif";
      context.fillText("No finite valid device measurements in window", padding.left, padding.top + 28);
      return;
    }
    const xOf = (timestampUs) => {
      const seconds = relativeDeviceSeconds(timestampUs, domain.originTimestampUs);
      return seconds === null ? null : mapLinear(seconds, domain.minimumSeconds, domain.maximumSeconds, padding.left, padding.left + plotWidth);
    };
    const yOf = (value) => mapLinear(value, scale.minimum, scale.maximum, padding.top + plotHeight, padding.top);

    context.strokeStyle = grid;
    context.lineWidth = 1;
    context.setLineDash([]);
    for (let index = 0; index <= 4; index += 1) {
      const y = padding.top + (plotHeight * index) / 4;
      context.beginPath();
      context.moveTo(padding.left, y);
      context.lineTo(padding.left + plotWidth, y);
      context.stroke();
      const label = scale.maximum - (scale.span * index) / 4;
      context.fillStyle = foreground;
      context.font = "11px ui-monospace, SFMono-Regular, monospace";
      context.fillText(formatValue(label), 4, y + 4);
    }
    for (let index = 0; index <= 5; index += 1) {
      const x = padding.left + (plotWidth * index) / 5;
      context.beginPath();
      context.moveTo(x, padding.top);
      context.lineTo(x, padding.top + plotHeight);
      context.stroke();
      const seconds = domain.minimumSeconds + ((domain.maximumSeconds - domain.minimumSeconds) * index) / 5;
      context.fillStyle = foreground;
      context.fillText(`${formatValue(seconds)} s`, Math.max(2, x - 15), height - 10);
    }
    if (scale.includesZero) {
      const zero = yOf(0);
      if (zero !== null && Number.isFinite(zero)) {
        context.strokeStyle = color(this.canvas, "--canvas-zero", "#8491a5");
        context.setLineDash([4, 3]);
        context.beginPath();
        context.moveTo(padding.left, zero);
        context.lineTo(padding.left + plotWidth, zero);
        context.stroke();
        context.setLineDash([]);
      }
    }

    // Invalidity is a non-measurement annotation at the plot edge. It never gets
    // a Y value and paths are deliberately broken before/after it.
    context.fillStyle = invalidColor;
    for (const record of records) {
      if (validValue(record, this.channel) !== null) continue;
      const x = xOf(record.timestamp_us);
      if (x !== null && Number.isFinite(x)) context.fillRect(x - 1, padding.top + plotHeight - 5, 2, 5);
    }

    context.strokeStyle = accent;
    context.lineWidth = 1.7;
    context.beginPath();
    let openPath = false;
    let previous = null;
    for (const record of records) {
      const value = validValue(record, this.channel);
      if (value === null) {
        openPath = false;
        previous = record;
        continue;
      }
      const x = xOf(record.timestamp_us);
      const y = yOf(value);
      if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) {
        openPath = false;
        previous = record;
        continue;
      }
      const breakPath = !openPath || !previous || previous.stream_id !== record.stream_id ||
        previous.segment_id !== record.segment_id || channelSegment(previous, this.channel) !== channelSegment(record, this.channel);
      if (breakPath) context.moveTo(x, y);
      else context.lineTo(x, y);
      openPath = true;
      previous = record;
    }
    context.stroke();

    context.strokeStyle = markerColor;
    context.fillStyle = markerColor;
    context.lineWidth = 1;
    context.font = "10px system-ui, sans-serif";
    for (const marker of markers) {
      const x = xOf(marker.timestamp_us);
      if (x === null || x < padding.left || x > padding.left + plotWidth) continue;
      context.setLineDash([3, 3]);
      context.beginPath();
      context.moveTo(x, padding.top);
      context.lineTo(x, padding.top + plotHeight);
      context.stroke();
      context.setLineDash([]);
      const causes = [];
      if (marker.causes?.producerOverflow) causes.push("producer overflow");
      if (marker.causes?.outputQueueDrop) causes.push("output drop");
      if (marker.causes?.sourcePaused) causes.push("source paused");
      if (marker.causes?.timebaseReset) causes.push("timebase reset");
      const label = marker.kind === "sequence-gap"
        ? `gap ${marker.gap_samples.toString()}${causes.length ? `: ${causes.join(", ")}` : ""}`
        : "segment";
      context.save();
      context.translate(x + 3, padding.top + 10);
      context.rotate(-Math.PI / 2);
      context.fillText(label.slice(0, 56), 0, 0);
      context.restore();
    }
  }
}
