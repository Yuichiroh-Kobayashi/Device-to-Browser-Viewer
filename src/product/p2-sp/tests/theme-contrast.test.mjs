import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * WCAG 2.2 contrast evidence for the Issue #9 semantic tokens.
 *
 * Tokens are read out of app.css so the stylesheet stays the single source of
 * truth and this suite cannot silently drift from what ships. The maths is the
 * WCAG relative-luminance / contrast-ratio definition implemented locally; no
 * package dependency and no Viewer runtime are involved.
 *
 * Claim boundary: these are CUD-informed candidate colours whose specified
 * pairs target WCAG 2.2 SC 1.4.3 and 1.4.11. This is not CUDO verification,
 * CUD certification, or whole-Viewer WCAG 2.2 conformance.
 */

const cssSource = readFileSync(new URL("../app.css", import.meta.url), "utf8");

const TEXT_MINIMUM = 4.5;
const NON_TEXT_MINIMUM = 3.0;

function channel(value) {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new TypeError(`expected a six-digit hex colour, received ${hex}`);
  const value = Number.parseInt(match[1], 16);
  return 0.2126 * channel((value >> 16) & 255) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255);
}

export function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

function block(pattern, label) {
  const match = pattern.exec(cssSource);
  if (!match) throw new Error(`app.css is missing the ${label} token block`);
  return match[1];
}

function tokens(declarations) {
  const parsed = new Map();
  for (const [, name, value] of declarations.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) parsed.set(name, value.toLowerCase());
  return parsed;
}

const LIGHT = tokens(block(/:root \{\s*color-scheme: light dark;([^}]*)\}/, "light foundation"));
const DARK_MEDIA = tokens(block(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/, "system dark"));
const DARK_OVERRIDE = tokens(block(/:root\[data-theme="dark"\] \{\s*color-scheme: dark;([^}]*)\}/, "manual dark override"));

/**
 * ACTIVE pairs: roles the shipped UI actually renders today, each paired with
 * the background it is actually drawn on. The purpose string names the real
 * rendering context so a failure points at the surface, not just at a token.
 */
