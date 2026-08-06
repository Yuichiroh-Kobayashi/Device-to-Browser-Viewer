function finiteNumbers(values) {
  const result = [];
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) result.push(value);
  return result;
}

/** Convert only a post-subtraction BigInt device-time delta to Number for canvas. */
export function relativeDeviceSeconds(timestampUs, originTimestampUs) {
  if (typeof timestampUs !== "bigint" || typeof originTimestampUs !== "bigint") return null;
  const seconds = Number(timestampUs - originTimestampUs) / 1_000_000;
  return Number.isFinite(seconds) ? seconds : null;
}

export function deviceTimeDomain(records) {
  let minimum = null;
  let maximum = null;
  for (const record of records) {
    if (typeof record?.timestamp_us !== "bigint") continue;
    if (minimum === null || record.timestamp_us < minimum) minimum = record.timestamp_us;
    if (maximum === null || record.timestamp_us > maximum) maximum = record.timestamp_us;
  }
  if (minimum === null || maximum === null) return null;
  const extent = relativeDeviceSeconds(maximum, minimum);
  if (extent === null) return null;
  return Object.freeze({
    originTimestampUs: minimum,
    minimumSeconds: 0,
    maximumSeconds: extent === 0 ? 1 : extent,
    exactMinimumTimestampUs: minimum,
    exactMaximumTimestampUs: maximum,
  });
}

export function robustFiniteScale(values, padding = 0.12) {
  const finite = finiteNumbers(values);
  if (finite.length === 0) return null;
  let minimum = Math.min(...finite);
  let maximum = Math.max(...finite);
  let span = maximum - minimum;
  if (!Number.isFinite(span)) return null;
  if (span === 0) {
    const half = Math.max(Math.abs(minimum) * 0.1, 0.05);
    minimum -= half;
    maximum += half;
    span = maximum - minimum;
  }
  const extra = Math.max(span * padding, Number.EPSILON);
  minimum -= extra;
  maximum += extra;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) return null;
  return Object.freeze({ minimum, maximum, span: maximum - minimum, includesZero: minimum <= 0 && maximum >= 0 });
}

export function mapLinear(value, minimum, maximum, outputMinimum, outputMaximum) {
  if (![value, minimum, maximum, outputMinimum, outputMaximum].every(Number.isFinite) || maximum === minimum) return null;
  return outputMinimum + ((value - minimum) / (maximum - minimum)) * (outputMaximum - outputMinimum);
}

export function formatValue(value) {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute >= 1000 || absolute < 0.01)) return value.toExponential(2);
  return value.toFixed(absolute >= 10 ? 1 : 3).replace(/\.0+$|(?<=\.[0-9]*?)0+$/, "");
}
