import { BoundedSegmentBuffer } from "./bounded-segment-buffer.js";

export const MAX_RECORDS = 4096;
export const MAX_MARKERS = 512;

function finiteOrNull(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be finite or null`);
  }
  return value;
}

function requireUint64(value, field) {
  if (typeof value !== "bigint" || value < 0n) throw new TypeError(`${field} must be a uint64 BigInt`);
  return value;
}

function freezeRecord(record) {
  return Object.freeze(record);
}

function freezeMarker(marker) {
  return Object.freeze({ ...marker, causes: Object.freeze({ ...marker.causes }) });
}

/**
 * Measurement-only state. It deliberately has no parser dependency: the session
 * adapter prepares a reference-decoded frame, this model validates a candidate,
 * and only then mutates its bounded rings.
 */
export class StreamModel {
  constructor({ capacity = MAX_RECORDS, displayWindowSeconds = 60 } = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_RECORDS) {
      throw new RangeError(`capacity must be 1 through ${MAX_RECORDS}`);
    }
    this.records = new BoundedSegmentBuffer(capacity);
    this.markers = new BoundedSegmentBuffer(MAX_MARKERS);
    this.displayWindowSeconds = 60;
    this.setDisplayWindowSeconds(displayWindowSeconds);

    this.sampleCount = 0;
    this.segmentCount = 0;
    this.sequenceGapCount = 0;
    this.sequenceGapSamples = 0n;
    this.producerOverflowCount = 0;
    this.outputQueueDropCount = 0;
    this.invalidVoltageCount = 0;
    this.invalidCurrentCount = 0;
    this.viewerEvictionCount = 0;
    this.viewerWindowEvictionCount = 0;
    this.viewerCapacityEvictionCount = 0;

    this.latest = null;
    this._activeStreamId = null;
    this._activeProfile = null;
    this._currentSegmentId = null;
    this._nextSegmentId = 1;
    this._voltageWasValid = false;
    this._currentWasValid = false;
    this._voltageSegmentId = 0;
    this._currentSegmentPieceId = 0;
    this._channelStreamId = null;
  }

  setDisplayWindowSeconds(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) {
      throw new RangeError("display window must be a finite number from 1 through 60 seconds");
    }
    this.displayWindowSeconds = seconds;
    if (this.latest) this._evictForDisplayWindow(this.latest.timestamp_us, this.latest.stream_id);
  }

  beginStream({ streamId, profile }) {
    if (!Number.isSafeInteger(streamId) || streamId < 1 || streamId > 0xffffffff) {
      throw new TypeError("invalid stream ID");
    }
    if (profile !== "vi-measurement") throw new TypeError("viewer only accepts vi-measurement");
    // A negotiated stream is a new device-time epoch. Keep session-wide
    // diagnostics/counters, but never let its waveform or markers share a
    // viewport with the previous stream.
    this._clearViewport();
    this._activeStreamId = streamId;
    this._activeProfile = profile;
    this._currentSegmentId = null;
    this._voltageWasValid = false;
    this._currentWasValid = false;
    this._channelStreamId = streamId;
  }

  finishStream() {
    this._activeStreamId = null;
    this._activeProfile = null;
    this._currentSegmentId = null;
    this._voltageWasValid = false;
    this._currentWasValid = false;
    this._channelStreamId = null;
  }

  /**
   * Construct and fully validate a mutation candidate. No counters, rings, or
   * current-value fields are changed here, which lets the adapter pair it with a
   * reference decoder's next state atomically.
   */
  prepareDecodedFrame(decoded) {
    if (!decoded || typeof decoded !== "object") throw new TypeError("decoded frame is required");
    if (decoded.stream_end) return Object.freeze({ kind: "stream-end" });
    if (this._activeProfile !== "vi-measurement" || this._activeStreamId !== decoded.stream_id) {
      throw new TypeError("decoded frame does not match active V/I stream");
    }
    if (!Array.isArray(decoded.records) || decoded.records.length < 1 || decoded.records.length > MAX_RECORDS) {
      throw new TypeError("decoded V/I records are absent or exceed retained capacity");
    }
    if (!Number.isSafeInteger(decoded.flags) || decoded.flags < 0 || decoded.flags > 0x7f ||
        typeof decoded.gap_samples !== "bigint" || decoded.gap_samples < 0n) {
      throw new TypeError("decoded frame flags or gap metadata are invalid");
    }

    const beginsViewportEpoch = Boolean(decoded.timebase_reset);
    const hasReferenceSegment = decoded.segment !== null && decoded.segment !== undefined;
    if (!hasReferenceSegment && this._currentSegmentId === null) {
      throw new TypeError("first frame must carry a reference segment");
    }
    let segmentId = hasReferenceSegment ? this._nextSegmentId : this._currentSegmentId;
    let voltageWasValid = beginsViewportEpoch ? false : this._voltageWasValid;
    let currentWasValid = beginsViewportEpoch ? false : this._currentWasValid;
    let voltagePiece = this._voltageSegmentId;
    let currentPiece = this._currentSegmentPieceId;
    const records = new Array(decoded.records.length);
    let invalidVoltageDelta = 0;
    let invalidCurrentDelta = 0;

    for (let index = 0; index < decoded.records.length; index += 1) {
      const source = decoded.records[index];
      if (!source || typeof source !== "object") throw new TypeError("invalid decoded record");
      const sequence = requireUint64(source.sequence, "sequence");
      const timestampUs = requireUint64(source.timestampUs, "timestamp_us");
      const validMask = source.validMask;
      if (!Number.isSafeInteger(validMask) || validMask < 0 || validMask > 3) {
        throw new TypeError("invalid valid_mask");
      }
      const measurements = source.measurements;
      const voltage = (validMask & 1) ? finiteOrNull(measurements?.voltage, "voltage") : null;
      const current = (validMask & 2) ? finiteOrNull(measurements?.current, "current") : null;
      if ((validMask & 1) && voltage === null) throw new TypeError("valid voltage is missing");
      if ((validMask & 2) && current === null) throw new TypeError("valid current is missing");
      if (!(validMask & 1)) invalidVoltageDelta += 1;
      if (!(validMask & 2)) invalidCurrentDelta += 1;

      const boundary = (hasReferenceSegment || beginsViewportEpoch) && index === 0;
      if (voltage !== null) {
        if (boundary || !voltageWasValid || this._channelStreamId !== decoded.stream_id) voltagePiece += 1;
        voltageWasValid = true;
      } else {
        voltageWasValid = false;
      }
      if (current !== null) {
        if (boundary || !currentWasValid || this._channelStreamId !== decoded.stream_id) currentPiece += 1;
        currentWasValid = true;
      } else {
        currentWasValid = false;
      }

      records[index] = freezeRecord({
        stream_id: decoded.stream_id,
        sequence,
        timestamp_us: timestampUs,
        valid_mask: validMask,
        voltage_V: voltage,
        current_A: current,
        flags: Object.freeze({
          raw: decoded.flags,
          stream_start: Boolean(decoded.stream_start),
          stream_end: false,
          discontinuity: Boolean(decoded.discontinuity),
          producer_overflow: Boolean(decoded.producer_overflow),
          output_queue_drop: Boolean(decoded.output_queue_drop),
          source_paused: Boolean(decoded.source_paused),
          timebase_reset: Boolean(decoded.timebase_reset),
          gap_samples: typeof decoded.gap_samples === "bigint" ? decoded.gap_samples : 0n,
        }),
        segment_id: segmentId,
        voltage_segment_id: voltage === null ? null : voltagePiece,
        current_segment_id: current === null ? null : currentPiece,
      });
    }

    let marker = null;
    if (hasReferenceSegment) {
      const source = decoded.segment;
      if (source.streamId !== decoded.stream_id || typeof source.startSequence !== "bigint" ||
          typeof source.startTimestampUs !== "bigint" || typeof source.gapSamples !== "bigint" ||
          source.gapSamples < 0n || !source.causes || typeof source.causes !== "object") {
        throw new TypeError("invalid reference segment metadata");
      }
      marker = freezeMarker({
        id: segmentId,
        stream_id: decoded.stream_id,
        sequence: source.startSequence,
        timestamp_us: source.startTimestampUs,
        kind: source.gapSamples > 0n ? "sequence-gap" : "segment-start",
        gap_samples: source.gapSamples,
        causes: source.causes,
      });
    }

    return Object.freeze({
      kind: "data",
      records: Object.freeze(records),
      marker,
      nextSegmentId: hasReferenceSegment ? segmentId + 1 : this._nextSegmentId,
      currentSegmentId: segmentId,
      voltageWasValid,
      currentWasValid,
      voltagePiece,
      currentPiece,
      invalidVoltageDelta,
      invalidCurrentDelta,
      sequenceGap: typeof decoded.gap_samples === "bigint" ? decoded.gap_samples : 0n,
      producerOverflow: Boolean(decoded.producer_overflow),
      outputQueueDrop: Boolean(decoded.output_queue_drop),
      beginsViewportEpoch,
    });
  }

  commitCandidate(candidate) {
    if (!candidate || candidate.kind === "stream-end") return;
    if (candidate.kind !== "data") throw new TypeError("unknown model candidate");
    // The frame is already fully validated by prepareDecodedFrame. Clearing at
    // commit time keeps rejection atomic and makes the reset frame the first
    // visible record in its fresh viewport epoch.
    if (candidate.beginsViewportEpoch) this._clearViewport();
    for (const record of candidate.records) {
      if (this.records.append(record) !== undefined) {
        this.viewerEvictionCount += 1;
        this.viewerCapacityEvictionCount += 1;
      }
    }
    if (candidate.marker) this.markers.append(candidate.marker);
    this.sampleCount += candidate.records.length;
    this.invalidVoltageCount += candidate.invalidVoltageDelta;
    this.invalidCurrentCount += candidate.invalidCurrentDelta;
    if (candidate.marker) this.segmentCount += 1;
    if (candidate.sequenceGap > 0n) {
      this.sequenceGapCount += 1;
      this.sequenceGapSamples += candidate.sequenceGap;
    }
    if (candidate.producerOverflow) this.producerOverflowCount += 1;
    if (candidate.outputQueueDrop) this.outputQueueDropCount += 1;

    this._nextSegmentId = candidate.nextSegmentId;
    this._currentSegmentId = candidate.currentSegmentId;
    this._voltageWasValid = candidate.voltageWasValid;
    this._currentWasValid = candidate.currentWasValid;
    this._voltageSegmentId = candidate.voltagePiece;
    this._currentSegmentPieceId = candidate.currentPiece;
    this.latest = candidate.records.at(-1);
    this._evictForDisplayWindow(this.latest.timestamp_us, this.latest.stream_id);
  }

  _evictForDisplayWindow(latestTimestampUs, streamId) {
    const widthUs = BigInt(Math.round(this.displayWindowSeconds * 1_000_000));
    const cutoff = latestTimestampUs > widthUs ? latestTimestampUs - widthUs : 0n;
    // An epoch reset clears both rings, but discard any stale/mismatched FIFO
    // entries defensively so they can never block active-epoch time eviction.
    while (this.records.size > 0) {
      const oldest = this.records.peek();
      if (oldest.stream_id !== streamId) {
        this.records.shift();
        continue;
      }
      if (oldest.timestamp_us >= cutoff) break;
      this.records.shift();
      this.viewerEvictionCount += 1;
      this.viewerWindowEvictionCount += 1;
    }
    while (this.markers.size > 0) {
      const oldest = this.markers.peek();
      if (oldest.stream_id !== streamId) {
        this.markers.shift();
        continue;
      }
      if (oldest.timestamp_us >= cutoff) break;
      this.markers.shift();
    }
  }

  _clearViewport() {
    this.records.clear();
    this.markers.clear();
    this.latest = null;
  }

  recordSnapshot() { return this.records.toArray(); }
  markerSnapshot() { return this.markers.toArray(); }

  summary() {
    const latest = this.latest;
    return Object.freeze({
      sampleCount: this.sampleCount,
      segmentCount: this.segmentCount,
      sequenceGapCount: this.sequenceGapCount,
      sequenceGapSamples: this.sequenceGapSamples.toString(),
      producerOverflowCount: this.producerOverflowCount,
      outputQueueDropCount: this.outputQueueDropCount,
      invalidVoltageCount: this.invalidVoltageCount,
      invalidCurrentCount: this.invalidCurrentCount,
      viewerEvictionCount: this.viewerEvictionCount,
      viewerWindowEvictionCount: this.viewerWindowEvictionCount,
      viewerCapacityEvictionCount: this.viewerCapacityEvictionCount,
      bufferUsage: this.records.size,
      bufferCapacity: this.records.capacity,
      markerUsage: this.markers.size,
      markerCapacity: this.markers.capacity,
      latest: latest ? Object.freeze({
        streamId: latest.stream_id,
        sequence: latest.sequence.toString(),
        timestampUs: latest.timestamp_us.toString(),
        voltageV: latest.voltage_V,
        currentA: latest.current_A,
        validMask: latest.valid_mask,
      }) : null,
    });
  }
}