const REQUIRED_PAIRS = Object.freeze([
  // Page and panel chrome.
  ["text", "surface", TEXT_MINIMUM, "body text inside a panel (.values output / .graphs section / .professional-diagnostics)"],
  ["text", "page", TEXT_MINIMUM, "body text directly on the page background"],
  ["text-muted", "surface", TEXT_MINIMUM, "quality line text on a panel"],
  ["text-muted", "page", TEXT_MINIMUM, "quality line text on the page"],
  ["border", "surface", NON_TEXT_MINIMUM, "panel border against the panel it encloses"],
  ["border", "page", NON_TEXT_MINIMUM, "panel border against the page behind it"],
  // Primary action, in each semantic role the button can take.
  ["action-primary-text", "action-primary-surface", TEXT_MINIMUM, "Start label on the Start surface (data-action-kind=start)"],
  ["action-primary-surface", "page", NON_TEXT_MINIMUM, "Start button boundary against the page"],
  ["action-stop-text", "action-stop-surface", TEXT_MINIMUM, "Stop label on the Stop surface (data-action-kind=stop)"],
  ["action-stop-surface", "page", NON_TEXT_MINIMUM, "Stop button boundary against the page"],
  ["status-busy", "surface", TEXT_MINIMUM, "busy label on the busy surface (data-action-kind=busy)"],
  ["status-busy", "page", NON_TEXT_MINIMUM, "busy button border against the page"],
  ["surface", "status-disabled", TEXT_MINIMUM, "disabled label on the disabled surface (data-action-kind=disabled)"],
  ["status-disabled", "page", NON_TEXT_MINIMUM, "disabled button boundary against the page"],
  // Secondary controls: theme toggle, mode toggle, display-window select.
  ["text", "surface", TEXT_MINIMUM, "secondary button and select label on their own surface"],
  // Measurement identity used as text in the value panels.
  ["measure-voltage", "surface", NON_TEXT_MINIMUM, "Voltage value-panel accent rule against the panel"],
  ["measure-current", "surface", NON_TEXT_MINIMUM, "Current value-panel accent rule against the panel"],
  ["measure-voltage", "page", NON_TEXT_MINIMUM, "Voltage accent rule against the page"],
  ["measure-current", "page", NON_TEXT_MINIMUM, "Current accent rule against the page"],
  // Deployment and error status text, on the panel/page they render against.
  ["status-ready", "page", TEXT_MINIMUM, "matched deployment status text"],
  ["status-fatal", "page", TEXT_MINIMUM, "unknown/mismatched deployment status text"],
  ["status-recoverable", "page", TEXT_MINIMUM, "non-empty error line text"],
  ["status-ready", "surface", TEXT_MINIMUM, "matched deployment status text on a panel"],
  ["status-fatal", "surface", TEXT_MINIMUM, "unknown/mismatched deployment status text on a panel"],
  ["status-recoverable", "surface", TEXT_MINIMUM, "error line text on a panel"],
  // Focus, against both grounds a focusable control can sit on.
  ["focus-inner", "surface", NON_TEXT_MINIMUM, "focus ring against a panel"],
  ["focus-inner", "page", NON_TEXT_MINIMUM, "focus ring against the page"],
  ["focus-outer", "focus-inner", NON_TEXT_MINIMUM, "outer focus layer against the inner ring"],
  // Canvas text: drawn by the renderer onto --graph-background.
  ["graph-foreground", "graph-background", TEXT_MINIMUM, "graph title, scale readout and axis tick text"],
  ["graph-muted", "graph-background", TEXT_MINIMUM, "graph no-valid-data text"],
  ["graph-gap", "graph-background", TEXT_MINIMUM, "GAP <n> marker label text on the canvas"],
  ["graph-segment", "graph-background", TEXT_MINIMUM, "SEGMENT marker label text on the canvas"],
  // Canvas geometry: required graphical information on --graph-background.
  ["graph-grid", "graph-background", NON_TEXT_MINIMUM, "graph grid line"],
  ["graph-zero-boundary", "graph-background", NON_TEXT_MINIMUM, "graph zero/boundary line"],
  ["graph-voltage-accent", "graph-background", NON_TEXT_MINIMUM, "Voltage waveform stroke"],
  ["graph-current-accent", "graph-background", NON_TEXT_MINIMUM, "Current waveform stroke"],
  ["graph-gap", "graph-background", NON_TEXT_MINIMUM, "gap marker rule"],
  ["graph-segment", "graph-background", NON_TEXT_MINIMUM, "segment/timebase boundary marker rule"],
  ["graph-invalid", "graph-background", NON_TEXT_MINIMUM, "invalid-run baseline marker"],
]);

/**
 * RESERVED roles: defined in the semantic palette but NOT rendered by current
 * product UI. They are validated so the palette stays ready, and are listed
 * here explicitly so no document can claim the UI already consumes them.
 */
const RESERVED_ROLES = Object.freeze(["status-streaming", "status-warning", "graph-reverse-warning"]);
const RESERVED_PAIRS = Object.freeze([
  ["status-streaming", "surface", TEXT_MINIMUM, "reserved streaming status text"],
  ["status-streaming", "page", TEXT_MINIMUM, "reserved streaming status text on the page"],
  ["status-warning", "surface", TEXT_MINIMUM, "reserved warning status text"],
  ["status-warning", "page", TEXT_MINIMUM, "reserved warning status text on the page"],
  ["graph-reverse-warning", "graph-background", NON_TEXT_MINIMUM, "reserved reverse-current warning mark"],
]);

/**
 * Marker-to-marker and marker-to-waveform ratios are recorded, not gated.
 * Each of these elements is a separate mark read against the shared canvas
 * ground -- and each already clears 3:1 against it in REQUIRED_PAIRS. They are
 * not adjacent to one another in the SC 1.4.11 sense, and on a dark ground
 * there is no luminance headroom to separate two marks from the background and
 * from each other without making one of them faint. Their distinguishability
 * is carried by non-colour cues (dash pattern, label text, orientation), which
 * the "gap, invalid and segment keep distinct non-colour cues" test enforces.
 */
const RECORDED_MARK_PAIRS = Object.freeze([
  ["graph-gap", "graph-segment", "gap marker against segment boundary marker"],
  ["graph-gap", "graph-voltage-accent", "gap marker against the Voltage waveform"],
  ["graph-segment", "graph-current-accent", "segment marker against the Current waveform"],
]);

