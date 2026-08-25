export const VOLTAGE_SCALES = Object.freeze([0.1, 0.2, 0.5, 1, 2, 5]);
export const CURRENT_SCALES = Object.freeze([0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1]);
export const DISPLAY_WINDOWS = Object.freeze([10, 30, 60]);

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

export function makeTimeDomain(originTimestampUs, latestTimestampUs, windowSeconds) {
  if (!DISPLAY_WINDOWS.includes(windowSeconds)) throw new RangeError("window must be 10, 30, or 60 seconds");
  if (typeof originTimestampUs !== "bigint" || typeof latestTimestampUs !== "bigint") return Object.freeze({ minimum: 0, maximum: windowSeconds });
  const elapsed = Number(latestTimestampUs - originTimestampUs) / 1e6;
  const maximum = elapsed <= windowSeconds ? windowSeconds : elapsed;
  return Object.freeze({ minimum: elapsed <= windowSeconds ? 0 : elapsed - windowSeconds, maximum });
}

export function timePrecision(windowSeconds) {
  if (!DISPLAY_WINDOWS.includes(windowSeconds)) throw new RangeError("window must be 10, 30, or 60 seconds");
  return windowSeconds === 10 ? 1 : 0;
}

export function makeXAxisTicks(domain, precision, plotWidthCss) {
  if (!domain || !Number.isFinite(domain.minimum) || !Number.isFinite(domain.maximum) || domain.maximum <= domain.minimum) throw new TypeError("invalid domain");
  const capacity = Math.max(2, Math.floor(plotWidthCss / (precision ? 58 : 46)));
  const ladder = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 20, 30, 60, 120];
  const width = domain.maximum - domain.minimum;
  const step = ladder.find((candidate) => Math.floor(width / candidate) + 1 <= capacity) ?? ladder.at(-1);
  const first = Math.ceil((domain.minimum - 1e-12) / step) * step;
  const ticks = [];
  for (let value = first; value <= domain.maximum + 1e-10; value += step) {
    const normalized = Math.abs(value) < 1e-12 ? 0 : Number(value.toFixed(10));
    ticks.push(Object.freeze({ value: normalized, label: normalized.toFixed(precision) }));
  }
  return Object.freeze(ticks);
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
  return `${normalizedFixed(value * 1e6, 1)} µA`;
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
  return `${normalizedFixed(value * 1e6, 0)}${space}µA`;
}

export function formatYAxisTick(value, channel, scale) {
  return engineeringPresentation(value, channel, scale, false);
}

export function formatScaleReadout(scale, channel) {
  return `${engineeringPresentation(scale, channel, scale, true)}/div`;
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

export function constructGraphFrame({ records, channel, scale, domain, originTimestampUs }) {
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
  const rectangle = { xMin: domain.minimum, xMax: domain.maximum, yMin: 0, yMax: 9 * scale };
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
    channel, scale, divisions: 9, domain: Object.freeze({ ...domain }), originTimestampUs,
    measurementState: valid.length ? "valid" : "no-valid-data",
    plotState: frozenPaths.length ? "visible" : valid.length && valid.some((entry) => entry.y < 0 || entry.y > rectangle.yMax) ? "clipped-out" : "empty",
    paths: frozenPaths,
    invalid: Object.freeze(invalid),
    reverseObservation: Object.freeze({ observedInWindow, mostNegative }),
  });
}

export class GraphPolicyController {
  constructor({ windowSeconds = 60 } = {}) { this.windowSeconds = windowSeconds; this.epochGeneration = 0; this.windowGeneration = 0; this.previousControlState = null; this.reset(); }
  reset() { this.scaleIndices = { voltage: 0, current: 0 }; this.originTimestampUs = null; this.streamId = null; this.reverseObservation = { observedInWindow: false, mostNegative: null }; this.epochGeneration += 1; this.scaleEvaluationIdentity = { voltage: null, current: null }; }
  observeLifecycle({ controlState, streamId = null, timebaseReset = false } = {}) {
    const enteredStreaming = this.previousControlState !== "STREAMING" && controlState === "STREAMING";
    const streamChanged = streamId !== null && this.streamId !== null && streamId !== this.streamId;
    if (enteredStreaming || timebaseReset || streamChanged) this.reset();
    this.previousControlState = controlState ?? this.previousControlState;
    if (streamId !== null) this.streamId = streamId;
    return enteredStreaming || timebaseReset || streamChanged;
  }
  setWindowSeconds(value) { if (!DISPLAY_WINDOWS.includes(value)) throw new RangeError("window must be 10, 30, or 60 seconds"); if (this.windowSeconds !== value) { this.windowSeconds = value; this.windowGeneration += 1; this.scaleEvaluationIdentity = { voltage: null, current: null }; } }
  update(records) {
    const timestamped = records.filter((record) => typeof record.timestamp_us === "bigint");
    if (this.originTimestampUs === null && timestamped.length) this.originTimestampUs = timestamped[0].timestamp_us;
    const latest = timestamped.at(-1)?.timestamp_us ?? this.originTimestampUs;
    const domain = makeTimeDomain(this.originTimestampUs, latest, this.windowSeconds);
    const active = timestamped.filter((record) => {
      const x = Number(record.timestamp_us - this.originTimestampUs) / 1e6;
      return x >= domain.minimum && x <= domain.maximum;
    });
    for (const channel of ["voltage", "current"]) {
      const latestValid = active.findLast((record) => finiteValue(record, channel) !== null);
      const evaluationIdentity = `${this.epochGeneration}:${this.windowGeneration}:${latestValid?.stream_id ?? "none"}:${latestValid?.sequence?.toString() ?? "none"}`;
      if (evaluationIdentity !== this.scaleEvaluationIdentity[channel]) {
        const scales = channel === "voltage" ? VOLTAGE_SCALES : CURRENT_SCALES;
        const scaleUpdate = updateStagedScale(scales, this.scaleIndices[channel], active.map((record) => finiteValue(record, channel)));
        this.scaleIndices[channel] = scaleUpdate.scaleIndex;
        this.scaleEvaluationIdentity[channel] = evaluationIdentity;
      }
    }
    const voltage = constructGraphFrame({ records: active, channel: "voltage", scale: VOLTAGE_SCALES[this.scaleIndices.voltage], domain, originTimestampUs: this.originTimestampUs });
    const current = constructGraphFrame({ records: active, channel: "current", scale: CURRENT_SCALES[this.scaleIndices.current], domain, originTimestampUs: this.originTimestampUs });
    this.reverseObservation = current.reverseObservation;
    return Object.freeze({ voltage, current, precision: timePrecision(this.windowSeconds) });
  }
}
