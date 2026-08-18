// These are display-policy candidates for the prototype, not product constants.
// Every candidate may be supplied through autoscale(records, options).
export const AUTOSCALE_HYPOTHESIS = Object.freeze({
  candidateVisibleWindowMs: 60_000,
  candidateCentralFraction: 0.6,
  candidateMinimumSpan: 0.001,
  candidateGapBreakMs: 5_000,
  candidateShrinkHysteresisRatio: 0.8,
  candidateShrinkStableCount: 2,
});

const DEFAULT_CONTEXT = "__autoscale_default_context__";

function validSample(record) {
  return Boolean(record) && record.valid !== false && Number.isFinite(record.value);
}

function contextOf(record) {
  return {
    sessionId: record?.sessionId ?? DEFAULT_CONTEXT,
    timebaseId: record?.timebaseId ?? DEFAULT_CONTEXT,
  };
}

function sameContext(left, right) {
  return left.sessionId === right.sessionId && left.timebaseId === right.timebaseId;
}

function candidateOptions(options) {
  const candidate = { ...AUTOSCALE_HYPOTHESIS };
  for (const key of Object.keys(AUTOSCALE_HYPOTHESIS)) {
    if (options[key] !== undefined) candidate[key] = options[key];
  }
  if (!(candidate.candidateVisibleWindowMs > 0)
    || !(candidate.candidateMinimumSpan > 0)
    || !(candidate.candidateGapBreakMs >= 0)
    || !(candidate.candidateCentralFraction > 0 && candidate.candidateCentralFraction <= 1)
    || !(candidate.candidateShrinkHysteresisRatio > 0
      && candidate.candidateShrinkHysteresisRatio <= 1)
    || !Number.isInteger(candidate.candidateShrinkStableCount)
    || candidate.candidateShrinkStableCount < 1) {
    throw new RangeError("autoscale hypothesis candidates are invalid");
  }
  return Object.freeze(candidate);
}

function explicitZoom(zoom) {
  if (zoom === undefined || zoom === false || zoom === "auto") return null;
  if (!zoom || typeof zoom !== "object" || !Number.isFinite(zoom.min)
    || !Number.isFinite(zoom.max) || !(zoom.min < zoom.max)) {
    throw new TypeError("zoom must be false, 'auto', or an explicit { min, max } range");
  }
  return Object.freeze({ min: zoom.min, max: zoom.max });
}

function boundsFor(validRecords, candidate) {
  const values = validRecords.map((record) => record.value);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const dataSpan = dataMax - dataMin;
  const span = Math.max(
    dataSpan / candidate.candidateCentralFraction,
    candidate.candidateMinimumSpan,
  );
  const midpoint = (dataMin + dataMax) / 2;
  return Object.freeze({ min: midpoint - span / 2, max: midpoint + span / 2 });
}

function checkedPreviousBounds(previousBounds) {
  if (previousBounds === undefined || previousBounds === null) return null;
  if (!Number.isFinite(previousBounds.min) || !Number.isFinite(previousBounds.max)
    || !(previousBounds.min < previousBounds.max)
    || !Number.isInteger(previousBounds.stableCount ?? 0)
    || (previousBounds.stableCount ?? 0) < 0) {
    throw new TypeError(
      "previousBounds must contain finite min/max and a non-negative stableCount",
    );
  }
  return Object.freeze({
    min: previousBounds.min,
    max: previousBounds.max,
    stableCount: previousBounds.stableCount ?? 0,
  });
}

function applyHysteresis(candidateBounds, previousBounds, candidate) {
  if (!previousBounds) {
    return { bounds: candidateBounds, action: "initial", stableCount: 0 };
  }
  const expands = candidateBounds.min < previousBounds.min
    || candidateBounds.max > previousBounds.max;
  if (expands) {
    return { bounds: candidateBounds, action: "expanded", stableCount: 0 };
  }
  const candidateSpan = candidateBounds.max - candidateBounds.min;
  const previousSpan = previousBounds.max - previousBounds.min;
  const shrinkEligible = candidateSpan
    <= previousSpan * candidate.candidateShrinkHysteresisRatio;
  if (!shrinkEligible) {
    return { bounds: previousBounds, action: "held", stableCount: 0 };
  }
  const stableCount = previousBounds.stableCount + 1;
  if (stableCount >= candidate.candidateShrinkStableCount) {
    return { bounds: candidateBounds, action: "shrunk", stableCount: 0 };
  }
  return {
    bounds: previousBounds,
    action: "awaiting-stable-shrink",
    stableCount,
  };
}

function discontinuityMetadata(displayRecords, candidate) {
  const breaks = [];
  const segments = [];
  let segment = [];
  let prior = null;
  const closeSegment = () => {
    if (segment.length) {
      segments.push(Object.freeze({
        sourceIndices: Object.freeze(segment.map((entry) => entry.sourceIndex)),
        timestampsMs: Object.freeze(segment.map((entry) => entry.timestampMs)),
      }));
    }
    segment = [];
  };

  for (const entry of displayRecords) {
    if (prior && entry.timestampMs - prior.timestampMs > candidate.candidateGapBreakMs) {
      closeSegment();
      breaks.push(Object.freeze({
        kind: "device-time-gap",
        fromSourceIndex: prior.sourceIndex,
        toSourceIndex: entry.sourceIndex,
        fromTimestampMs: prior.timestampMs,
        toTimestampMs: entry.timestampMs,
      }));
    }
    if (entry.record.gap === true) {
      closeSegment();
      breaks.push(Object.freeze({
        kind: "declared-gap",
        sourceIndex: entry.sourceIndex,
        timestampMs: entry.timestampMs,
      }));
    }
    if (!validSample(entry.record)) {
      closeSegment();
      breaks.push(Object.freeze({
        kind: "invalid-sample",
        sourceIndex: entry.sourceIndex,
        timestampMs: entry.timestampMs,
      }));
    } else if (entry.record.gap !== true) {
      segment.push(entry);
    }
    prior = entry;
  }
  closeSegment();
  return Object.freeze({
    breaks: Object.freeze(breaks),
    segments: Object.freeze(segments),
  });
}