function report(themeName, table) {
  const lines = [];
  let worst = Infinity;
  for (const [foreground, background, minimum, purpose] of REQUIRED_PAIRS) {
    const from = table.get(foreground);
    const to = table.get(background);
    assert.ok(from, `${themeName}: app.css does not declare --${foreground}`);
    assert.ok(to, `${themeName}: app.css does not declare --${background}`);
    const ratio = contrastRatio(from, to);
    worst = Math.min(worst, ratio - minimum);
    lines.push(`${ratio >= minimum ? "PASS" : "FAIL"} ${themeName} --${foreground} (${from}) on --${background} (${to}) = ${ratio.toFixed(2)}:1, required ${minimum.toFixed(1)}:1 — ${purpose}`);
    assert.ok(
      ratio >= minimum,
      `${themeName} contrast failure: --${foreground} (${from}) on --${background} (${to}) is ${ratio.toFixed(2)}:1, below the required ${minimum.toFixed(1)}:1 for ${purpose}`,
    );
  }
  return { lines, worst };
}

test("light theme required pairs meet the WCAG 2.2 targets", () => {
  const { lines, worst } = report("light", LIGHT);
  for (const line of lines) console.log(line);
  console.log(`light: ${lines.length} required pairs pass; smallest margin above requirement = ${worst.toFixed(2)}`);
});

test("dark theme required pairs meet the WCAG 2.2 targets", () => {
  const { lines, worst } = report("dark", DARK_OVERRIDE);
  for (const line of lines) console.log(line);
  console.log(`dark: ${lines.length} required pairs pass; smallest margin above requirement = ${worst.toFixed(2)}`);
});

test("marker separation is carried by non-colour cues, and the ratios are recorded", () => {
  for (const [themeName, table] of [["light", LIGHT], ["dark", DARK_OVERRIDE]]) {
    for (const [first, second, purpose] of RECORDED_MARK_PAIRS) {
      const ratio = contrastRatio(table.get(first), table.get(second));
      console.log(`INFO ${themeName} --${first} vs --${second} = ${ratio.toFixed(2)}:1 — ${purpose}; not a required pair, both clear ${NON_TEXT_MINIMUM.toFixed(1)}:1 against the canvas ground`);
    }
    // What is required: each mark is distinguishable from the ground it is
    // drawn on, and gap/segment carry different tokens as well as different
    // dash patterns and labels.
    for (const role of ["graph-gap", "graph-segment", "graph-invalid"]) {
      assert.ok(contrastRatio(table.get(role), table.get("graph-background")) >= NON_TEXT_MINIMUM, `${themeName}: --${role} must clear ${NON_TEXT_MINIMUM}:1 against --graph-background`);
    }
    assert.notEqual(table.get("graph-gap"), table.get("graph-segment"), `${themeName}: gap and segment must not share one token`);
    assert.notEqual(table.get("graph-gap"), table.get("graph-invalid"), `${themeName}: gap and invalid must not share one token`);
  }
});

test("the system dark block and the manual dark override are the same palette", () => {
  assert.deepEqual([...DARK_MEDIA.keys()].sort(), [...DARK_OVERRIDE.keys()].sort(), "system-dark and manual-dark declare different token sets");
  for (const [name, value] of DARK_OVERRIDE) {
    assert.equal(DARK_MEDIA.get(name), value, `--${name} differs between the system dark block and the manual dark override`);
  }
  // Light and dark must cover exactly the same semantic roles.
  assert.deepEqual([...LIGHT.keys()].sort(), [...DARK_OVERRIDE.keys()].sort(), "light and dark declare different token sets");
});

