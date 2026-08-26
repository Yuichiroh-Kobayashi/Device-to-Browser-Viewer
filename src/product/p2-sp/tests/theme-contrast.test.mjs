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
 * Every pair that must hold, with the role names spelled out so a failure
 * identifies the exact semantic pair rather than a raw colour.
 */
const REQUIRED_PAIRS = Object.freeze([
  ["text", "surface", TEXT_MINIMUM, "body text on a panel surface"],
  ["text", "page", TEXT_MINIMUM, "body text on the page"],
  ["text-muted", "surface", TEXT_MINIMUM, "secondary text on a panel surface"],
  ["text-muted", "page", TEXT_MINIMUM, "secondary text on the page"],
  ["border", "surface", NON_TEXT_MINIMUM, "panel border against its own surface"],
  ["border", "page", NON_TEXT_MINIMUM, "panel border against the page"],
  ["action-primary-text", "action-primary-surface", TEXT_MINIMUM, "Start label on the primary action"],
  ["action-primary-surface", "page", NON_TEXT_MINIMUM, "primary action boundary against the page"],
  ["action-stop-text", "action-stop-surface", TEXT_MINIMUM, "Stop label on the stop action"],
  ["action-stop-surface", "page", NON_TEXT_MINIMUM, "stop action boundary against the page"],
  ["measure-voltage", "surface", TEXT_MINIMUM, "Voltage identity used as text on a surface"],
  ["measure-voltage", "page", TEXT_MINIMUM, "Voltage identity used as text on the page"],
  ["measure-current", "surface", TEXT_MINIMUM, "Current identity used as text on a surface"],
  ["measure-current", "page", TEXT_MINIMUM, "Current identity used as text on the page"],
  ["status-ready", "surface", TEXT_MINIMUM, "ready status text"],
  ["status-streaming", "surface", TEXT_MINIMUM, "streaming status text"],
  ["status-busy", "surface", TEXT_MINIMUM, "busy status text"],
  ["status-warning", "surface", TEXT_MINIMUM, "warning status text"],
  ["status-recoverable", "surface", TEXT_MINIMUM, "recoverable error text"],
  ["status-fatal", "surface", TEXT_MINIMUM, "fatal error text"],
  ["status-disabled", "surface", TEXT_MINIMUM, "disabled control text"],
  ["focus-inner", "surface", NON_TEXT_MINIMUM, "focus ring against a panel surface"],
  ["focus-inner", "page", NON_TEXT_MINIMUM, "focus ring against the page"],
  ["focus-outer", "focus-inner", NON_TEXT_MINIMUM, "outer focus layer against the inner ring"],
  ["graph-foreground", "graph-background", TEXT_MINIMUM, "graph title and axis tick text"],
  ["graph-muted", "graph-background", TEXT_MINIMUM, "graph no-valid-data text"],
  ["graph-grid", "graph-background", NON_TEXT_MINIMUM, "graph grid line"],
  ["graph-zero-boundary", "graph-background", NON_TEXT_MINIMUM, "graph zero/boundary line"],
  ["graph-voltage-accent", "graph-background", NON_TEXT_MINIMUM, "Voltage waveform"],
  ["graph-current-accent", "graph-background", NON_TEXT_MINIMUM, "Current waveform"],
  ["graph-gap", "graph-background", NON_TEXT_MINIMUM, "gap marker"],
  ["graph-invalid", "graph-background", NON_TEXT_MINIMUM, "invalid-run marker"],
  ["graph-segment", "graph-background", NON_TEXT_MINIMUM, "segment/timebase boundary marker"],
  ["graph-reverse-warning", "graph-background", NON_TEXT_MINIMUM, "reverse-current warning token"],
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

test("channel colour is recorded as supplemental, never as the sole identity", () => {
  // The two channel families sit at near-identical relative luminance, so they
  // are NOT separable by contrast or in grayscale. That is acceptable only
  // because they never share a canvas (single-canvas overlay is an explicit
  // Issue #9 non-goal) and each carries a visible name, unit and graph title.
  // This assertion pins the fact so it cannot be quietly reinterpreted as a
  // colour-only channel discriminator.
  for (const [themeName, table] of [["light", LIGHT], ["dark", DARK_OVERRIDE]]) {
    const ratio = contrastRatio(table.get("graph-voltage-accent"), table.get("graph-current-accent"));
    console.log(`INFO ${themeName} Voltage vs Current = ${ratio.toFixed(2)}:1 — not a required pair; channels are identified by name, unit and separate panel`);
    assert.ok(ratio < NON_TEXT_MINIMUM, "if the channel families ever separate by contrast, revisit this recorded design boundary");
  }
  const student = readFileSync(new URL("../presentation/student-view.js", import.meta.url), "utf8");
  assert.match(student, /電圧 Voltage/);
  assert.match(student, /電流 Current/);
  assert.match(student, /aria-label="Voltage graph"/);
  assert.match(student, /aria-label="Current graph"/);
  const renderer = readFileSync(new URL("../graph/waveform-canvas.js", import.meta.url), "utf8");
  assert.match(renderer, /fillText\(`\$\{this\.title\} \(\$\{this\.unit\}\)`/);
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
