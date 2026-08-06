/**
 * Connect one DataSource to the session adapter without duplicating UI work.
 * Adapter methods own notifications for protocol activity; source-only status
 * transitions request a UI update directly.
 */
export function attachSourceActivity(source, adapter, { setSourceStatus, afterActivity }) {
  if (!source || !adapter) throw new TypeError("source and adapter are required");
  if (typeof setSourceStatus !== "function" || typeof afterActivity !== "function") {
    throw new TypeError("source activity callbacks are required");
  }
  const disposers = [
    source.onControl((control) => adapter.handleControl(control)),
    source.onBinary((buffer) => adapter.handleBinary(buffer)),
    source.onStatus((status) => {
      setSourceStatus(status);
      if (!adapter.notifyTransportStatus(status)) afterActivity();
    }),
    source.onError((error) => adapter.handleError(error)),
  ];
  return () => { for (const dispose of disposers) dispose(); };
}
