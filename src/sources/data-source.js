/**
 * Minimal evented source contract shared by synthetic, capture, and WebSocket
 * sources. Each registration replaces the previous callback and returns a safe
 * disposer, so UI reconfiguration cannot accumulate listeners.
 */
export class DataSource {
  constructor(kind) {
    this.kind = kind;
    this.state = "closed";
    this._callbacks = { control: null, binary: null, status: null, error: null };
  }

  onControl(callback) { return this._replaceCallback("control", callback); }
  onBinary(callback) { return this._replaceCallback("binary", callback); }
  onStatus(callback) { return this._replaceCallback("status", callback); }
  onError(callback) { return this._replaceCallback("error", callback); }

  _replaceCallback(name, callback) {
    const value = typeof callback === "function" ? callback : null;
    this._callbacks[name] = value;
    return () => {
      if (this._callbacks[name] === value) this._callbacks[name] = null;
    };
  }

  _emitControl(direction, text) {
    this._callbacks.control?.({ direction, text });
  }

  _emitBinary(buffer) {
    this._callbacks.binary?.(buffer);
  }

  _emitStatus(state, detail = undefined) {
    this.state = state;
    const event = { source: this.kind, state };
    if (detail !== undefined) event.detail = String(detail).slice(0, 512);
    this._callbacks.status?.(Object.freeze(event));
  }

  _emitError(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this._callbacks.error?.(normalized);
  }

  async open() {
    if (this.state === "open") return;
    this._emitStatus("open");
  }

  async start() {
    // Concrete sources own start behavior.
  }

  async stop() {
    // Concrete sources own stop behavior.
  }

  async close() {
    if (this.state === "closed") return;
    this._emitStatus("closed");
  }
}
