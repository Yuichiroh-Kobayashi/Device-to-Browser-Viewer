export const VOLTAGE_SCALES = Object.freeze([0.1, 0.2, 0.5, 1, 2, 5]);
export const CURRENT_SCALES = Object.freeze([0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1]);
export const DISPLAY_WINDOWS = Object.freeze([1, 2, 5, 10, 30, 60]);

const valueOf = (record, channel) => channel === "voltage" ? record?.voltage_V : record?.current_A;
const pieceOf = (record, channel) => channel === "voltage" ? record?.voltage_segment_id : record?.current_segment_id;
const finiteValue = (record, channel) => {
  const value = valueOf(record, channel);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

export function updateStagedScale(scales, scaleIndex, values) {
  if (!Array.isArray(values)) throw new TypeError("values must be an array");
  if (!Number.isInteger(scaleIndex) || scaleIndex < 0 || scaleIndex >= scales.length) throw new RangeError("invalid scale index");
  const valid = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  const eligible = valid.filter((value) => value >= 0);
  if (!eligible.length) return Object.freeze({ scaleIndex, transition: valid.length ? "held-no-nonnegative" : "held-no-valid", positivePeak: null });
  const positivePeak = Math.max(...eligible);
  let next = scaleIndex;
  while (next + 1 < scales.length && positivePeak >= 8 * scales[next]) next += 1;
  let transition = next > scaleIndex ? "expanded" : "held";
  if (next === scaleIndex && next > 0 && positivePeak < 4 * scales[next - 1]) {
    next -= 1;
    transition = "shrunk";
  }
  return Object.freeze({ scaleIndex: next, transition, positivePeak });
}

/**
 * Y presentation states, one per Graph channel (Issue #25). Origin and scale
 * are presentation only: no state here reaches a measurement record, retained
 * history, CSV, the SessionAdapter, the WebSocket, or the D2B wire.
 *
 *   LIVE_AUTO_ZERO        origin 0, existing live staged autoscale, no manual Y
 *   STOPPED_LATCHED_ZERO  origin 0, last live frame scale, X review never moves Y
 *   STOPPED_AUTO_ZERO     origin 0, scale re-derived from the visible X viewport
 *   STOPPED_MANUAL_FREE   origin and scale user-controlled, X review never moves Y
 */
export const Y_PRESENTATION_STATES = Object.freeze(["LIVE_AUTO_ZERO", "STOPPED_LATCHED_ZERO", "STOPPED_AUTO_ZERO", "STOPPED_MANUAL_FREE"]);

/**
 * Stopped Y Auto scale for one channel. This is not a second autoscale
 * algorithm: it is the existing positive-domain updateStagedScale ladder
 * authority, evaluated from the ladder minimum.
 *
 * When a qualifying non-negative peak exists in the visible viewport, the
 * index is derived from those values alone and does not depend on the index
 * the viewer arrived from. That is why it is evaluated from the minimum:
 * iterating the staged rule from the current index is not confluent, so the
 * same records would settle on different indices depending on the path taken
 * and "Auto" would not be reproducible.
 *
 * When no qualifying non-negative peak exists -- an empty viewport, or one
 * holding only negative current -- there is nothing to fit, and the existing
 * stopped scale is retained rather than collapsed to the ladder minimum. In
 * that case the result follows the retained scale, not the viewport. No
 * autoscale over negative magnitudes is introduced.
 */
export function viewportAutoScaleIndex(scales, currentIndex, values) {
  const evaluation = updateStagedScale(scales, 0, values);
  return evaluation.positivePeak === null ? currentIndex : evaluation.scaleIndex;
}

export function makeTimeDomain(originTimestampUs, latestTimestampUs, windowSeconds) {
  if (!DISPLAY_WINDOWS.includes(windowSeconds)) throw new RangeError("unsupported display window");
  if (typeof originTimestampUs !== "bigint" || typeof latestTimestampUs !== "bigint") return Object.freeze({ minimum: 0, maximum: windowSeconds });
  const elapsed = Number(latestTimestampUs - originTimestampUs) / 1e6;
  const maximum = elapsed <= windowSeconds ? windowSeconds : elapsed;
  return Object.freeze({ minimum: elapsed <= windowSeconds ? 0 : elapsed - windowSeconds, maximum });
}

export function timePrecision(windowSeconds) {
  if (!DISPLAY_WINDOWS.includes(windowSeconds)) throw new RangeError("unsupported display window");
  return windowSeconds < 10 ? 1 : 0;
}

export function makeXAxisGrid(domain, precision, plotWidthCss) {
  if (!domain || !Number.isFinite(domain.minimum) || !Number.isFinite(domain.maximum) || domain.maximum <= domain.minimum) throw new TypeError("invalid domain");
  const capacity = Math.max(2, Math.floor(plotWidthCss / (precision ? 58 : 46)));
  const ladder = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 20, 30, 60, 120];
  const width = domain.maximum - domain.minimum;
  const step = width === 10 ? 1 : ladder.find((candidate) => Math.floor(width / candidate) + 1 <= capacity) ?? ladder.at(-1);
  if (width === 10) precision = 0;
  const first = Math.ceil((domain.minimum - 1e-12) / step) * step;
  const ticks = [];
  for (let value = first; value <= domain.maximum + 1e-10; value += step) {
    const normalized = Math.abs(value) < 1e-12 ? 0 : Number(value.toFixed(10));
    ticks.push(Object.freeze({ value: normalized, label: normalized.toFixed(precision) }));
  }
  return Object.freeze({ step, ticks: Object.freeze(ticks) });
}

