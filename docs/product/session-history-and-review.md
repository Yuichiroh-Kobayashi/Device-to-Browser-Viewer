# Stopped-session history and review

Related to [Viewer #20](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/20), [Viewer #24](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/24) and [Viewer #25](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/25).
This is current product source behavior, pending external review and downstream
intake. The Viewer shipped in stable VAMeter-Edu v2.0.0 remains source
`e1ebdb1cde8585a37447a66f4c8183654f4c3cda`, bundle
`4422530b6e1ba9549dd4bef2e3bb2c183d8fced49ed2d8d695d2a04a4aa7c2af`.

## Architecture

- **History owner:** the sole RuntimeOwner's `SessionHistoryModel`, a
  product-owned subclass of the materialized historical `StreamModel`.
  Its inherited measurement ring is the session history; there is no second
  measurement buffer, parser, SessionAdapter, or WebSocket owner.
- **Append authority:** the existing adapter's decoded, validated candidate
  commit. `super.commitCandidate()` retains the existing frozen record objects;
  no record clone or binary re-decoding is introduced.
- **Epoch boundary:** the existing `_clearViewport()` seam clears records,
  markers, origin, and truncation on accepted `beginStream` and accepted
  `beginsViewportEpoch`. Reusing a stream ID on a new connection still starts
  a new epoch. Normal `finishStream()` retains history.
- **TIMEBASE_RESET:** the current reference accepts it only at the first data
  frame of a new session, with STREAM_START and DISCONTINUITY. A reset during
  an already populated session stays rejected without any history mutation.
  This work does not change that protocol rule.
- **Origin:** the first committed record timestamp of the epoch, retained as
  BigInt even after FIFO eviction or a delayed first canvas paint.
- **Retention:** `HISTORY_CAPACITY` reuses the existing `MAX_RECORDS = 4096`
  ceiling. Only capacity causes measurement eviction, oldest first. Display
  window changes never delete measurements. `historyTruncated` latches until
  the next epoch and is visible in both modes.
- **Markers:** the existing 512-marker ring remains bounded. Markers before
  the oldest retained measurement are released. Marker overflow is separately
  visible; per-record segment/channel boundaries still prevent path bridging.
- **Review readiness:** RuntimeOwner observes an accepted control transition
  from STREAMING with accepted STREAM_END to READY. Abort, timeout, early
  stream_stopped, and disconnect do not establish readiness. Normal
  Student-owned transport close after READY retains it. Reopening or a pending
  Start temporarily disables review (including the source's existing connecting state before socket open). A failed hello/start before acceptance retains
  the completed epoch and restores review in CLOSED. Only an accepted new
  epoch invalidates the previous completion; no new lifecycle flag is added.
- **Cursor authority:** one application-lifetime presentation controller takes
  immutable history summaries and stores only an epoch and a BigInt device-time
  right edge. It never invokes runtime actions or mutates the model. A new
  epoch resets to latest; Student/Professional remounts retain the same cursor.
- **CSV input:** the same stopped epoch's measurement ring, all retained
  records irrespective of the visible window or display profile. CSV is the
  follow-on #21 change described below, with no alternative retention authority.

## Capacity estimate

At nominal 25 Hz V/I, 4096 records represent about 163.84 seconds of samples
(163.80 seconds from first to last at exact 40 ms spacing). Actual retained
time depends on accepted timestamps, rate and gaps; it is not a timing promise.
The selection preserves the pre-existing record ceiling instead of enlarging it.

An approximate 256–512 bytes per record including its flags object, BigInts,
numeric fields and object overhead gives 1–2 MiB, plus about 32 KiB of ring
references on an engine using 8-byte references and bounded marker storage.
Rendering adds temporary arrays and geometry proportional to at most 4096
records. This is an order-of-magnitude estimate, not a measured heap bound or
an iPad memory qualification. No browser storage or persistence is used.

## Interaction and measurement contracts

During streaming the graph always follows latest. Existing `makeTimeDomain`
is retained: a 10-second display starts at 0..10 and at elapsed 12.5 seconds
shows 2.5..12.5. The origin and X coordinates derive from device `timestamp_us`,
never browser arrival time. The formal X windows are 1/2/5/10/30/60 seconds, with the selected preference
retained across streams. Only the 10-second window uses a fixed 1-second major grid/tick step and
integer tick labels, including sliding domains (2.5..12.5 shows 3..12).
Only this window staggers labels into two rows when measured text would collide
on a narrow canvas; every integer-second grid/tick remains visible.
The 1/2/5/30/60-second windows retain the reviewed width-dependent tick ladder,
precision and label formatting: 0.1 s for 1/2/5, integer seconds for 30/60.
Cursor endpoint labels retain sub-second detail independently of integer grid ticks.

After normal Stop, the initial view is latest. A native range slider spans the
retained interval; its right endpoint selects latest. It is the only dedicated
visible review navigation control; Back/Forward/Latest buttons and their event
bindings are removed. Horizontal graph pan continues to use the same cursor.
Range positions map to BigInt device time, select a viewport and never synthesize
samples. A position can fall in a gap, which remains empty. Keyboard and touch
semantics and 44 px targets remain. The range/status label is
`表示中の時間 / Displayed time:`. Numeric cards show only `データなし` before
measurement; valid final values retain `停止時の値` after Stop. The separate
stopped-value explanation paragraph is removed.

Changing 1/2/5/10/30/60 after Stop expands the view from retained records. Both modes
use the same graph policy and history. Invalid measurements stay blank/no-data,
signed current stays signed, and the current graph's lower bound remains 0 A.
No interpolation, smoothing, missing-row synthesis, or gap compression is added.

## Stopped scales and standard graph interaction

The last live GraphPolicyController frame's V/I scale indices are retained at
normal Stop. Rendering outside STREAMING does not evaluate autoscale, including
an already queued RAF at Stop. If no live frame was ever painted, the initialized
ladder minima remain. Live thresholds, hysteresis and once-per-measurement/window
evaluation are unchanged. Stopped Y selection uses the existing V and I ladders
independently. Cursor movement, X changes and mode remount never autoscale.
Accepted stream/TIMEBASE_RESET resets those indices and restores live policy.

The sole history cursor also accepts a clamped BigInt right edge for pan.
Each canvas has its own GraphInteractionController, bounded to two pointer
positions and a gesture baseline, with no measurement/transport references.
Review readiness is the sole interaction gate. Each canvas exposes
`data-graph-interaction="browser"` outside review and `"graph"` during review.
LIVE and non-review canvas gestures belong to the browser (`touch-action: auto`):
one-finger page scroll, page pinch zoom and other native direct manipulation.
The controller returns before registering pointers, taking capture or creating a
baseline; move also checks readiness before any mutation. LIVE X changes use
only the native dropdown and zoom buttons. LIVE Y stays zero-origin/autoscale.

Only stopped review uses `touch-action: none` and the graph gestures below.
Only pointers starting on that same canvas can pair. Pointer capture is released
on up/cancel/lost capture, remount, destroy, accepted epoch change, and immediately
when review becomes unavailable during the next open/start attempt. The existing
source connecting state is projected through RuntimeOwner readiness and status
notifications; there is no new lifecycle owner/flag. A pre-acceptance failure
restores graph ownership with the same history/cursor/scales. No in-progress
browser gesture or previously cancelled graph gesture is adopted after recovery
or Stop: a new pointerdown is required. After a
pinch loses one pointer, its remainder cannot pan or join a new pinch until all
original pointers leave. A third pointer is ignored.

Axis dominance uses absolute separation change divided by plot width/height.
`PINCH_AXIS_LOCK_THRESHOLD = 0.04` waits for 4% motion; ties wait. The selected
axis stays locked throughout the gesture even if dominance reverses. Pinch
ratio uses separation with a floor of 10% of the corresponding plot dimension
to handle zero/near-zero starting separation. The gesture-start scale divided
by this ratio is quantized at geometric ladder midpoints with an 8% hysteresis
band. Large motion may cross multiple steps; pinch-out selects smaller scale.
These are deterministic development values, pending actual tablet usability.

One pointer serves both review axes. The axis is chosen once per gesture from
the same normalized dominance rule the pinch uses -- absolute movement divided
by plot width and height, `PINCH_AXIS_LOCK_THRESHOLD = 0.04`, ties wait -- and
then stays locked until the gesture ends or is cancelled, even if dominance
reverses. A horizontal drag changes the same review cursor by horizontal pixels
/ plot width * selected device-time window (rounded to the nearest microsecond
only for the presentation cursor), clamped to retained earliest/latest. A
vertical drag changes only that graph's Y origin (see below). All LIVE canvas
graph gestures, including X pinch and vertical pan, are inactive, and LIVE
Voltage and Current lower bounds remain exactly 0 V and 0 A.

Native X/Y selects and adjacent zoom buttons share GraphPolicyController state
with pinch. Disabled controls remain mounted with native disabled semantics,
full-opacity muted text and a dashed border. Forced-colors uses system GrayText
for disabled controls. Live Y controls are visible and disabled.
The native range slider remains an alternative to drag. State-dependent
canvas CSS declares ownership before pointerdown. Page and controls retain
browser/OS behavior. No proprietary gestures, global suppression or dependencies.
No extra mode-guidance DOM is added in this correction: the native controls and
existing review status stay primary, without adding another line to narrow layouts.

Centered per-division outputs and renderer readout plumbing are removed from both
graphs. Numeric axis ticks, X window dropdown and Y scale dropdown remain the
visible scale information. The Y button text is `拡大 / Zoom in` and
`縮小 / Zoom out`; axis-specific accessible names distinguish Voltage and Current.
Current presentation uses only A/mA, including sub-mA numeric values, ticks and
scale options. Measurement/model and CSV values remain signed A. Zero ticks stay
`0 A`. X controls read `横軸 / Display window`, with bilingual second/seconds
options; the existing `横軸 拡大 / Zoom in` and `横軸 縮小 / Zoom out` labels remain.
The mode toggle is last in the shared control area, after review (and CSV controls
when included). Remounts preserve the same window, scales, history and cursor.

## Y-axis origin authority and stopped vertical pan

Related to [Viewer #25](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/25).

Each graph channel has exactly one Y presentation state, owned by the same
application-lifetime `GraphPolicyController` that already owns the stopped Y
scale indices. There is no second Y owner, no per-mode copy, and no DOM-stored
Y state; Student and Professional read and mutate the same instance.

```text
LIVE_AUTO_ZERO        origin 0, existing live staged autoscale, manual Y refused
STOPPED_LATCHED_ZERO  origin 0, last live frame scale, X review never moves Y
STOPPED_AUTO_ZERO     origin 0, scale re-derived from the visible X viewport
STOPPED_MANUAL_FREE   origin and scale user-controlled, X review never moves Y
```

Normal Stop enters `STOPPED_LATCHED_ZERO` per channel. Any manual Y operation
for a channel -- vertical pan, Y pinch, Y scale dropdown, Y zoom in, Y zoom out
-- enters `STOPPED_MANUAL_FREE` for that channel alone. That channel's Y Auto
control enters `STOPPED_AUTO_ZERO`. An accepted new stream returns both
channels to `LIVE_AUTO_ZERO` with origin 0, through the existing epoch reset.
Voltage and Current states are independent throughout.

**Only an accepted new stream may discard the Y presentation authority of a
previously accepted normal-Stop session.** An open attempt, the source's
connecting state, a pending hello, a pending Start, a hello or start timeout,
a transport failure and a force close must all leave the review cursor, the X
window, and both channels' Y mode, origin and scale exactly as they were, and
leave retained history and CSV content unchanged. Controls may be disabled
while such an attempt is in flight; the authority behind them may not be
recomputed.

This is enforced at the one place that advances the Y state machine.
`GraphPolicyController.update()` takes the caller's accepted-stopped-review
readiness -- the same fact that gates `setStoppedScale`, `setStoppedOrigin`
and `autoStoppedY`, and the same fact that decides whether a review right
edge is supplied at all -- and advances neither the latch transition nor an
`STOPPED_AUTO_ZERO` re-fit without it. The gate matters because a frame
rendered while review is unavailable follows latest instead of the reviewer's
cursor: re-evaluating there would rewrite the previous session's scale
against a viewport the reviewer never chose. With a Current channel whose
reviewed viewport holds only negative samples, that rewrite would also be
permanent, because the retain rule below then has no peak with which to
correct it. Outside STREAMING the scale is frozen for every mode anyway, so a
render during an unaccepted attempt simply repaints retained values. The
parameter defaults to withholding the transition, so a caller that omits it
can never mutate the state.

Y origin is presentation state in channel units. It is applied only to the
rendered viewport `[origin, origin + 9 * scale]`. It does not reach measurement
records, retained history, sequence, validity, `timestamp_us`, CSV values or
bytes, WebSocket frames, the SessionAdapter, the RuntimeOwner, the D2B wire or
schema, or any Firmware behavior. The numeric Y axis labels and the waveform
transform are both derived from the one `frame.origin`, so a waveform shifted
against a fixed axis is structurally impossible rather than merely unintended.
The zero boundary marks the value 0: under a manual origin it moves with the
data and is not drawn at all when 0 leaves the viewport, instead of being
redrawn at the plot floor.

Vertical pan is one-pointer, stopped-review only, and uses the existing Pointer
Events and pointer capture path with no second gesture engine. Dragging down
raises the origin so the waveform follows the pointer; the origin moves by
dragged pixels / plot height * nine divisions, computed from the gesture
baseline so repeated moves cannot accumulate drift. Pan alone never changes
the discrete scale. The origin is not clamped to the measured range: recovery
from an origin that has left the data behind is the channel's Y Auto control,
not a presentation bound invented from the measurement domain. Only non-finite
values are refused. `pointercancel`, lost capture, remount, destroy and an
accepted new stream clear active gesture state, and a pinch remainder still
cannot continue as a one-pointer pan.

Stopped Y pinch remains quantized to the existing `VOLTAGE_SCALES` /
`CURRENT_SCALES` ladders. It additionally anchors on the two-pointer midpoint:
the gesture-start origin and scale fix one measured value under the fingers,
and each quantized step re-derives the origin from that same value, so a pinch
zooms about the midpoint rather than about the plot floor. Both inputs are
gesture-start values, never frame values.

Y Auto is one native button per channel, `自動 / Auto`, beside that channel's
existing scale controls. One activation clears the manual origin, returns the
origin to exactly 0, selects a scale from the records visible in the current X
viewport, and enters `STOPPED_AUTO_ZERO`. The selection is not a new autoscale
algorithm: it is the existing positive-domain `updateStagedScale` ladder
authority, evaluated from the ladder minimum.

The scale claim is therefore conditional, and is stated that way deliberately:

- When a qualifying non-negative peak exists in the visible viewport, the
  selected index is derived from those values alone and does not depend on the
  index the viewer arrived from. Evaluating from the ladder minimum is what
  buys that: iterating the staged rule from the current index is not
  confluent, so the same records would otherwise settle on different indices
  depending on the path taken.
- When no qualifying non-negative peak exists -- an empty viewport, or a
  Current viewport holding only negative samples -- there is nothing to fit,
  and the existing stopped scale is retained rather than collapsed to the
  ladder minimum. In that case the result follows the retained scale, not the
  viewport.

No autoscale over negative magnitudes is introduced, and the existing
positive-domain staged scale authority is unchanged.

In `STOPPED_AUTO_ZERO` an X cursor or window change made by the reviewer
re-fits that channel's scale under the same two rules; the next manual Y
operation returns the channel to `STOPPED_MANUAL_FREE`, after which X review
changes alter neither origin nor scale.

Auto stays mounted in LIVE and is disabled there, because LIVE already is the
zero-origin autoscale state; `aria-pressed` carries that fact natively and
`data-y-mode` exposes the current state. Controls remain visible when disabled,
with the existing native `disabled` semantics, muted full-opacity text and
dashed border. The existing `touch-action` boundary is unchanged: only a canvas
in stopped review declares `touch-action: none`, so page scroll and browser
zoom keep their behaviour everywhere else. No proprietary iOS or ChromeOS
gesture API is used.

In stopped `STOPPED_MANUAL_FREE` the Current graph's visible lower bound may
move below or above 0 A. This is a viewport operation only: signed negative
current remains measurement and model authority, CSV values are never
transformed by origin or scale, and the Viewer does not become a relay or
safety authority. The frame's `reverseObservation` is derived from the records
in the X window before any Y clipping, so it is unchanged by origin and scale
and a future reverse-current warning can be presented outside the clipped plot.
Whether such a warning actually persists is NOT ESTABLISHED HERE: no
reverse-current warning presentation exists in this repository yet, and that
acceptance item depends on
[Viewer #14](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/14)
and [VAMeter-Edu #15](https://github.com/Yuichiroh-Kobayashi/VAMeter-Edu/issues/15).
No reverse-current threshold, debounce, browser-side detector or safety policy
is introduced here.

In this retained product model, `viewerWindowEvictionCount == 0` is normal.
The diagnostic field remains for comparison with the harness, while bounded
product measurement retention is governed by capacity eviction alone.

## Verification record

Work base fetched from GitHub current main on 2026-09-11:
`81226e7b39410ac673c1b46a9b76eab6084a4f19`, tree
`39f2c0dda08de7f72d297d49bb161e1a4a062bbc` (unchanged from task snapshot).
Before editing, materialization PASS; all 12 existing product test files PASS.
Host reference used here: `/usr/bin/node` v18.19.1. The initial PATH-node
v24.18.1 test run also passed; it is not build authority or adoption of PR #18.

Commands:

```sh
python3 tools/product-repro/materialize-source-export.py
/usr/bin/node --test src/product/p2-sp/tests/*.test.mjs
# Also run each test file directly to expose its nested TAP results.
/usr/bin/node --test tests/node-self-tests.mjs
/usr/bin/node tests/node-self-tests.mjs
/usr/bin/node tests/live-gate-regressions.mjs
python3 -m py_compile tools/serve.py tools/product-repro/build-current-product.py
python3 tools/build-env/verify.py provenance
git diff --check
```

Initial #20 implementation: 14 product files PASS, comprising 80 named tests and
4 script gates (84 checks). Corrective #20/#24 validation adds timeout recovery,
last-live-frame latch, manual scales, six windows, axis-lock/quantization,
pointer cleanup, pan and control synchronization tests. Classroom UI cleanup adds
10-second exact integer grids, unchanged other-window snapshots, A/mA presentation,
range-only controls and pre-measurement card tests.
Final command counts and immutable provisional build identities are recorded
in Draft PR #22 after the final tracked commit.
Root harness: 30 self-tests and 13 live regressions PASS. New tests exercise
actual accepted frames, capacity/truncation, epoch isolation, mounted review
controls, stopped window changes, and zero construct/send/close deltas.

Browser correction validation uses the existing Chromium 133 / Playwright 1.50.1
installation, without installing a runtime or dependency. The user reports prior iPad Safari / Chromebook touch and mouse operation checks
completed without major-function problems at the previous candidate. That report
is not a new physical run by this implementation task. Final targeted results,
console counts and screenshots are recorded in Draft PR #22 after the source
commit, as DESKTOP / EMULATED BROWSER. iPad Safari physical and Chromebook touch
physical are NOT RUN; emulation is not classroom or physical qualification.

Build authority remains Viewer Build Environment V1. Existing Candidate A
image matched the qualified digest and passed inventory verification. Candidate
identities are recorded externally in the Draft PR only after the final tracked
commit as PROVISIONAL DEVELOPMENT BUILD, not final Firmware intake identity, avoiding a self-invalidating provenance commit. No Node 24 builder
changes or historical reproduction changes are included.

## Browser-side CSV (#21)

Related to [Viewer #21](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/21).
This change is stacked on #20 and exports the same normally stopped epoch that
the learner can review. It does not change Firmware's five-second recorder,
device filesystem, `/download`, or the stable release bundle. Viewer CSV means
D2B-accepted and retained measurements, not firmware-file byte identity and
not a promise that every device-produced sample was received.

The native secondary **測定データをCSV保存 / Export measurement CSV** button is available after the
same accepted normal Stop used by review (including the subsequent owned
transport close). Empty history and all other lifecycle states are ineligible.
The visible viewport and Student display profile never filter export columns
or rows. The click takes a synchronous snapshot from the sole history ring;
there is no second measurement store, independent decoder, or network request.
Export does not move the review cursor, mutate records, or touch transport.
X dropdown/buttons/pinch, horizontal pan, V/I dropdown/buttons/pinch, and mode
switching leave CSV bytes identical for the same retained epoch. A failed hello
or start before acceptance restores the old completed epoch's export eligibility
on CLOSED; an accepted replacement epoch cannot inherit that completion.

Schema and byte representation:

```csv
elapsed_ms,voltage,current
```

- UTF-8 without BOM, CRLF after each row including the last row. Firmware
  recorder CSV uses LF and its existing column order remains unchanged. Viewer
  and Firmware files are not byte-identical; this update changes only Viewer
  column order, preserving V/A/device-time measurement semantics.
- Valid voltage/current: finite JavaScript numeric value in V/A, converted to
  its round-trippable Number string. A signed negative current remains signed.
  This includes the precision of the accepted D2B float32 value; it is not the
  rounded Student display value.
- Invalid or absent channel: an empty cell. No fabricated zero, filling,
  interpolation, synthesized row, or cadence regularization.
- `elapsed_ms`: BigInt `timestamp_us - epochOriginTimestampUs`, divided by
  1000 using integer quotient/remainder. The optional fractional part has up
  to three digits, with only trailing zeros removed. Examples: 1 us -> `0.001`,
  1010 us -> `1.01`. The delta is never converted to Number, so sub-ms precision
  survives even beyond Number's exact integer range. Gaps retain their actual
  timestamp difference.
- Static header, finite number strings, and blanks are the only cell sources.
  String/object measurements are rejected, not coerced or quoted into CSV.

**Truncation policy A:** if even one old measurement was evicted this epoch,
the button is disabled with an explicit reason; the serializer also rejects
the request. This version does not offer partial export. Marker annotation
overflow alone does not remove measurements and does not block CSV. A new
accepted epoch clears truncation and may become eligible after normal Stop.

The filename is `vameter-viewer-YYYYMMDD-HHMMSS.csv` using host-local time only
for identification. School/user/SSID/device identifiers never enter it. There
is no browser persistent storage, cloud upload, runtime dependency, or telemetry.

Download uses a local Blob URL and a temporary native download anchor invoked
in the button's activation turn. One application retains at most one pending
Blob URL and one cleanup timer. The URL is revoked after 60 seconds, before a
subsequent export, on error, or when the application is destroyed. The temporary
anchor is removed immediately after activation. The confirmation says download
was requested; it does not assert that an OS file was successfully saved.
Serialization failure records only `csv-serialize-failed`; browser download
failure records only `csv-download-failed` in the existing bounded eight-entry
action diagnostic. The UI may use the same generic error text. Raw exception
messages, measurement text and identifiers are never copied into diagnostics.

The button reads `測定データをCSV保存 / Export measurement CSV`. When enabled,
the routine explanation is blank. Disabled reasons (normal Stop not established,
no measurements, history truncated) and download/error results remain visible.
The mode toggle follows CSV controls/reason/result at the bottom of the common
control area. The exact row order is elapsed_ms, voltage, current; current CSV
cells remain signed A regardless of the A/mA presentation choice.

### #21 verification

Initial #21 base: #20 commit `a3117a6ef420d2017f7b27a0343d750e86df7ad2`, tree
`d6fee4c06259e9c85947423842ff45499f9460eb`. Before editing, materialization and
all 14 inherited product files passed. After #21, the same commands above pass
all 15 product files: 90 named tests + 4 script gates = 94 checks. Root harness
remains 30 self-tests + 13 live regressions PASS. The 10 new CSV tests cover
exact text, validity, signed current, BigInt precision, gap timing, normal-stop
gating, shared-mode data, zero WS deltas, epoch isolation, policy A, injection
rejection, bounded Blob cleanup and download failure recovery.

The current classroom UI/schema update uses the existing Chromium installation
for a source + synthetic transport browser download spot regression. Final
results are recorded in PR #23. The user's prior iPad Safari / Chromebook physical
operation report applies to the previous candidate; no new physical run or
classroom/Firmware qualification is claimed here.
Final committed #21 candidate identity and independent V1 two-run evidence are
recorded in its stacked Draft PR, separately from #20's candidate.

Corrective propagation uses a normal merge of #22 commit
`9a655f48f14e8464b45ee3a8115456f02410f815` (tree
`113f1c892090313031baef21d01dabf0c25f84b5`), merge commit
`1ae77af7a06107a7cd9745844f6ece854ca76fd6`. Added host coverage fixes
CSV independence from all graph interactions, hello/start timeout recovery,
and distinct bounded diagnostic categories. Final counts and two-run V1
identities remain in Draft PR #23 as PROVISIONAL DEVELOPMENT BUILD, pending
independent review; they are not final Firmware intake authority.
