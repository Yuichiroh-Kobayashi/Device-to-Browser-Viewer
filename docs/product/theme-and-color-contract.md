# Post-beta.1 Viewer theme and colour contract

This document records the presentation contract added for
[Device-to-Browser-Viewer Issue #9](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/9).
It describes post-beta.1 product source under
[`src/product/p2-sp/`](../../src/product/p2-sp/) only. The published
`v2.0.0-beta.1` bundle remains immutable and is not changed by this contract;
see [`beta1-device-hosted-viewer-contract.md`](beta1-device-hosted-viewer-contract.md).

This is presentation only. It changes no measurement value, validity rule,
calibration, unit, scale policy, D2B control or binary semantics, CSV output,
or WebSocket behaviour.

## Theme state

The application owns exactly three theme states for the lifetime of one page:

| state | meaning |
| --- | --- |
| `system` | initial state on every construction; follows `prefers-color-scheme` |
| `light` | explicit page-lifetime override |
| `dark` | explicit page-lifetime override |

- Every fresh application construction starts in `system`.
- While the state is `system`, a browser/OS colour-scheme change updates the
  effective theme during the page lifetime, without a reload and without
  rebuilding runtime state.
- The first activation of the visible control moves from `system` to the
  opposite of the theme currently shown. Later activations alternate `light`
  and `dark`.
- The override is **not persisted**. No `localStorage`, `sessionStorage`,
  cookie, URL/query, server state, or device NVS is written or read. Reload
  returns to `system`, so a shared classroom device never inherits a previous
  learner's choice.

Theme state belongs to application lifetime. It is not owned by
`WebSocketSource`, `SessionAdapter`, `StreamModel`, the D2B stream, or a single
Student/Professional view instance. A Student/Professional remount may recreate
the visible control node, but the theme state survives it; live-frame
presentation updates relabel the mounted control and never replace it.

Implementation: [`src/product/p2-sp/presentation/theme-controller.js`](../../src/product/p2-sp/presentation/theme-controller.js),
constructed once per application in [`src/product/p2-sp/app.js`](../../src/product/p2-sp/app.js).

## Interaction

- One native `<button>`, secondary to the Student Start/Stop measurement control
  and mounted after it.
- Visible text naming the theme the learner would move to
  (`ダーク表示 / Dark mode`, `ライト表示 / Light mode`); any icon is redundant
  decoration only.
- Minimum 44 x 44 CSS px target.
- Operable by pointer, touch, Enter and Space through native button semantics;
  no synthetic key or pointer handling exists.

## Runtime isolation

A theme change performs, by construction:

- zero WebSocket constructor, `send`, or `close` operations;
- zero parser or model reset, and no `stream_id` change;
- no reconnect, no stream restart, and no deployment re-bootstrap;
- no change to the 10/30/60-second device-time display window;
- no Student/Professional mode change and no second runtime owner.

The theme controller holds no reference to transport, adapter or model, which is
enforced by a source scan as well as by behavioural tests.

## Semantic token architecture

Presentation rules consume semantic role tokens, not raw colours. The roles
cover page/surface/text/border, primary and stop actions, Voltage and Current
measurement identity, graph background/foreground/grid/zero/gap/invalid/segment,
status ready/streaming/busy/warning/recoverable-error/fatal-error/disabled, and
focus.

Light is the declared foundation in `:root`. The dark foundation applies through
`@media (prefers-color-scheme: dark)` while no explicit override is held, and
through `:root[data-theme="dark"]` for a manual override; `color-scheme` is set
per state so native controls follow. Student and Professional use the same
semantic meanings — information density may differ, colour meaning may not.

Channel colour families (CUDO-informed candidates carried without substitution):

| role | light | dark |
| --- | --- | --- |
| Voltage | `#005AFF` | `#4DC4FF` |
| Current | `#8A5A00` | `#F6AA00` |

## Contrast target

For both effective themes, every pair listed in
[`src/product/p2-sp/tests/theme-contrast.test.mjs`](../../src/product/p2-sp/tests/theme-contrast.test.mjs)
is checked against:

- normally presented text: >= 4.5:1 against its actual background;
- required non-text UI and graphical information: >= 3:1 against adjacent colours.

Token values are parsed out of `app.css` by that suite, so the stylesheet stays
the single source of truth and the evidence cannot drift from what ships. The
contrast maths is a local implementation of the WCAG relative-luminance and
contrast-ratio definitions; no package dependency and no Viewer runtime are
involved.

## Non-colour redundancy

Colour is never the only authority:

- Voltage and Current keep a visible channel name, unit, and graph title/panel
  context;
- a gap remains a path break, drawn with a `[3, 3]` dashed rule and `GAP <n>`
  text;
- a segment/timebase boundary is distinguished from a gap by a different
  `[1, 4]` dotted rule and `SEGMENT` text, not by colour;
- an invalid run is never drawn as a fabricated zero: the path breaks and a
  compact baseline marker is drawn;
- warning, recoverable and fatal states carry visible semantic text;
- Start/Stop carries visible action text.

No red/green pair is used as the sole discriminator for Start/Stop, channel
identity, good/bad, or safe/error.

The two channel families sit at near-identical relative luminance, so they do
not separate from each other by contrast or in grayscale. That is acceptable
only because they never share a canvas — a single-canvas Voltage/Current overlay
is an explicit Issue #9 non-goal — and each carries its own name, unit and graph
title. The ratio is recorded by the contrast suite so it cannot later be
reinterpreted as a colour-only channel discriminator.

Marker-to-marker and marker-to-waveform ratios are likewise recorded rather than
gated: each mark clears 3:1 against the shared canvas ground, they are not
adjacent to one another, and their distinguishability is carried by dash pattern
and label text.

## Focus, forced colours and motion

- A two-layer focus indicator (`outline` plus an outer `box-shadow` ring) is
  drawn from the `--focus-inner` / `--focus-outer` tokens.
- Under `forced-colors: active`, authored surfaces hand back to the system
  palette (`CanvasText`, `ButtonFace`, `ButtonText`) and focus uses `Highlight`,
  so Windows/Edge high-contrast users never depend on the authored tokens.
- `prefers-reduced-motion: reduce` continues to disable transitions and
  animations. No decorative per-frame animation carries information.

## Claim boundary

Supported wording:

- Colour design informed by the CUDO recommended colour set ver.4.
- Specified colour pairs target WCAG 2.2 colour/contrast success criteria.

Not established by this work: formal CUDO verification, CUD certification, CUD
mark eligibility, a claim that all users can distinguish these colours, or
whole-Viewer WCAG 2.2 conformance. Physical classroom validation on the
documented Edge/iPad matrix, and any downstream Firmware AssetPool intake,
remain separate and are not claimed here.
