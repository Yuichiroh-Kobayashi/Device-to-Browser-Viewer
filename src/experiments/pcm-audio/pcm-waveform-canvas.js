import { deviceTimeDomain, formatValue, mapLinear, relativeDeviceSeconds } from "../../render/scale.js";

/**
 * Canvas 2D pcm-audio amplitude-vs-sample-time renderer. New file; does not
 * import or modify ../../render/waveform-canvas.js (which is hard-coded to
 * V/I's voltage_V/current_A fields). It reuses the profile-neutral time-scale
 * helpers from ../../render/scale.js: relativeDeviceSeconds and mapLinear
 * directly, and deviceTimeDomain by feeding it per-sample pseudo-records
 * (each carrying only the generic `timestamp_us` BigInt field it reads).
 *
 * Y-axis is normalized to a FIXED [-1.05, 1.05] full-scale range (not
 * data-adaptive): dividing a stored Int16 sample by 32768 for display is a
 * display-scale transform, never a mutation of the retained sample value,
 * and a fixed range reads like an oscilloscope trace rather than
 * auto-zooming into near-silence. (scale.js's robustFiniteScale was
 * deliberately not reused here: it is a data-adaptive V/I scale, not a
 * fixed audio full-scale range.)
 */

const SAMPLE_PEAK = 32768;
const Y_RANGE = 1.05;

export const PCM_WINDOW_CHOICES_MS = Object.freeze([10, 20, 50, 100]);
export const DEFAULT_PCM_WINDOW_MS = 20;

function color(canvas, variable, fallback) {
  return getComputedStyle(canvas).getPropertyValue(variable).trim() || fallback;
}

/** Exact per-sample timestamp within a frame, BigInt-only (see docs/profiles/pcm-audio-v0.1.md §3). */
function sampleTimestampUs(frame, sampleIndex, sampleRate) {
  const numerator = BigInt(sampleRate?.numerator ?? 16000);
  const denominator = BigInt(sampleRate?.denominator ?? 1);
  const deltaUs = (BigInt(sampleIndex) * denominator * 1_000_000n) / numerator;
  return frame.timestamp_us + deltaUs;
}

/**
 * Flattens the frames within `windowUs` of the latest sample into an
 * ordered per-sample list. Samples are windowed (trimmed), never
 * interpolated or resampled; a frame boundary that is not contiguous with
 * the previous frame's segment_id/epoch_id/stream_id is marked `breakBefore`
 * so the caller never draws a bridging line across a gap, a new stream, or a
 * TIMEBASE_RESET epoch.
 */
export function flattenWindow(frames, { windowMs = DEFAULT_PCM_WINDOW_MS, sampleRate } = {}) {
  if (!Array.isArray(frames) || frames.length === 0) return [];
  const lastFrame = frames.at(-1);
  const latestUs = sampleTimestampUs(lastFrame, lastFrame.sample_count - 1, sampleRate);
  const windowUs = BigInt(Math.max(1, Math.round(windowMs))) * 1000n;
  const cutoffUs = latestUs > windowUs ? latestUs - windowUs : 0n;

  const points = [];
  let previousFrame = null;
  for (const frame of frames) {
    const frameEndUs = sampleTimestampUs(frame, frame.sample_count - 1, sampleRate);
    if (frameEndUs < cutoffUs) { previousFrame = frame; continue; }
    const contiguous = previousFrame !== null &&
      previousFrame.stream_id === frame.stream_id &&
      previousFrame.epoch_id === frame.epoch_id &&
      previousFrame.segment_id === frame.segment_id;
    for (let index = 0; index < frame.sample_count; index += 1) {
      const timestampUs = sampleTimestampUs(frame, index, sampleRate);
      if (timestampUs < cutoffUs) continue;
      points.push({
        timestamp_us: timestampUs,
        value: frame.samples[index],
        breakBefore: index === 0 ? !contiguous : false,
      });
    }
    previousFrame = frame;
  }
  return points;
}

