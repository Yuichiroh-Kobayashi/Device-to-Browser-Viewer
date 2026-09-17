import { CURRENT_SCALES, DISPLAY_WINDOWS, VOLTAGE_SCALES } from "../graph/graph-core.js";
import { plotGeometry } from "../graph/waveform-canvas.js";

export const PINCH_AXIS_LOCK_THRESHOLD = 0.04;
export const PINCH_SEPARATION_FLOOR = 0.1;
export const PINCH_HYSTERESIS = 1.08;

/**
 * The one normalized axis-lock primitive, shared by the two-pointer pinch and
 * the one-pointer drag. Both compare how far a pair of points has moved apart
 * relative to plot width and height, so neither axis wins merely because the
 * plot is wider than it is tall. Below the threshold, and on an exact tie,
 * no axis is chosen yet and the gesture waits.
 */
export function pinchAxis(start, current, width, height) {
  const x = Math.abs(current.x - start.x) / Math.max(1, width);
  const y = Math.abs(current.y - start.y) / Math.max(1, height);
  if (Math.max(x, y) < PINCH_AXIS_LOCK_THRESHOLD || Math.abs(x - y) < 1e-9) return null;
  return x > y ? "x" : "y";
}

// Gesture-start scale / ratio is the continuous target, never a frame scale.
// Geometric ladder midpoints with an 8% dead band resist boundary jitter.
export function quantizePinch(scales, startIndex, ratio, currentIndex = startIndex) {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return currentIndex;
  const target = scales[startIndex] / ratio;
  let index = currentIndex;
  while (index > 0 && target < Math.sqrt(scales[index] * scales[index - 1]) / PINCH_HYSTERESIS) index--;
  while (index < scales.length - 1 && target > Math.sqrt(scales[index] * scales[index + 1]) * PINCH_HYSTERESIS) index++;
  return index;
}

const separation = (points) => {
  const [a, b] = [...points.values()];
  return { x: Math.abs(a.x - b.x), y: Math.abs(a.y - b.y) };
};

/**
 * Where the two-pointer midpoint sits inside the plot, as a fraction measured
 * up from the plot floor and clamped to the plot itself. Combined with the
 * gesture-start origin and scale it fixes one measured value under the
 * fingers; each quantized scale step then re-derives the origin from that
 * same value, so a Y pinch zooms about the midpoint instead of about the
 * bottom edge. Both inputs are gesture-start values, never frame values, so
 * repeated moves inside one gesture cannot accumulate drift.
 */
const anchorFraction = (points, rect, pad, ph) => {
  const [a, b] = [...points.values()];
  const floor = (rect.top ?? 0) + pad.top + ph;
  return Math.min(1, Math.max(0, (floor - (a.y + b.y) / 2) / ph));
};