export function makeXAxisTicks(domain, precision, plotWidthCss) {
  return makeXAxisGrid(domain, precision, plotWidthCss).ticks;
}

/**
 * X-axis tick label anchor. Every tick -- including the final one, which can
 * sit exactly on the plot's right edge -- follows the same rule: the label
 * starts 12px left of its grid line. The right-hand guard only engages when
 * the label's own measured width would actually run into the reserved "s"
 * unit zone (drawn at canvasWidth - 12). The display WINDOW uses the discrete
 * DISPLAY_WINDOWS ladder, but the ticks inside it are absolute elapsed device
 * time, not clamped to that window: once the viewport has been sliding for a
 * while, a 60s-wide window can show ticks like 940..1000, so labels are not
 * bounded to 1-2 digits. The guard is not a fixed-width guess keyed off the
 * plot width alone -- it re-derives the safe bound from the real label and
 * the real reserved zone, so it clamps only when a label (of whatever width)
 * would actually collide, and never spuriously clamps one that would not.
 */
export function tickLabelX(x, labelWidth, canvasWidth) {
  const rightBound = canvasWidth - 12 - labelWidth - 4;
  return Math.max(2, Math.min(x - 12, rightBound));
}

const normalizedFixed = (value, digits) => {
  const text = value.toFixed(digits);
  return /^-0(?:\.0+)?$/.test(text) ? (0).toFixed(digits) : text;
};

export function formatStudentValue(value, channel) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  if (channel === "voltage") {
    if (magnitude >= 1) return `${normalizedFixed(value, 2)} V`;
    if (magnitude >= 0.001) return `${normalizedFixed(value * 1e3, 1)} mV`;
    return `${normalizedFixed(value * 1e6, 1)} µV`;
  }
  if (channel !== "current") throw new TypeError("channel must be voltage or current");
  if (magnitude >= 1) return `${normalizedFixed(value, 3)} A`;
  if (magnitude >= 0.001) return `${normalizedFixed(value * 1e3, 1)} mA`;
  if (value === 0) return "0 A";
  return `${normalizedFixed(value * 1e3, 4).replace(/\.?0+$/, "")} mA`;
}

