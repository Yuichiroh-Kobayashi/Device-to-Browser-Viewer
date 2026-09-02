# Post-beta.1 Viewer theme and colour contract

This document records the presentation contract added for
[Device-to-Browser-Viewer Issue #9](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/9).
It describes post-beta.1 product source under
[`src/product/p2-sp/`](../../src/product/p2-sp/) only. The published
`v2.0.0-beta.1` bundle remains immutable and is not changed by this contract;
see [`beta1-device-hosted-viewer-contract.md`](beta1-device-hosted-viewer-contract.md).

Release status (2026-09-02): this contract originated after beta.1, and the
reviewed theme behavior is included in the stable
[VAMeter-Edu `v2.0.0` Viewer release](https://github.com/Yuichiroh-Kobayashi/VAMeter-Edu/releases/tag/v2.0.0)
lineage and bundle
`4422530b6e1ba9549dd4bef2e3bb2c183d8fced49ed2d8d695d2a04a4aa7c2af`.
Beta.1 remains immutable, and later Viewer source changes likewise do not
mutate the published stable bundle.

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
presentation updates relabel the mounted control and never replace it. The
control's icon and label are separate child nodes, so a relabel writes only
the label node and never destroys the icon.

Implementation: [`src/product/p2-sp/presentation/theme-controller.js`](../../src/product/p2-sp/presentation/theme-controller.js)
(control markup), constructed once per application in
[`src/product/p2-sp/app.js`](../../src/product/p2-sp/app.js) and mounted as
part of the shared measurement header in
[`src/product/p2-sp/presentation/measurement-workspace.js`](../../src/product/p2-sp/presentation/measurement-workspace.js).

## Interaction

- One native `<button>`, part of the shared measurement header (the same
  header both Student and Professional mount), not a standalone element ahead
  of the workspace. At normal tablet/desktop widths it stays in the header
  row, trailing the connection/stream text; at narrow widths it may wrap
  naturally with the rest of the header, but it never reserves a dedicated
  full-width row of its own ahead of the workspace. It remains visually
  secondary to the full-width Start/Stop measurement control.
- A decorative CSS-only icon (a half-filled circle, `aria-hidden`) sits beside
  visible text naming the theme the learner would move to
  (`ダーク表示 / Dark mode`, `ライト表示 / Light mode`); the icon carries no
  information of its own and the visible bilingual label remains the
  authoritative, action-oriented indicator.
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

### Active and reserved roles

Not every declared role is rendered by current product UI. The distinction is
enforced by `tests/theme-contrast.test.mjs`, which proves each active role is
consumed by a presentation rule or by a renderer `style()` call, and proves each
reserved role is **not**.

**Active** — consumed by shipped UI today: `page`, `surface`, `text`,
`text-muted`, `border`, `action-primary-surface`, `action-primary-text`,
`action-stop-surface`, `action-stop-text`, `measure-voltage`, `measure-current`,
`status-ready`, `status-recoverable`, `status-fatal`, `status-busy`,
`status-disabled`, `focus-inner`, `focus-outer`, and every `graph-*` role except
`graph-reverse-warning`.

**Reserved** — defined in the palette and contrast-validated, but **not rendered
by current UI**: `status-streaming`, `status-warning`, `graph-reverse-warning`.
They exist so the palette is complete and ready; no document may describe them
as though the UI already shows them. `graph-reverse-warning` in particular is
not a reverse-current warning implementation — that behaviour remains
unimplemented and coupled to reviewed Firmware Issue #15 policy.

### Action roles

Student and Professional expose the same shared primary Start/Stop
presentation and transaction authority, through one shared measurement
workspace ([`src/product/p2-sp/presentation/measurement-workspace.js`](../../src/product/p2-sp/presentation/measurement-workspace.js))
and the existing `StudentPrimaryActionController`. Professional does not own
a separate lifecycle state machine, WebSocket owner, action controller, or
command policy; activating the control in Professional drives the exact same
transaction path as Student. This shared control's presentation is selected
by a semantic action role, not by its localized label. `studentPrimaryActionState()`
derives `kind` from runtime state and the view writes it to `data-action-kind`:

| runtime state | `kind` | tokens consumed |
| --- | --- | --- |
| `STREAMING` | `stop` | `--action-stop-surface`, `--action-stop-text` |
| `CLOSED`/`READY` and start permitted | `start` | `--action-primary-surface`, `--action-primary-text` |
| pending/in-flight/`CONNECTED` | `busy` | `--status-busy`, `--surface` |
| start not permitted | `disabled` | `--status-disabled`, `--surface` |

No CSS rule keys off label text, so Stop presentation cannot drift with
translation.

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

Each checked pair names the background the role is **actually** drawn on rather
than a convenient palette pairing — panel text against `--surface`, page text
against `--page`, the Stop label against `--action-stop-surface`, the disabled
label against `--status-disabled`, canvas marks against `--graph-background`.
The `GAP <n>` and `SEGMENT` marker labels are visible canvas text and are gated
at 4.5:1 against the graph background, separately from their marker rules, which
are gated at 3:1.

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
not currently separate from each other by contrast or in grayscale. That is
acceptable because they never share a canvas — a single-canvas Voltage/Current
overlay is an explicit Issue #9 non-goal — and each carries its own name, unit
and graph title, which is what the suite gates.

Mutual channel contrast is **not** an invariant in either direction. The ratio is
logged as diagnostic evidence only, so a future palette improvement that happens
to separate the families can never fail the suite.

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