/** One graph surface, bounded to two pointers. Only presentation callbacks. */
export class GraphInteractionController {
  constructor(surface, { channel, getState, changeWindow, changeScale, panTo, panYOrigin }) {
    Object.assign(this, { surface, channel, getState, changeWindow, changeScale, panTo, panYOrigin });
    this.pointers = new Map(); this.mode = null; this.axis = null; this.baseline = null;
    surface.onpointerdown = (event) => this.down(event);
    surface.onpointermove = (event) => this.move(event);
    surface.onpointerup = (event) => this.end(event);
    surface.onpointercancel = (event) => this.end(event);
    surface.onlostpointercapture = (event) => this.end(event);
    this.syncOwnership();
  }
  syncOwnership() {
    const enabled = this.getState().review.enabled;
    if (!enabled) this.cancel();
    this.surface.setAttribute("data-graph-interaction", enabled ? "graph" : "browser");
  }
  down(event) {
    const state = this.getState();
    // Browser gestures may deliver moves before pointercancel. Never acquire
    // an application pointer/baseline/capture outside stopped review.
    if (!state.review.enabled) { this.cancel(); return; }
    if (event.button !== 0 || this.pointers.size >= 2 || this.pointers.has(event.pointerId)) return;
    // After a pinch loses a finger, wait for every original pointer to leave.
    if (this.mode === "pinch" && this.pointers.size < 2) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.surface.setPointerCapture?.(event.pointerId);
    const rect = this.surface.getBoundingClientRect();
    const { pw, ph, pad } = plotGeometry(rect);
    if (this.pointers.size === 1) {
      this.mode = "pan";
      this.axis = null;
      this.baseline = { x: event.clientX, y: event.clientY, rightEdge: state.review.rightEdge, window: state.windowSeconds,
        yOrigin: state.yOrigin, yScale: state.yScale, pw, ph };
    } else {
      this.mode = "pinch";
      this.axis = null;
      const scales = this.channel === "voltage" ? VOLTAGE_SCALES : CURRENT_SCALES;
      const fraction = anchorFraction(this.pointers, rect, pad, ph);
      this.baseline = { separation: separation(this.pointers), pw, ph,
        xIndex: DISPLAY_WINDOWS.indexOf(state.windowSeconds), yIndex: scales.indexOf(state.yScale),
        yAnchorFraction: fraction, yAnchorValue: state.yOrigin + fraction * 9 * state.yScale };
    }
  }
  move(event) {
    const state = this.getState();
    if (!state.review.enabled) { this.cancel(); return; }
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const start = this.baseline;
    if (this.mode === "pinch") {
      if (this.pointers.size !== 2) return;
      const current = separation(this.pointers);
      this.axis ??= pinchAxis(start.separation, current, start.pw, start.ph);
      if (!this.axis) return;
      const dimension = this.axis === "x" ? start.pw : start.ph;
      const floor = dimension * PINCH_SEPARATION_FLOOR;
      const ratio = Math.max(floor, current[this.axis]) / Math.max(floor, start.separation[this.axis]);
      const scales = this.axis === "x" ? DISPLAY_WINDOWS : this.channel === "voltage" ? VOLTAGE_SCALES : CURRENT_SCALES;
      const initial = this.axis === "x" ? start.xIndex : start.yIndex;
      const previous = scales.indexOf(this.axis === "x" ? state.windowSeconds : state.yScale);
      const target = scales[quantizePinch(scales, initial, ratio, previous)];
      if (this.axis === "x") { this.changeWindow(target); return; }
      this.changeScale(this.channel, target);
      const origin = start.yAnchorValue - start.yAnchorFraction * 9 * target;
      if (Number.isFinite(origin)) this.panYOrigin?.(this.channel, origin);
    } else {
      // One pointer serves both review axes. The axis is chosen once, from the
      // same normalized dominance rule the pinch uses, and then stays locked
      // for the rest of the gesture even if the drag reverses direction.
      this.axis ??= pinchAxis(start, { x: event.clientX, y: event.clientY }, start.pw, start.ph);
      if (!this.axis) return;
      if (this.axis === "x") {
        if (typeof start.rightEdge !== "bigint") return;
        const delta = (event.clientX - start.x) / start.pw * start.window * 1e6;
        if (Number.isFinite(delta)) this.panTo(start.rightEdge - BigInt(Math.round(delta)));
        return;
      }
      // Dragging down raises the origin, so the waveform follows the pointer.
      // Both values come from the gesture baseline, never from a rendered
      // frame, so panning moves the origin without ever changing the scale.
      const origin = start.yOrigin + (event.clientY - start.y) / start.ph * start.yScale * 9;
      if (Number.isFinite(origin)) this.panYOrigin?.(this.channel, origin);
    }
  }
  end(event) {
    if (!this.pointers.delete(event.pointerId)) return;
    if (this.surface.hasPointerCapture?.(event.pointerId)) this.surface.releasePointerCapture(event.pointerId);
    if (!this.pointers.size) { this.mode = null; this.axis = null; this.baseline = null; }
  }
  cancel() {
    const ids = [...this.pointers.keys()];
    this.pointers.clear(); this.mode = null; this.axis = null; this.baseline = null;
    for (const id of ids) if (this.surface.hasPointerCapture?.(id)) this.surface.releasePointerCapture(id);
  }
  destroy() {
    this.cancel();
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]) this.surface[`on${type}`] = null;
  }
}