/** Peak (0..1) and RMS (0..1) of the rendered window, plus a labeled zero-crossing frequency estimate. Informational only; never feeds the time axis. */
export function estimateWindowStats(points, { sampleRate } = {}) {
  if (points.length === 0) return Object.freeze({ peak: null, rms: null, estimatedFrequencyHz: null });
  let peak = 0;
  let sumSquares = 0;
  let crossings = 0;
  for (let index = 0; index < points.length; index += 1) {
    const normalized = points[index].value / SAMPLE_PEAK;
    peak = Math.max(peak, Math.abs(normalized));
    sumSquares += normalized * normalized;
    if (index > 0 && !points[index].breakBefore) {
      const previous = points[index - 1].value;
      if ((previous < 0 && points[index].value >= 0) || (previous >= 0 && points[index].value < 0)) crossings += 1;
    }
  }
  const rms = Math.sqrt(sumSquares / points.length);
  const spanUs = Number(points.at(-1).timestamp_us - points[0].timestamp_us);
  const estimatedFrequencyHz = spanUs > 0 ? (crossings / 2) / (spanUs / 1_000_000) : null;
  return Object.freeze({ peak, rms, estimatedFrequencyHz });
}

export class PcmWaveformCanvas {
  constructor(canvas, { title = "PCM amplitude", onResize = null } = {}) {
    if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError("a canvas element is required");
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.title = title;
    this.onResize = typeof onResize === "function" ? onResize : null;
    this._resizeObserver = new ResizeObserver(() => this.onResize?.());
    this._resizeObserver.observe(canvas);
  }

  destroy() { this._resizeObserver.disconnect(); }

  draw(frames, markers, { windowMs = DEFAULT_PCM_WINDOW_MS, sampleRate } = {}) {
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
    const background = color(this.canvas, "--canvas-bg", "#0e1721");
    const foreground = color(this.canvas, "--canvas-fg", "#dfeaff");
    const grid = color(this.canvas, "--canvas-grid", "#35485e");
    const accent = color(this.canvas, "--canvas-accent", "#6dd6ff");
    const markerColor = color(this.canvas, "--canvas-marker", "#f7c35b");
    const zeroColor = color(this.canvas, "--canvas-zero", "#8394aa");
    context.clearRect(0, 0, width, height);
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);

    const padding = { left: 58, right: 14, top: 25, bottom: 31 };
    const plotWidth = Math.max(1, width - padding.left - padding.right);
    const plotHeight = Math.max(1, height - padding.top - padding.bottom);
    context.fillStyle = foreground;
    context.font = "600 13px system-ui, sans-serif";
    context.fillText(`${this.title} (${windowMs} ms window)`, 10, 16);

    const points = flattenWindow(frames, { windowMs, sampleRate });
    if (points.length === 0) {
      context.fillStyle = color(this.canvas, "--canvas-muted", "#9eadbf");
      context.font = "13px system-ui, sans-serif";
      context.fillText("No pcm-audio samples in window", padding.left, padding.top + 28);
      return;
    }
    const domain = deviceTimeDomain(points);
    const xOf = (timestampUs) => {
      const seconds = relativeDeviceSeconds(timestampUs, domain.originTimestampUs);
      return seconds === null ? null : mapLinear(seconds, domain.minimumSeconds, domain.maximumSeconds, padding.left, padding.left + plotWidth);
    };
    const yOf = (normalized) => mapLinear(normalized, -Y_RANGE, Y_RANGE, padding.top + plotHeight, padding.top);

    context.strokeStyle = grid;
    context.lineWidth = 1;
    for (let index = 0; index <= 4; index += 1) {
      const y = padding.top + (plotHeight * index) / 4;
      context.beginPath();
      context.moveTo(padding.left, y);
      context.lineTo(padding.left + plotWidth, y);
      context.stroke();
      const label = Y_RANGE - (2 * Y_RANGE * index) / 4;
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
      const ms = (domain.minimumSeconds + ((domain.maximumSeconds - domain.minimumSeconds) * index) / 5) * 1000;
      context.fillStyle = foreground;
      context.fillText(`${formatValue(ms)} ms`, Math.max(2, x - 15), height - 10);
    }
    const zero = yOf(0);
    context.strokeStyle = zeroColor;
    context.setLineDash([4, 3]);
    context.beginPath();
    context.moveTo(padding.left, zero);
    context.lineTo(padding.left + plotWidth, zero);
    context.stroke();
    context.setLineDash([]);

    context.strokeStyle = accent;
    context.lineWidth = 1.4;
    context.beginPath();
    let openPath = false;
    for (const point of points) {
      const x = xOf(point.timestamp_us);
      const y = yOf(point.value / SAMPLE_PEAK);
      if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) { openPath = false; continue; }
      if (!openPath || point.breakBefore) context.moveTo(x, y);
      else context.lineTo(x, y);
      openPath = true;
    }
    context.stroke();

    if (Array.isArray(markers)) {
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
}