function engineeringPresentation(value, channel, scale, compact) {
  const space = compact ? "" : " ";
  if (value === 0) return channel === "voltage" ? `0${space}V` : `0${space}A`;
  if (channel === "voltage") {
    const digits = scale < 1 ? 1 : 0;
    return `${normalizedFixed(value, digits)}${space}V`;
  }
  const magnitude = Math.abs(scale);
  if (magnitude >= 0.2) return `${normalizedFixed(value, 1)}${space}A`;
  if (magnitude >= 0.001) return `${normalizedFixed(value * 1e3, 0)}${space}mA`;
  return `${normalizedFixed(value * 1e3, 1)}${space}mA`;
}

export function formatYAxisTick(value, channel, scale) {
  return engineeringPresentation(value, channel, scale, false);
}


// Liang-Barsky clipping. Returned endpoints retain whether clipping created them.
export function clipLineToRectangle(a, b, rectangle) {
  const dx = b.x - a.x; const dy = b.y - a.y;
  let enter = 0; let exit = 1;
  const tests = [[-dx, a.x - rectangle.xMin], [dx, rectangle.xMax - a.x], [-dy, a.y - rectangle.yMin], [dy, rectangle.yMax - a.y]];
  for (const [p, q] of tests) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > exit) return null; if (r > enter) enter = r; }
    else { if (r < enter) return null; if (r < exit) exit = r; }
  }
  const point = (t) => Object.freeze({ x: a.x + t * dx, y: a.y + t * dy });
  return Object.freeze({ start: point(enter), end: point(exit), clippedStart: enter > 0, clippedEnd: exit < 1 });
}

function sameRun(left, right, channel) {
  return left.stream_id === right.stream_id && left.segment_id === right.segment_id && pieceOf(left, channel) === pieceOf(right, channel)
    && !right.flags?.timebase_reset && !right.flags?.discontinuity && !(right.flags?.gap_samples > 0n);
}

export function constructGraphFrame({ records, channel, scale, domain, originTimestampUs, origin = 0 }) {
  const valid = [];
  const invalid = [];
  let observedInWindow = false; let mostNegative = null;
  for (let sourceIndex = 0; sourceIndex < records.length; sourceIndex += 1) {
    const record = records[sourceIndex];
    const value = finiteValue(record, channel);
    if (typeof record.timestamp_us !== "bigint" || typeof originTimestampUs !== "bigint") continue;
    const x = Number(record.timestamp_us - originTimestampUs) / 1e6;
    if (x < domain.minimum || x > domain.maximum) continue;
    if (value === null) { invalid.push(Object.freeze({ seconds: x })); continue; }
    valid.push({ record, sourceIndex, x, y: value });
    if (channel === "current" && value < 0) { observedInWindow = true; mostNegative = mostNegative === null ? value : Math.min(mostNegative, value); }
  }
  // The Y viewport is [origin, origin + 9 * scale]. Clipping, the numeric axis
  // and the waveform transform all read this one origin, so a shifted waveform
  // can never be drawn against an unshifted axis. origin 0 is the LIVE and
  // latched-Stop viewport and reproduces the previous rectangle exactly.
  const rectangle = { xMin: domain.minimum, xMax: domain.maximum, yMin: origin, yMax: origin + 9 * scale };
  const paths = []; let path = null;
  for (let index = 1; index < valid.length; index += 1) {
    const previous = valid[index - 1]; const current = valid[index];
    if (current.sourceIndex !== previous.sourceIndex + 1 || !sameRun(previous.record, current.record, channel)) { path = null; continue; }
    const piece = clipLineToRectangle(previous, current, rectangle);
    if (!piece) { path = null; continue; }
    const canMerge = path && path.runRecord === previous.record && !path.clippedEnd && !piece.clippedStart;
    if (!canMerge) {
      path = { points: [piece.start, piece.end], runRecord: current.record, clippedEnd: piece.clippedEnd };
      paths.push(path);
    } else {
      path.points.push(piece.end); path.runRecord = current.record; path.clippedEnd = piece.clippedEnd;
    }
  }
  const frozenPaths = Object.freeze(paths.map((entry) => Object.freeze(entry.points)));
  return Object.freeze({
    channel, scale, origin, divisions: 9, domain: Object.freeze({ ...domain }), originTimestampUs,
    measurementState: valid.length ? "valid" : "no-valid-data",
    plotState: frozenPaths.length ? "visible" : valid.length && valid.some((entry) => entry.y < rectangle.yMin || entry.y > rectangle.yMax) ? "clipped-out" : "empty",
    paths: frozenPaths,
    invalid: Object.freeze(invalid),
    reverseObservation: Object.freeze({ observedInWindow, mostNegative }),
  });
}

