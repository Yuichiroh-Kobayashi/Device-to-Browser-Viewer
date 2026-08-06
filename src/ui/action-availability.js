/**
 * Pure live-control affordance policy. Source and adapter still enforce the
 * protocol independently; this only prevents avoidable UI requests.
 */
export function liveActionAvailability(session = {}, sourceStatus = {}) {
  const sourceOpen = sourceStatus?.state === "open";
  const start = sourceOpen && session.controlState === "READY" &&
    !session.startPending && !session.stopPending;
  const stop = sourceOpen && session.controlState === "STREAMING" &&
    !session.stopPending && Number.isSafeInteger(session.streamId) && session.streamId > 0;
  return Object.freeze({ start, stop });
}
