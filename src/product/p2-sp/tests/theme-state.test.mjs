import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { studentPrimaryActionState } from "../presentation/student-view.js";
import {
  THEME_MEDIA_QUERY,
  THEME_STATES,
  createThemeController,
  createThemeMediaQuery,
  effectiveTheme,
  nextThemeState,
  themeControlLabel,
  themeControlMarkup,
} from "../presentation/theme-controller.js";

const controllerSource = readFileSync(new URL("../presentation/theme-controller.js", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const openDeployment = Object.freeze({ startAllowed: true });
const blockedDeployment = Object.freeze({ startAllowed: false });
const state = (controlState, pending = {}) => ({ controlState, startPending: false, stopPending: false, ...pending });

/** Minimal prefers-color-scheme authority with a controllable system preference. */
function fakeMedia(matches = false) {
  const listeners = new Set();
  return {
    matches,
    media: THEME_MEDIA_QUERY,
    addEventListener(type, listener) { assert.equal(type, "change"); listeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, "change"); listeners.delete(listener); },
    get listenerCount() { return listeners.size; },
    setSystemPrefersDark(next) { this.matches = next; for (const listener of [...listeners]) listener({ matches: next }); },
  };
}

function fakeRoot() {
  return { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
}

test("theme state vocabulary and pure resolution", () => {
  assert.deepEqual(THEME_STATES, ["system", "light", "dark"]);
  assert.equal(effectiveTheme("system", false), "light");
  assert.equal(effectiveTheme("system", true), "dark");
  assert.equal(effectiveTheme("light", true), "light");
  assert.equal(effectiveTheme("dark", false), "dark");
  assert.throws(() => effectiveTheme("auto", false), TypeError);
  // One activation always moves to the opposite of what is currently shown.
  assert.equal(nextThemeState("system", false), "dark");
  assert.equal(nextThemeState("system", true), "light");
  assert.equal(nextThemeState("light", false), "dark");
  assert.equal(nextThemeState("dark", true), "light");
  assert.equal(themeControlLabel("light"), "ダーク表示 / Dark mode");
  assert.equal(themeControlLabel("dark"), "ライト表示 / Light mode");
  assert.throws(() => themeControlLabel("system"), TypeError);
});

test("fresh construction starts in system and follows prefers-color-scheme", () => {
  const lightMedia = fakeMedia(false);
  const lightRoot = fakeRoot();
  const light = createThemeController({ media: lightMedia, root: lightRoot });
  assert.equal(light.state, "system");
  assert.equal(light.effective, "light");
  assert.equal(lightRoot.attributes["data-theme"], "system");
  assert.equal(lightRoot.attributes["data-effective-theme"], "light");

  const darkMedia = fakeMedia(true);
  const darkRoot = fakeRoot();
  const dark = createThemeController({ media: darkMedia, root: darkRoot });
  assert.equal(dark.state, "system");
  assert.equal(dark.effective, "dark");
  assert.equal(darkRoot.attributes["data-effective-theme"], "dark");

  // A second construction is a fresh page lifetime: always back to system.
  const reloaded = createThemeController({ media: darkMedia, root: fakeRoot() });
  assert.equal(reloaded.state, "system");
  light.dispose(); dark.dispose(); reloaded.dispose();
});

test("live system preference changes update the effective theme only while state is system", () => {
  const media = fakeMedia(false);
  const root = fakeRoot();
  const theme = createThemeController({ media, root });
  let notifications = 0;
  theme.subscribe(() => { notifications += 1; });

  media.setSystemPrefersDark(true);
  assert.equal(theme.state, "system");
  assert.equal(theme.effective, "dark");
  assert.equal(root.attributes["data-effective-theme"], "dark");
  assert.equal(notifications, 1);

  media.setSystemPrefersDark(false);
  assert.equal(theme.effective, "light");
  assert.equal(notifications, 2);

  // Once the learner has chosen explicitly, the system no longer overrides them.
  theme.toggle();
  assert.equal(theme.state, "dark");
  const afterManual = notifications;
  media.setSystemPrefersDark(true);
  assert.equal(theme.state, "dark");
  assert.equal(theme.effective, "dark");
  assert.equal(notifications, afterManual, "system changes must not notify while an explicit override is held");

  theme.dispose();
  assert.equal(media.listenerCount, 0, "dispose must detach the media listener");
  assert.throws(() => theme.toggle(), /disposed/);
});

test("first activation selects the opposite theme and later activations alternate", () => {
  for (const systemPrefersDark of [false, true]) {
    const media = fakeMedia(systemPrefersDark);
    const theme = createThemeController({ media, root: fakeRoot() });
    const opposite = systemPrefersDark ? "light" : "dark";
    const original = systemPrefersDark ? "dark" : "light";
    assert.equal(theme.toggle(), opposite);
    assert.equal(theme.effective, opposite);
    assert.equal(theme.toggle(), original);
    assert.equal(theme.toggle(), opposite);
    assert.equal(theme.toggle(), original);
    theme.dispose();
  }
});

test("the control offers the theme the learner would move to", () => {
  const media = fakeMedia(false);
  const theme = createThemeController({ media, root: fakeRoot() });
  assert.equal(theme.label, "ダーク表示 / Dark mode");
  assert.match(themeControlMarkup(theme.label), /<button type="button" data-theme-toggle>ダーク表示 \/ Dark mode<\/button>/);
  theme.toggle();
  assert.equal(theme.label, "ライト表示 / Light mode");
  assert.match(themeControlMarkup(theme.label), /ライト表示 \/ Light mode/);
  theme.dispose();
});

test("the controller degrades safely without matchMedia or a document root", () => {
  assert.equal(createThemeMediaQuery({}), null);
  assert.equal(createThemeMediaQuery(undefined), null);
  const theme = createThemeController();
  assert.equal(theme.state, "system");
  assert.equal(theme.effective, "light", "absent system authority resolves to the light foundation");
  assert.equal(theme.toggle(), "dark");
  theme.dispose();
});

/** Prose in a doc comment is not an API call; scan executable source only. */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

test("theme state is never persisted and never reaches runtime authority", () => {
  const controllerCode = withoutComments(controllerSource);
  for (const forbidden of [/localStorage/, /sessionStorage/, /document\.cookie/, /indexedDB/, /fetch\(/, /XMLHttpRequest/, /location\.(search|hash)/]) {
    assert.doesNotMatch(controllerCode, forbidden, `theme controller must not use ${forbidden}`);
  }
  // The controller cannot mutate transport, parser, stream identity or model.
  for (const forbidden of [/WebSocket/, /SessionAdapter/, /StreamModel/, /adapter/, /\bowner\b/, /streamId/, /displayWindow/]) {
    assert.doesNotMatch(controllerCode, forbidden, `theme controller must not reference ${forbidden}`);
  }
  assert.doesNotMatch(cssSource, /url\(\s*['"]?https?:/, "no remote CSS asset");
  assert.doesNotMatch(cssSource, /@import/, "no external stylesheet import");
  assert.doesNotMatch(indexSource, /https?:\/\//, "no remote asset in the entry document");
});

test("the application owns one theme controller and never rebuilds it per view", () => {
  assert.match(appSource, /const theme = createThemeController\(\{ media: themeMedia, root: themeRoot \}\);/);
  // Constructed once at application scope, above mount/update.
  assert.equal((appSource.match(/createThemeController\(/g) ?? []).length, 1);
  assert.ok(appSource.indexOf("const theme = createThemeController") < appSource.indexOf("function mount("));
  // The click handler does exactly one thing.
  assert.match(appSource, /themeButton\.onclick = \(\) => theme\.toggle\(\);/);
  // A theme change relabels the mounted control and repaints; it never remounts.
  assert.match(appSource, /theme\.subscribe\(\(\) => \{ syncThemeControl\(\); waveformRender\.request\(\); \}\)/);
  assert.doesNotMatch(appSource, /theme\.subscribe\([^)]*presentation\.setMode/);
  assert.match(appSource, /themeButton\.textContent = theme\.label;/);
  assert.match(appSource, /theme\.dispose\(\);/);
});

test("interaction contract: native button, visible text, 44x44 minimum target", () => {
  const markup = themeControlMarkup("ダーク表示 / Dark mode");
  // Native <button> semantics carry click, touch, Enter and Space activation
  // and the implicit button role; no synthetic key or pointer handling exists.
  assert.match(markup, /<button type="button"/);
  assert.doesNotMatch(markup, /role=|onkeydown|onkeypress|tabindex/);
  assert.doesNotMatch(appSource, /keydown|keypress|pointerdown|touchstart/i);
  assert.match(markup, />[^<]+</, "the control carries visible text");
  assert.match(cssSource, /button \{[^}]*min-width: 44px;[^}]*min-height: 44px;/);
  assert.match(cssSource, /\.theme-control button \{/);
});

test("the theme control leads the layout but stays visually secondary to Start/Stop", () => {
  // N-01: mounted first so it is inside the initial 768x1024 portrait viewport,
  // in both Student and Professional.
  assert.ok(appSource.indexOf("themeControlMarkup(theme.label)") < appSource.indexOf("studentMarkup()"));
  assert.equal((appSource.match(/themeControlMarkup\(theme\.label\)/g) ?? []).length, 2, "both mount branches carry the control");
  // Hierarchy is carried by size and prominence, not by document order: the
  // primary action is full width and taller, the theme control is compact.
  assert.match(cssSource, /\.primary-action button \{ width: 100%; min-height: 52px; font-size: 1\.125rem; font-weight: 700;/);
  assert.match(cssSource, /\.theme-control \{ display: flex; justify-content: flex-end;/);
  assert.match(cssSource, /\.theme-control button \{ font-weight: 600; font-size: \.9375rem; \}/);
  // The theme control is not part of the Student measurement markup, so it can
  // never be confused for the measurement action.
  const student = readFileSync(new URL("../presentation/student-view.js", import.meta.url), "utf8");
  assert.doesNotMatch(student, /data-theme-toggle/);
});

test("the Stop role is derived from runtime state and consumes the Stop tokens", () => {
  // B-01: the semantic action kind, not the localized label, drives presentation.
  assert.equal(studentPrimaryActionState(state("STREAMING"), openDeployment, { inFlight: false }).kind, "stop");
  assert.equal(studentPrimaryActionState(state("CLOSED"), openDeployment, { inFlight: false }).kind, "start");
  assert.equal(studentPrimaryActionState(state("READY"), blockedDeployment, { inFlight: false }).kind, "disabled");
  assert.equal(studentPrimaryActionState(state("READY"), openDeployment, { inFlight: true, operationKind: "stop" }).kind, "busy");
  assert.equal(studentPrimaryActionState(state("READY", { startPending: true }), openDeployment, { inFlight: false }).kind, "busy");
  assert.equal(studentPrimaryActionState(state("CONNECTED"), openDeployment, { inFlight: false }).kind, "busy");
  assert.match(cssSource, /\.primary-action button\[data-action-kind="stop"\] \{ color: var\(--action-stop-text\); background: var\(--action-stop-surface\); border-color: var\(--action-stop-surface\); \}/);
  assert.match(cssSource, /\.primary-action button\[data-action-kind="start"\] \{ color: var\(--action-primary-text\); background: var\(--action-primary-surface\)/);
  assert.match(cssSource, /\.primary-action button\[data-action-kind="busy"\] \{ color: var\(--status-busy\)/);
  assert.match(cssSource, /\.primary-action button\[data-action-kind="disabled"\] \{ color: var\(--surface\); background: var\(--status-disabled\)/);
});

test("stylesheet exposes system following, both overrides, focus and forced-colors", () => {
  assert.match(cssSource, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/);
  assert.match(cssSource, /:root\[data-theme="dark"\] \{\s*color-scheme: dark;/);
  assert.match(cssSource, /:root\[data-theme="light"\] \{ color-scheme: light; \}/);
  assert.match(cssSource, /:root \{\s*color-scheme: light dark;/);
  assert.match(cssSource, /button:focus-visible \{ outline: 3px solid var\(--focus-inner\); outline-offset: 2px; box-shadow: 0 0 0 6px var\(--focus-outer\); \}/);
  assert.match(cssSource, /@media \(forced-colors: active\)[\s\S]*?outline: 3px solid Highlight/);
  assert.match(cssSource, /@media \(forced-colors: active\)[\s\S]*?CanvasText/);
  assert.match(cssSource, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(indexSource, /<meta name="color-scheme" content="light dark">/);
});