export class GraphPolicyController {
  constructor({ windowSeconds = 60 } = {}) { this.windowSeconds = windowSeconds; this.epochGeneration = 0; this.windowGeneration = 0; this.previousControlState = null; this.reset(); }
  reset() { this.scaleIndices = { voltage: 0, current: 0 }; this.originTimestampUs = null; this.streamId = null; this.reverseObservation = { observedInWindow: false, mostNegative: null }; this.epochGeneration += 1; this.scaleEvaluationIdentity = { voltage: null, current: null }; this.yState = { voltage: { mode: "LIVE_AUTO_ZERO", origin: 0 }, current: { mode: "LIVE_AUTO_ZERO", origin: 0 } }; }
  yPresentation(channel) {
    const state = this.yState[channel];
    if (!state) throw new TypeError("channel must be voltage or current");
    return Object.freeze({ mode: state.mode, origin: state.origin, scale: (channel === "voltage" ? VOLTAGE_SCALES : CURRENT_SCALES)[this.scaleIndices[channel]] });
  }
  observeLifecycle({ controlState, streamId = null, timebaseReset = false } = {}) {
    const enteredStreaming = this.previousControlState !== "STREAMING" && controlState === "STREAMING";
    const streamChanged = streamId !== null && this.streamId !== null && streamId !== this.streamId;
    if (enteredStreaming || timebaseReset || streamChanged) this.reset();
    this.previousControlState = controlState ?? this.previousControlState;
    if (streamId !== null) this.streamId = streamId;
    return enteredStreaming || timebaseReset || streamChanged;
  }
  setWindowSeconds(value) { if (!DISPLAY_WINDOWS.includes(value)) throw new RangeError("unsupported display window"); if (this.windowSeconds !== value) { this.windowSeconds = value; this.windowGeneration += 1; this.scaleEvaluationIdentity = { voltage: null, current: null }; } }
  // Every manual stopped Y scale route -- dropdown, adjacent zoom button and
  // Y pinch -- lands here, so manual mode is entered in exactly one place.
  setStoppedScale(channel, value, stoppedReady) {
    const scales = channel === "voltage" ? VOLTAGE_SCALES : channel === "current" ? CURRENT_SCALES : [];
    const index = scales.indexOf(value);
    if (!stoppedReady || index < 0) return false;
    this.scaleIndices[channel] = index;
    this.yState[channel].mode = "STOPPED_MANUAL_FREE";
    return true;
  }
  /**
   * Manual stopped Y origin, in channel units, for vertical pan. The origin is
   * not clamped to the measured range: recovery from an origin that has left
   * the data behind is the channel's own Y Auto control, not a bound invented
   * from the measurement domain. Only non-finite values are refused.
   */
  setStoppedOrigin(channel, origin, stoppedReady) {
    const state = this.yState[channel];
    if (!stoppedReady || !state || typeof origin !== "number" || !Number.isFinite(origin)) return false;
    state.origin = origin;
    state.mode = "STOPPED_MANUAL_FREE";
    return true;
  }
  /** Per-channel Y Auto: zero origin, then fit the current visible X viewport. */
  autoStoppedY(channel, stoppedReady) {
    const state = this.yState[channel];
    if (!stoppedReady || !state) return false;
    state.origin = 0;
    state.mode = "STOPPED_AUTO_ZERO";
    return true;
  }
  /**
   * stoppedReview is the caller's accepted-stopped-review readiness, the same
   * fact that gates setStoppedScale/setStoppedOrigin/autoStoppedY and that
   * decides whether rightEdgeTimestampUs is supplied at all. Only a frame
   * built against that accepted review viewport may feed the retained Y
   * authority. While an unaccepted attempt is in flight -- open, CONNECTING,
   * pending hello or Start, a timeout, a transport failure, a force close --
   * readiness is temporarily false and the frame follows latest instead of
   * the reviewer's cursor, so re-evaluating here would silently rewrite the
   * previous session's Y state against a viewport the reviewer never chose.
   * It defaults to false so a caller that omits it can never mutate.
   */
  update(records, { originTimestampUs = null, rightEdgeTimestampUs = null, autoscale = true, stoppedReview = false } = {}) {
    const timestamped = records.filter((record) => typeof record.timestamp_us === "bigint");
    if (typeof originTimestampUs === "bigint") this.originTimestampUs = originTimestampUs;
    if (this.originTimestampUs === null && timestamped.length) this.originTimestampUs = timestamped[0].timestamp_us;
    const latest = rightEdgeTimestampUs ?? timestamped.at(-1)?.timestamp_us ?? this.originTimestampUs;
    const domain = makeTimeDomain(this.originTimestampUs, latest, this.windowSeconds);
    const active = timestamped.filter((record) => {
      const x = Number(record.timestamp_us - this.originTimestampUs) / 1e6;
      return x >= domain.minimum && x <= domain.maximum;
    });
    for (const channel of ["voltage", "current"]) {
      const scales = channel === "voltage" ? VOLTAGE_SCALES : CURRENT_SCALES;
      const state = this.yState[channel];
      if (autoscale) {
        // LIVE owns both axes: zero origin and the unchanged staged autoscale.
        if (state.mode !== "LIVE_AUTO_ZERO") { state.mode = "LIVE_AUTO_ZERO"; state.origin = 0; }
        const latestValid = active.findLast((record) => finiteValue(record, channel) !== null);
        const evaluationIdentity = `${this.epochGeneration}:${this.windowGeneration}:${rightEdgeTimestampUs ?? "live"}:${latestValid?.stream_id ?? "none"}:${latestValid?.sequence?.toString() ?? "none"}`;
        if (evaluationIdentity !== this.scaleEvaluationIdentity[channel]) {
          const scaleUpdate = updateStagedScale(scales, this.scaleIndices[channel], active.map((record) => finiteValue(record, channel)));
          this.scaleIndices[channel] = scaleUpdate.scaleIndex;
          this.scaleEvaluationIdentity[channel] = evaluationIdentity;
        }
        continue;
      }
      // Outside STREAMING the scale is already frozen for every mode, so a
      // frame rendered while review is unavailable simply repaints retained
      // values. Only an accepted stopped review may move the state machine.
      if (!stoppedReview) continue;
      // Reaching accepted review from LIVE latches the last live frame: same
      // zero origin, same scale. Only STOPPED_AUTO_ZERO re-derives a scale,
      // and only from what the reviewer's own X viewport currently shows.
      if (state.mode === "LIVE_AUTO_ZERO") { state.mode = "STOPPED_LATCHED_ZERO"; state.origin = 0; }
      if (state.mode === "STOPPED_AUTO_ZERO") this.scaleIndices[channel] = viewportAutoScaleIndex(scales, this.scaleIndices[channel], active.map((record) => finiteValue(record, channel)));
    }
    const voltage = constructGraphFrame({ records: active, channel: "voltage", scale: VOLTAGE_SCALES[this.scaleIndices.voltage], domain, originTimestampUs: this.originTimestampUs, origin: this.yState.voltage.origin });
    const current = constructGraphFrame({ records: active, channel: "current", scale: CURRENT_SCALES[this.scaleIndices.current], domain, originTimestampUs: this.originTimestampUs, origin: this.yState.current.origin });
    this.reverseObservation = current.reverseObservation;
    return Object.freeze({ voltage, current, precision: timePrecision(this.windowSeconds) });
  }
}
