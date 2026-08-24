import { BoundedSegmentBuffer } from "../../model/bounded-segment-buffer.js";

/**
 * Bounded pcm-audio measurement model, structurally parallel to
 * ../../model/stream-model.js's reserve/commit split but for one-channel
 * PCM16 audio frames instead of V/I records. It has no parser dependency:
 * the session adapter prepares a reference-decoded frame, this model
 * validates a candidate, and only then mutates its bounded rings.
 *
 * Bound: MAX_FRAMES retains at most a few seconds of audio (frames are fixed
 * at 256 samples / 16 kHz = 16 ms each), which is far more than the largest
 * selectable render window (100 ms ~= 7 frames) needs, while keeping raw
 * PCM retention small and constant (MAX_FRAMES * 256 Int16 samples, about
 * 100 KiB at the cap) instead of unbounded. MAX_MARKERS bounds discontinuity
 * annotations the same way src/model/stream-model.js bounds V/I segment
 * markers.
 */
export const MAX_FRAMES = 200;
export const MAX_MARKERS = 128;

function requireUint64(value, field) {
  if (typeof value !== "bigint" || value < 0n) throw new TypeError(`${field} must be a uint64 BigInt`);
  return value;
}

function freezeFrame(frame) {
  return Object.freeze(frame);
}

function freezeMarker(marker) {
  return Object.freeze({ ...marker, causes: Object.freeze({ ...marker.causes }) });
}

export class PcmAudioModel {
  constructor({ capacity = MAX_FRAMES, markerCapacity = MAX_MARKERS } = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_FRAMES) {
      throw new RangeError(`capacity must be 1 through ${MAX_FRAMES}`);
    }
    this.frames = new BoundedSegmentBuffer(capacity);
    this.markers = new BoundedSegmentBuffer(markerCapacity);

    this.frameCount = 0;
    this.sampleCount = 0;
    this.segmentCount = 0;
    this.sequenceGapCount = 0;
    this.sequenceGapSamples = 0n;
    this.producerOverflowCount = 0;
    this.outputQueueDropCount = 0;
    this.sourcePausedCount = 0;
    this.timebaseResetCount = 0;
    this.viewerEvictionCount = 0;
    this.rejectedFrameCount = 0;

