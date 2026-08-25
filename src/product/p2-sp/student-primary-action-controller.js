function waitForState(owner, accept, reject) {
  return new Promise((resolve, rejectPromise) => {
    let unsubscribe = () => {};
    const observe = () => {
      const state = owner.adapter.summary();
      if (accept(state)) {
        unsubscribe();
        resolve(state);
      } else if (reject(state)) {
        unsubscribe();
        rejectPromise(new Error(`Student operation ended in ${state.controlState}`));
      }
    };
    unsubscribe = owner.subscribe(observe);
    observe();
  });
}

export class StudentPrimaryActionController {
  constructor(owner) {
    if (!owner?.actions || !owner?.adapter || typeof owner.subscribe !== "function") throw new TypeError("runtime owner is required");
    this.owner = owner;
    this.inFlight = false;
    this.operationKind = null;
    this.lastAttemptedOperation = null;
    this.studentOpenedTransport = false;
    this.disposed = false;
    this.unsubscribe = owner.subscribe(() => {
      if (owner.adapter.summary().controlState === "CLOSED") this.studentOpenedTransport = false;
    });
  }

  activate(deployment) {
    if (this.inFlight) return Promise.resolve(false);
    const state = this.owner.adapter.summary();
    const operation = state.controlState === "STREAMING" ? "stop" : "start";
    if (operation === "start" && (state.controlState !== "CLOSED" && state.controlState !== "READY")) return Promise.resolve(false);
    if (operation === "start" && deployment?.startAllowed !== true) return Promise.resolve(false);
    if (state.startPending || state.stopPending) return Promise.resolve(false);
    this.inFlight = true;
    this.operationKind = operation;
    this.lastAttemptedOperation = operation;
    return this.#run(operation, state.controlState).finally(() => {
      this.inFlight = false;
      this.operationKind = null;
    });
  }

  async #run(operation, initialState) {
    if (operation === "start") {
      if (initialState === "CLOSED") {
        await this.owner.actions.open();
        this.studentOpenedTransport = true;
        await waitForState(this.owner, (state) => state.controlState === "READY", (state) => state.controlState === "CLOSED");
      }
      await this.owner.actions.start();
      await waitForState(this.owner, (state) => state.controlState === "STREAMING", (state) => state.controlState === "CLOSED");
      return true;
    }
    await this.owner.actions.stop();
    await waitForState(this.owner, (state) => state.controlState === "READY", (state) => state.controlState === "CLOSED");
    if (this.studentOpenedTransport) {
      await this.owner.actions.close();
      this.studentOpenedTransport = false;
    }
    return true;
  }

  snapshot() {
    return Object.freeze({ inFlight: this.inFlight, operationKind: this.operationKind, lastAttemptedOperation: this.lastAttemptedOperation, studentOpenedTransport: this.studentOpenedTransport });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }
}
