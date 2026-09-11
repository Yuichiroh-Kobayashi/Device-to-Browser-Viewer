import { MAX_RECORDS, StreamModel } from "../source-export/viewer/src/model/stream-model.js";

// Reuse the existing 4096-record ceiling: about 164 seconds at 25 Hz.
export const HISTORY_CAPACITY = MAX_RECORDS;

/** Product retention policy over the sole adapter's validated, frozen records. */
export class SessionHistoryModel extends StreamModel {
  constructor() {
    super({ capacity: HISTORY_CAPACITY });
    this.historyEpoch = 0;
    this.historyOriginTimestampUs = null;
    this.historyTruncated = false;
    this.historyMarkersTruncated = false;
  }

  _clearViewport() {
    super._clearViewport();
    this.historyEpoch += 1;
    this.historyOriginTimestampUs = null;
    this.historyTruncated = false;
    this.historyMarkersTruncated = false;
  }

  commitCandidate(candidate) {
    const evictionsBefore = this.viewerCapacityEvictionCount;
    const markerOverflow = candidate?.kind === "data" && !candidate.beginsViewportEpoch
      && candidate.marker && this.markers.size === this.markers.capacity;
    super.commitCandidate(candidate);
    if (candidate?.kind !== "data") return;
    // Capture the first committed timestamp even if rendering is throttled or
    // a capacity eviction later removes that record. Never rebase on eviction.
    if (this.historyOriginTimestampUs === null) this.historyOriginTimestampUs = candidate.records[0].timestamp_us;
    if (this.viewerCapacityEvictionCount > evictionsBefore) this.historyTruncated = true;
    if (markerOverflow) this.historyMarkersTruncated = true;
  }

  _evictForDisplayWindow() {
    // Viewport selection cannot delete measurements. The inherited FIFO alone
    // bounds them. Markers outside retained measurements no longer annotate a
    // possible review window and can be released (path boundaries are records).
    const first = this.records.peek();
    while (first && this.markers.size && this.markers.peek().timestamp_us < first.timestamp_us) this.markers.shift();
  }

  historySummary() {
    return Object.freeze({
      epoch: this.historyEpoch,
      originTimestampUs: this.historyOriginTimestampUs,
      firstTimestampUs: this.records.peek()?.timestamp_us ?? null,
      latestTimestampUs: this.latest?.timestamp_us ?? null,
      count: this.records.size,
      capacity: this.records.capacity,
      truncated: this.historyTruncated,
      markersTruncated: this.historyMarkersTruncated,
    });
  }
}