test("reserved roles are validated as palette, and are not claimed as rendered", () => {
  for (const [themeName, table] of [["light", LIGHT], ["dark", DARK_OVERRIDE]]) {
    for (const [foreground, background, minimum, purpose] of RESERVED_PAIRS) {
      const ratio = contrastRatio(table.get(foreground), table.get(background));
      console.log(`RESERVED ${themeName} --${foreground} on --${background} = ${ratio.toFixed(2)}:1, target ${minimum.toFixed(1)}:1 — ${purpose}`);
      assert.ok(ratio >= minimum, `${themeName} reserved role --${foreground} on --${background} is ${ratio.toFixed(2)}:1, below ${minimum.toFixed(1)}:1`);
    }
  }
  // A reserved role must NOT be referenced by a presentation rule or by the
  // renderer. If one becomes consumed, it has to move into REQUIRED_PAIRS and
  // be documented as active rather than silently gaining a claim.
  const rules = presentationRules();
  const renderer = readFileSync(new URL("../graph/waveform-canvas.js", import.meta.url), "utf8");
  for (const role of RESERVED_ROLES) {
    assert.ok(!rules.includes(`var(--${role})`), `--${role} is documented as reserved but a CSS rule consumes it`);
    const graphRole = role.startsWith("graph-") ? role.slice("graph-".length) : null;
    if (graphRole) assert.ok(!renderer.includes(`"${graphRole}"`), `--${role} is documented as reserved but the renderer consumes it`);
  }
});

/** The stylesheet with the token-definition blocks removed: what actually renders. */
function presentationRules() {
  return cssSource
    .replace(/:root \{\s*color-scheme: light dark;[^}]*\}/, "")
    .replace(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{[^}]*\}\s*\}/, "")
    .replace(/:root\[data-theme="dark"\] \{\s*color-scheme: dark;[^}]*\}/, "");
}

