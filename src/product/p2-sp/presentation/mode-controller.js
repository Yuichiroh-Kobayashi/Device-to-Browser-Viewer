export class ModeController {
  constructor(owner, { render, deployment }) { this.owner = owner; this.render = render; this.deployment = deployment; this.mode = "student"; }
  setMode(mode) { if (mode !== "student" && mode !== "professional") throw new TypeError("invalid presentation mode"); this.mode = mode; this.render(this.mode, this.owner, this.deployment); }
  toggle() { this.setMode(this.mode === "student" ? "professional" : "student"); }
}

export function createBoundedActionDiagnostics(capacity = 8) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 32) throw new RangeError("action diagnostic capacity must be 1 through 32");
  const entries = [];
  let count = 0;
  return Object.freeze({
    record(action) {
      const safeAction = ["open", "start", "stop", "close"].includes(action) ? action : "unknown";
      count += 1;
      entries.push(safeAction);
      if (entries.length > capacity) entries.shift();
    },
    snapshot() {
      return Object.freeze({ count, lastAction: entries.at(-1) ?? "none", retained: Object.freeze([...entries]) });
    },
  });
}

export function createPresentationCoordinator({ mount, update }) {
  if (typeof mount !== "function" || typeof update !== "function") throw new TypeError("presentation mount and update callbacks are required");
  let mountedMode = null;
  return Object.freeze({
    setMode(mode) {
      if (mode !== "student" && mode !== "professional") throw new TypeError("invalid presentation mode");
      if (mountedMode !== mode) {
        mount(mode);
        mountedMode = mode;
      }
      update(mode);
    },
    update() { if (mountedMode !== null) update(mountedMode); },
    get mountedMode() { return mountedMode; },
  });
}

export function createAnimationFrameQueue(scheduler, render) {
  const requestAnimationFrame = scheduler?.requestAnimationFrame?.bind(scheduler);
  const cancelAnimationFrame = scheduler?.cancelAnimationFrame?.bind(scheduler);
  if (!requestAnimationFrame || !cancelAnimationFrame || typeof render !== "function") {
    throw new TypeError("animation frame scheduler and render callback are required");
  }
  let pending = null;
  return Object.freeze({
    request() {
      if (pending !== null) return;
      pending = requestAnimationFrame(() => {
        pending = null;
        render();
      });
    },
    cancel() {
      if (pending === null) return;
      cancelAnimationFrame(pending);
      pending = null;
    },
    get isPending() { return pending !== null; },
  });
}
