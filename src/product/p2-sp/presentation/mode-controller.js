export class ModeController {
  constructor(owner, { render, deployment }) { this.owner = owner; this.render = render; this.deployment = deployment; this.mode = "student"; }
  setMode(mode) { if (mode !== "student" && mode !== "professional") throw new TypeError("invalid presentation mode"); this.mode = mode; this.render(this.mode, this.owner, this.deployment); }
  toggle() { this.setMode(this.mode === "student" ? "professional" : "student"); }
}