test("every active role is actually consumed by a rule or by the renderer", () => {
  const rules = presentationRules();
  const renderer = readFileSync(new URL("../graph/waveform-canvas.js", import.meta.url), "utf8");
  // Token definitions must be gone, so a match below is a real consumption.
  assert.doesNotMatch(rules, /--page: #/, "token definition blocks were not stripped");

  const cssConsumed = [
    "page", "surface", "text", "text-muted", "border",
    "action-primary-surface", "action-primary-text",
    "action-stop-surface", "action-stop-text",
    "status-busy", "status-disabled", "status-ready", "status-fatal", "status-recoverable",
    "measure-voltage", "measure-current",
    "graph-background", "focus-inner", "focus-outer",
  ];
  for (const role of cssConsumed) {
    assert.ok(rules.includes(`var(--${role})`), `no presentation rule consumes --${role}`);
  }
  // Collect the role literals the renderer actually passes to
  // style(canvas, role, fallback), including the ones behind a ternary.
  const resolvedGraphRoles = new Set();
  for (const [, args] of renderer.matchAll(/style\(this\.canvas,([^)]*)\)/g)) {
    for (const [, role] of args.matchAll(/"([a-z-]+)"/g)) resolvedGraphRoles.add(role);
  }
  for (const role of ["background", "foreground", "grid", "zero-boundary", "voltage-accent", "current-accent", "gap", "invalid", "segment", "muted"]) {
    assert.ok(resolvedGraphRoles.has(role), `the renderer never resolves --graph-${role} (resolved: ${[...resolvedGraphRoles].join(", ")})`);
  }
  // The Stop role must be reachable from runtime state, not from label text.
  // studentPrimaryActionState and the button update now live in the shared
  // measurement workspace (Student and Professional both drive the Stop role
  // from the same runtime state, not from a per-view copy).
  const workspaceView = readFileSync(new URL("../presentation/measurement-workspace.js", import.meta.url), "utf8");
  assert.match(workspaceView, /controlState === "STREAMING"\) return Object\.freeze\(\{ enabled: true, busy: false, kind: "stop"/);
  assert.match(workspaceView, /button\.dataset\.actionKind = primaryState\.kind;/);
  assert.match(rules, /\.primary-action button\[data-action-kind="stop"\] \{ color: var\(--action-stop-text\); background: var\(--action-stop-surface\)/);
  assert.doesNotMatch(rules, /測定終了|Stop"\]/, "presentation must not key off localized label text");
});

test("every required semantic role namespace is declared in both themes", () => {
  const required = [
    "page", "surface", "text", "text-muted", "border",
    "action-primary-surface", "action-primary-text", "action-stop-surface", "action-stop-text",
    "measure-voltage", "measure-current",
    "graph-background", "graph-foreground", "graph-grid", "graph-zero-boundary",
    "graph-voltage-accent", "graph-current-accent", "graph-gap", "graph-invalid", "graph-segment",
    "status-ready", "status-streaming", "status-busy", "status-warning",
    "status-recoverable", "status-fatal", "status-disabled",
    "focus-inner", "focus-outer",
  ];
  for (const name of required) {
    assert.ok(LIGHT.has(name), `light theme is missing the --${name} role token`);
    assert.ok(DARK_OVERRIDE.has(name), `dark theme is missing the --${name} role token`);
  }
});

test("the Issue #9 channel colour candidates are carried without substitution", () => {
  assert.equal(LIGHT.get("measure-voltage"), "#005aff");
  assert.equal(LIGHT.get("measure-current"), "#8a5a00");
  assert.equal(LIGHT.get("graph-voltage-accent"), "#005aff");
  assert.equal(LIGHT.get("graph-current-accent"), "#8a5a00");
  assert.equal(DARK_OVERRIDE.get("measure-voltage"), "#4dc4ff");
  assert.equal(DARK_OVERRIDE.get("measure-current"), "#f6aa00");
  assert.equal(DARK_OVERRIDE.get("graph-voltage-accent"), "#4dc4ff");
  assert.equal(DARK_OVERRIDE.get("graph-current-accent"), "#f6aa00");
});

test("channel identity never depends on colour alone", () => {
  // The Issue #9 invariant is that Voltage and Current stay identifiable with
  // colour removed. Mutual channel contrast is NOT an invariant in either
  // direction: it is recorded below as diagnostic evidence only, so a future
  // palette improvement that happens to separate the families can never fail
  // this suite.
  for (const [themeName, table] of [["light", LIGHT], ["dark", DARK_OVERRIDE]]) {
    const ratio = contrastRatio(table.get("graph-voltage-accent"), table.get("graph-current-accent"));
    console.log(`INFO ${themeName} Voltage vs Current = ${ratio.toFixed(2)}:1 — diagnostic only, not gated in either direction`);
  }
  // The required, gated identity carriers: now drawn once by the shared
  // measurement workspace, which both Student and Professional mount.
  const workspace = readFileSync(new URL("../presentation/measurement-workspace.js", import.meta.url), "utf8");
  assert.match(workspace, /電圧 Voltage/, "Voltage needs a visible channel name");
  assert.match(workspace, /電流 Current/, "Current needs a visible channel name");
  assert.match(workspace, /aria-label="Voltage graph"/, "Voltage needs its own labelled panel");
  assert.match(workspace, /aria-label="Current graph"/, "Current needs its own labelled panel");
  assert.match(workspace, /data-graph-panel="voltage"/);
  assert.match(workspace, /data-graph-panel="current"/);
  const renderer = readFileSync(new URL("../graph/waveform-canvas.js", import.meta.url), "utf8");
  // Title and unit are drawn onto each canvas.
  assert.match(renderer, /fillText\(`\$\{this\.title\} \(\$\{this\.unit\}\)`/);
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /channel: "voltage", unit: "V", title: "Voltage"/);
  assert.match(app, /channel: "current", unit: "A", title: "Current"/);
});

test("gap, invalid and segment keep distinct non-colour cues", () => {
  const renderer = readFileSync(new URL("../graph/waveform-canvas.js", import.meta.url), "utf8");
  // Gap and segment differ by dash pattern as well as by token and by label.
  assert.match(renderer, /const isGap = marker\.kind === "sequence-gap";/);
  assert.match(renderer, /c\.setLineDash\(isGap \? \[3, 3\] : \[1, 4\]\)/);
  assert.match(renderer, /isGap \? style\(this\.canvas, "gap", "#c58cff"\) : style\(this\.canvas, "segment", "#9eadbf"\)/);
  assert.match(renderer, /`GAP \$\{marker\.gap_samples\}`/);
  assert.match(renderer, /: "SEGMENT"/);
  // An invalid run keeps a drawn marker; it is never rendered as a zero value.
  assert.match(renderer, /for \(const entry of frame\.invalid\) \{ const x = xOf\(entry\.seconds\); c\.fillRect\(/);
  assert.doesNotMatch(renderer, /invalid[^\n]*\?\s*0\s*:/);
});