    this.latest = null;
    this._activeStreamId = null;
    this._activeProfile = null;
    this._currentSegmentId = null;
    this._nextSegmentId = 1;
    this._epochId = 0;
    this._sampleRate = null;
    this._samplesPerFrame = null;
  }

  beginStream({ streamId, profile, sampleRate, samplesPerFrame }) {
    if (!Number.isSafeInteger(streamId) || streamId < 1 || streamId > 0xffffffff) {
      throw new TypeError("invalid stream ID");
    }
    if (profile !== "pcm-audio") throw new TypeError("this model only accepts pcm-audio");
    // A negotiated stream is a new device-time epoch: never let its waveform
    // or markers share a viewport with a previous stream.
    this._clearViewport();
    this._activeStreamId = streamId;
    this._activeProfile = profile;
    this._currentSegmentId = null;
    this._nextSegmentId = 1;
    this._epochId += 1;
    this._sampleRate = sampleRate;
    this._samplesPerFrame = samplesPerFrame;
  }

  finishStream() {
    this._activeStreamId = null;
    this._activeProfile = null;
    this._currentSegmentId = null;
  }

  /**
   * Construct and fully validate a mutation candidate. No counters, rings, or
   * current-value fields are changed here, which lets the caller pair it with
   * a reference decoder's next state atomically and lets a rejected/invalid
   * frame roll back to nothing (the model is simply never mutated).
   */
  prepareDecodedFrame(decoded) {
    if (!decoded || typeof decoded !== "object") throw new TypeError("decoded frame is required");
    if (decoded.stream_end) return Object.freeze({ kind: "stream-end" });
    if (this._activeProfile !== "pcm-audio" || this._activeStreamId !== decoded.stream_id) {
      throw new TypeError("decoded frame does not match active pcm-audio stream");
    }
    if (!Number.isSafeInteger(decoded.sample_count) || decoded.sample_count !== this._samplesPerFrame) {
      throw new TypeError("decoded pcm sample_count does not match negotiated samples_per_frame");
    }
    if (!Array.isArray(decoded.samples) || decoded.samples.length !== decoded.sample_count) {
      throw new TypeError("decoded pcm samples are absent or mis-sized");
    }
    for (const sample of decoded.samples) {
      if (!Number.isInteger(sample) || sample < -32768 || sample > 32767) {
        throw new TypeError("decoded pcm sample is out of Int16 range");
      }
    }
    if (!Number.isSafeInteger(decoded.flags) || decoded.flags < 0 || decoded.flags > 0x7f ||
        typeof decoded.gap_samples !== "bigint" || decoded.gap_samples < 0n) {
      throw new TypeError("decoded frame flags or gap metadata are invalid");
    }
    const sequence = requireUint64(decoded.first_sample_sequence, "first_sample_sequence");
    const timestampUs = requireUint64(decoded.first_timestamp_us, "first_timestamp_us");

    const beginsViewportEpoch = Boolean(decoded.timebase_reset);
    const hasReferenceSegment = decoded.segment !== null && decoded.segment !== undefined;
    if (!hasReferenceSegment && this._currentSegmentId === null) {
      throw new TypeError("first frame must carry a reference segment");
    }
    const segmentId = hasReferenceSegment ? this._nextSegmentId : this._currentSegmentId;

    // Store an owned copy: the reference decoder's plain-array samples are
    // never retained as-is (a caller could still hold/mutate that array), and
    // Int16Array is the compact, exact, non-interpolating storage form.
    const samples = Int16Array.from(decoded.samples);

    const record = freezeFrame({
      stream_id: decoded.stream_id,
      sequence,
      timestamp_us: timestampUs,
      sample_count: decoded.sample_count,
      samples,
      flags: Object.freeze({
        raw: decoded.flags,
        stream_start: Boolean(decoded.stream_start),
        discontinuity: Boolean(decoded.discontinuity),
        producer_overflow: Boolean(decoded.producer_overflow),
        output_queue_drop: Boolean(decoded.output_queue_drop),
        source_paused: Boolean(decoded.source_paused),
        timebase_reset: Boolean(decoded.timebase_reset),
        gap_samples: decoded.gap_samples,
      }),
      segment_id: segmentId,
      epoch_id: beginsViewportEpoch ? this._epochId + 1 : this._epochId,
    });

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
      record,
      marker,
      nextSegmentId: hasReferenceSegment ? segmentId + 1 : this._nextSegmentId,
      currentSegmentId: segmentId,
      newEpochId: record.epoch_id,
      sequenceGap: decoded.gap_samples,
      producerOverflow: Boolean(decoded.producer_overflow),
      outputQueueDrop: Boolean(decoded.output_queue_drop),
      sourcePaused: Boolean(decoded.source_paused),
      timebaseReset: Boolean(decoded.timebase_reset),
      beginsViewportEpoch,
    });
  }

  commitCandidate(candidate) {
    if (!candidate || candidate.kind === "stream-end") return;
    if (candidate.kind !== "data") throw new TypeError("unknown model candidate");
    if (candidate.beginsViewportEpoch) {
      this._clearViewport();
      this._epochId = candidate.newEpochId;
    }
    if (this.frames.append(candidate.record) !== undefined) this.viewerEvictionCount += 1;
    if (candidate.marker) this.markers.append(candidate.marker);

    this.frameCount += 1;
    this.sampleCount += candidate.record.sample_count;
    if (candidate.marker) this.segmentCount += 1;
    if (candidate.sequenceGap > 0n) {
      this.sequenceGapCount += 1;
      this.sequenceGapSamples += candidate.sequenceGap;
    }
    if (candidate.producerOverflow) this.producerOverflowCount += 1;
    if (candidate.outputQueueDrop) this.outputQueueDropCount += 1;
    if (candidate.sourcePaused) this.sourcePausedCount += 1;
    if (candidate.timebaseReset) this.timebaseResetCount += 1;

    this._nextSegmentId = candidate.nextSegmentId;
    this._currentSegmentId = candidate.currentSegmentId;
    this.latest = candidate.record;
  }

  /** Call when a binary candidate/decode was rejected, purely for UI/test bookkeeping; never mutates rings. */
  noteRejectedFrame() {
    this.rejectedFrameCount += 1;
  }

  _clearViewport() {
    this.frames.clear();
    this.markers.clear();
    this.latest = null;
  }

  frameSnapshot() { return this.frames.toArray(); }
  markerSnapshot() { return this.markers.toArray(); }

  summary() {
    const latest = this.latest;
    return Object.freeze({
      frameCount: this.frameCount,
      sampleCount: this.sampleCount,
      segmentCount: this.segmentCount,
      sequenceGapCount: this.sequenceGapCount,
      sequenceGapSamples: this.sequenceGapSamples.toString(),
      producerOverflowCount: this.producerOverflowCount,
      outputQueueDropCount: this.outputQueueDropCount,
      sourcePausedCount: this.sourcePausedCount,
      timebaseResetCount: this.timebaseResetCount,
      viewerEvictionCount: this.viewerEvictionCount,
      rejectedFrameCount: this.rejectedFrameCount,
      bufferUsage: this.frames.size,
      bufferCapacity: this.frames.capacity,
      markerUsage: this.markers.size,
      markerCapacity: this.markers.capacity,
      sampleRate: this._sampleRate,
      samplesPerFrame: this._samplesPerFrame,
      epochId: this._epochId,
      latest: latest ? Object.freeze({
        streamId: latest.stream_id,
        sequence: latest.sequence.toString(),
        timestampUs: latest.timestamp_us.toString(),
        sampleCount: latest.sample_count,
        firstSample: latest.samples[0],
        lastSample: latest.samples.at(-1),
        segmentId: latest.segment_id,
        epochId: latest.epoch_id,
      }) : null,
    });
  }
}
