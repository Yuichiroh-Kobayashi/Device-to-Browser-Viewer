/** Exact milliseconds from a device-time delta, without Number conversion. */
export function formatElapsedMilliseconds(deltaUs) {
  if (typeof deltaUs !== "bigint" || deltaUs < 0n) throw new TypeError("elapsed device time must be a nonnegative BigInt");
  const whole = deltaUs / 1000n;
  const fraction = (deltaUs % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function csvExportState(history, ready) {
  if (!ready) return Object.freeze({ enabled: false, reason: "正常に測定を終了するとCSVを保存できます。 / Export after normal Stop." });
  if (!history.count) return Object.freeze({ enabled: false, reason: "保存する測定値がありません。 / No measurements to export." });
  if (history.truncated) return Object.freeze({ enabled: false, reason: "履歴上限で古い測定値が削除されたため、CSVは保存できません。 / Earlier measurements were discarded; complete export is unavailable." });
  return Object.freeze({ enabled: true, reason: "" });
}

function numericCell(value, valid) {
  if (!valid || value === null || value === undefined) return "";
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("CSV measurement must be finite numeric data");
  return String(value);
}

/** Synchronous snapshot of the same ring used by review; no CSV measurement store. */
export function createStoppedHistoryCsv(model, ready) {
  const history = model.historySummary();
  if (!csvExportState(history, ready).enabled) throw new Error("stopped complete history is required");
  const records = model.recordSnapshot();
  const streamId = records[0].stream_id;
  const rows = ["elapsed_ms,voltage,current"];
  for (const record of records) {
    if (record.stream_id !== streamId || typeof history.originTimestampUs !== "bigint" || typeof record.timestamp_us !== "bigint"
      || !Number.isInteger(record.valid_mask) || record.valid_mask < 0 || record.valid_mask > 3) throw new TypeError("invalid history record");
    const voltage = numericCell(record.voltage_V, record.valid_mask & 1);
    const current = numericCell(record.current_A, record.valid_mask & 2);
    const elapsed = formatElapsedMilliseconds(record.timestamp_us - history.originTimestampUs);
    rows.push(`${elapsed},${voltage},${current}`);
  }
  return `${rows.join("\r\n")}\r\n`;
}

export function historyCsvFilename(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError("valid filename date required");
  const pad = (value) => String(value).padStart(2, "0");
  return `vameter-viewer-${String(date.getFullYear()).padStart(4, "0")}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.csv`;
}

/** At most one outstanding Blob URL and cleanup timer per application. */
export function createLocalCsvDownload({ document = globalThis.document, urls = globalThis.URL, BlobType = globalThis.Blob, scheduler = globalThis } = {}) {
  let url = null; let timer = null;
  function dispose() {
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = null;
    if (url !== null) urls.revokeObjectURL(url);
    url = null;
  }
  return Object.freeze({
    save(csv, filename) {
      dispose();
      const anchor = document.createElement("a");
      try {
        url = urls.createObjectURL(new BlobType([csv], { type: "text/csv;charset=utf-8" }));
        anchor.href = url; anchor.download = filename; anchor.hidden = true;
        document.body.appendChild(anchor);
        anchor.click();
        // Keep the URL alive beyond the user-activation turn for local download.
        timer = scheduler.setTimeout(dispose, 60_000);
      } catch (error) { dispose(); throw error; }
      finally { anchor.remove(); }
    },
    dispose,
  });
}