/**
 * Returns display-only bounds and unmodified device-time records. It never
 * resamples, interpolates, or converts invalid samples into zero.
 */
export function autoscale(records, options = {}) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  const candidate = candidateOptions(options);
  const zoom = explicitZoom(options.zoom);
  const previousBounds = checkedPreviousBounds(options.previousBounds);

  if (!records.length) {
    return Object.freeze({
      kind: "no-valid-data",
      mode: zoom ? "explicit-zoom" : "auto",
      bounds: null,
      metadata: Object.freeze({
        breaks: Object.freeze([]),
        segments: Object.freeze([]),
        evicted: Object.freeze([]),
        hardBoundaries: Object.freeze([]),
        timeDomain: null,
        displayRecords: Object.freeze([]),
      }),
      hypothesis: candidate,
    });
  }

  const latestContext = contextOf(records.at(-1));
  let startIndex = records.length - 1;
  while (startIndex > 0 && sameContext(contextOf(records[startIndex - 1]), latestContext)) {
    startIndex -= 1;
  }
  const hardBoundaries = startIndex === 0 ? [] : [Object.freeze({
    kind: contextOf(records[startIndex - 1]).sessionId !== latestContext.sessionId
      ? "session-change"
      : "timebase-reset",
    beforeSourceIndex: startIndex - 1,
    afterSourceIndex: startIndex,
    before: Object.freeze(contextOf(records[startIndex - 1])),
    after: Object.freeze(latestContext),
  })];

  const latestContextRecords = records.slice(startIndex).map((record, offset) => ({
    record,
    sourceIndex: startIndex + offset,
    timestampMs: record?.timestampMs,
  }));
  if (latestContextRecords.some((entry) => !Number.isFinite(entry.timestampMs))) {
    throw new TypeError("every record requires a finite device timestampMs");
  }

  const endMs = Math.max(...latestContextRecords.map((entry) => entry.timestampMs));
  const windowStartMs = endMs - candidate.candidateVisibleWindowMs;
  const evicted = latestContextRecords
    .filter((entry) => entry.timestampMs < windowStartMs)
    .map((entry) => Object.freeze({
      sourceIndex: entry.sourceIndex,
      timestampMs: entry.timestampMs,
      reason: "outside-device-time-window",
    }));
  const displayRecords = latestContextRecords
    .filter((entry) => entry.timestampMs >= windowStartMs);
  const validRecords = displayRecords.map((entry) => entry.record).filter(validSample);
  const discontinuities = discontinuityMetadata(displayRecords, candidate);
  const timestampsMs = displayRecords.map((entry) => entry.timestampMs);
  const metadata = Object.freeze({
    activeContext: Object.freeze(latestContext),
    hardBoundaries: Object.freeze(hardBoundaries),
    evicted: Object.freeze(evicted),
    breaks: discontinuities.breaks,
    segments: discontinuities.segments,
    timeDomain: timestampsMs.length ? Object.freeze({
      startMs: Math.min(...timestampsMs),
      endMs,
      durationMs: endMs - Math.min(...timestampsMs),
    }) : null,
    displayRecords: Object.freeze(displayRecords.map((entry) => Object.freeze({
      sourceIndex: entry.sourceIndex,
      timestampMs: entry.timestampMs,
      record: entry.record,
    }))),
  });

  if (!validRecords.length) {
    return Object.freeze({
      kind: "no-valid-data",
      mode: zoom ? "explicit-zoom" : "auto",
      bounds: null,
      validCount: 0,
      metadata,
      hypothesis: candidate,
    });
  }

  const autoBounds = boundsFor(validRecords, candidate);
  if (zoom) {
    if (validRecords.some((record) => record.value < zoom.min || record.value > zoom.max)) {
      throw new RangeError("explicit zoom must contain every valid selected sample");
    }
    return Object.freeze({
      kind: "scaled",
      mode: "explicit-zoom",
      bounds: zoom,
      validCount: validRecords.length,
      metadata,
      hypothesis: candidate,
      hysteresis: Object.freeze({ action: "explicit-zoom", stableCount: 0 }),
    });
  }

  const hysteresis = applyHysteresis(autoBounds, previousBounds, candidate);
  return Object.freeze({
    kind: "scaled",
    mode: "auto",
    bounds: Object.freeze({
      min: hysteresis.bounds.min,
      max: hysteresis.bounds.max,
    }),
    validCount: validRecords.length,
    metadata,
    hypothesis: candidate,
    hysteresis: Object.freeze({
      action: hysteresis.action,
      stableCount: hysteresis.stableCount,
    }),
  });
}
