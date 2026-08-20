import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBoundedActionDiagnostics, createPresentationCoordinator } from "../presentation/mode-controller.js";
import { studentActionEnabled } from "../presentation/student-view.js";
import { professionalMarkup } from "../presentation/professional-view.js";
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const student = readFileSync(new URL("../presentation/student-view.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const openDeployment = Object.freeze({ startAllowed: true });
const blockedDeployment = Object.freeze({ startAllowed: false });
const state = (controlState, pending = {}) => ({ controlState, startPending: false, stopPending: false, ...pending });

assert.match(html, /viewport/);
assert.match(css, /@media\s*\(max-width:\s*599px\)[\s\S]*?\.graphs\s*\{\s*grid-template-columns:\s*1fr;/);
assert.match(css, /@media\s*\(min-width:\s*600px\)\s*and\s*\(max-width:\s*1023px\)[\s\S]*?\.values\s*\{\s*flex-wrap:\s*nowrap;[\s\S]*?\.graphs\s*\{\s*grid-template-columns:\s*1fr;/);
assert.match(css, /@media\s*\(min-width:\s*1024px\)[\s\S]*?\.graphs\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
assert.match(css, /min-height:\s*44px/);
assert.match(css, /focus-visible/);
assert.match(css, /prefers-reduced-motion/);
assert.match(student, /data-live="deployment"/);
assert.match(student, /deploymentNode\.dataset\.deploymentStatus/);
assert.match(student, /deployment\.message/);
assert.match(student, /data-action="\$\{action\}"/);
assert.match(student, /state\.controlState === "CLOSED"/);
assert.match(student, /state\.controlState === "READY"/);
assert.match(student, /state\.controlState === "STREAMING"/);
assert.match(student, /deployment\.startAllowed/);
assert.equal(studentActionEnabled(state("CLOSED"), openDeployment, "open"), true);
assert.equal(studentActionEnabled(state("CLOSED"), openDeployment, "start"), false);
assert.equal(studentActionEnabled(state("CLOSED"), openDeployment, "close"), false);
assert.equal(studentActionEnabled(state("READY"), openDeployment, "start"), true);
assert.equal(studentActionEnabled(state("READY"), blockedDeployment, "start"), false);
assert.equal(studentActionEnabled(state("READY"), blockedDeployment, "close"), true);
assert.equal(studentActionEnabled(state("STREAMING"), openDeployment, "stop"), true);
assert.equal(studentActionEnabled(state("STREAMING"), openDeployment, "close"), false);
assert.equal(studentActionEnabled(state("CONNECTED"), openDeployment, "open"), false);
assert.equal(studentActionEnabled(state("READY", { startPending: true }), openDeployment, "close"), false);
assert.equal(studentActionEnabled(state("READY", { startPending: true }), openDeployment, "start"), false);
assert.equal(studentActionEnabled(state("STREAMING", { stopPending: true }), openDeployment, "close"), false);
assert.equal(studentActionEnabled(state("STREAMING", { stopPending: true }), openDeployment, "stop"), false);
assert.match(app, /await owner\.actions\[action\]\(\);/);
assert.match(app, /owner\.subscribe\(\(\) => presentation\.update\(\)\)/);
assert.doesNotMatch(app, /owner\.subscribe\(\(\) => controller\.setMode/);
assert.doesNotMatch(app, /pointerdown|mousedown|debounce|retry/i);
let mountedControl = null;
let mountCount = 0;
let updateCount = 0;
const stablePresentation = createPresentationCoordinator({
  mount() { mountCount += 1; mountedControl = Object.freeze({ identity: mountCount }); },
  update() { updateCount += 1; },
});
stablePresentation.setMode("student");
const originalControl = mountedControl;
for (let frame = 0; frame < 20; frame += 1) stablePresentation.update();
assert.strictEqual(mountedControl, originalControl);
assert.equal(mountCount, 1);
assert.equal(updateCount, 21);
stablePresentation.setMode("professional");
assert.notStrictEqual(mountedControl, originalControl);
assert.equal(mountCount, 2);
const diagnostics = createBoundedActionDiagnostics(8);
for (let index = 0; index < 20; index += 1) diagnostics.record(index % 2 ? "stop" : "not-a-public-action");
assert.deepEqual(diagnostics.snapshot(), {
  count: 20,
  lastAction: "stop",
  retained: ["unknown", "stop", "unknown", "stop", "unknown", "stop", "unknown", "stop"],
});
const professionalError = professionalMarkup({
  adapter: { summary: () => ({ controlState: "READY", streamId: null, profile: null, diagnosticCount: 1, lastError: { code: "c".repeat(97), message: "m".repeat(513) } }) },
  model: { latest: null, sampleCount: 0, segmentCount: 0, sequenceGapCount: 0, producerOverflowCount: 0, outputQueueDropCount: 0 },
}, { target: "device-hosted", bundleStatus: "matched" });
assert.match(professionalError, /<dt>last error code\/message<\/dt><dd data-live="last-error">c{96} \/ m{512}<\/dd>/);
assert.doesNotMatch(professionalError, /c{97}|m{513}/);
const hostileProfessionalError = professionalMarkup({
  adapter: { summary: () => ({ controlState: "READY", streamId: null, profile: null, diagnosticCount: 1, lastError: { code: "&<>\"'", message: "<img src=x onerror=alert(1)>&\"'" } }) },
  model: { latest: null, sampleCount: 0, segmentCount: 0, sequenceGapCount: 0, producerOverflowCount: 0, outputQueueDropCount: 0 },
}, { target: "device-hosted", bundleStatus: "matched" });
assert.match(hostileProfessionalError, /<dt>last error code\/message<\/dt><dd data-live="last-error">&amp;&lt;&gt;&quot;&#39; \/ &lt;img src=x onerror=alert\(1\)&gt;&amp;&quot;&#39;<\/dd>/);
assert.doesNotMatch(hostileProfessionalError, /<img\b/);
console.log("PASS responsive compact<=599, medium=600..1023, wide>=1024, Student deployment/action markup, focus, and reduced-motion rules");
