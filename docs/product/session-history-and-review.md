# Stopped-session history and review

Related to [Viewer #20](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/20) and [Viewer #24](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/24).
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

One-pointer horizontal drag changes the same review cursor by horizontal pixels
/ plot width * selected device-time window (rounded to the nearest microsecond
only for the presentation cursor). Movement clamps to retained earliest/latest.
Y motion is ignored. All LIVE canvas graph gestures, including X pinch, are inactive. Current's lower
bound remains exactly 0 A. Vertical pan/Y origin is explicitly outside this
implementation: [Viewer #25](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/25)
is separate follow-on work, subject to [Viewer #14](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/14)
and [VAMeter-Edu #15](https://github.com/Yuichiroh-Kobayashi/VAMeter-Edu/issues/15).

Native X/Y selects and adjacent zoom buttons share GraphPolicyController state
with pinch. Disabled controls remain mounted with native disabled semantics,
full-opacity muted text and a dashed border. Forced-colors uses system GrayText
for disabled controls. Live Y controls are visible and disabled.
The native range slider remains an alternative to drag. State-dependent
canvas CSS declares ownership before pointerdown. Page and controls retain
browser/OS behavior. No proprietary gestures, global suppression or dependencies.
No extra mode-guidance DOM is added in this correction: the native controls and
existing review status stay primary, without adding another line to narrow layouts.
Vertical pan and Auto Y remain outside this change (#25).

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

The native secondary **CSVを保存 / Export CSV** button is available after the
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
voltage,current,elapsed_ms
```

- UTF-8 without BOM, CRLF after each row including the last row. Firmware
  recorder CSV uses LF. The column schema and measurement semantics align;
  Viewer and Firmware CSV files are not byte-identical. The Firmware recorder
  is unchanged.
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

### #21 verification

Initial #21 base: #20 commit `a3117a6ef420d2017f7b27a0343d750e86df7ad2`, tree
`d6fee4c06259e9c85947423842ff45499f9460eb`. Before editing, materialization and
all 14 inherited product files passed. After #21, the same commands above pass
all 15 product files: 90 named tests + 4 script gates = 94 checks. Root harness
remains 30 self-tests + 13 live regressions PASS. The 10 new CSV tests cover
exact text, validity, signed current, BigInt precision, gap timing, normal-stop
gating, shared-mode data, zero WS deltas, epoch isolation, policy A, injection
rejection, bounded Blob cleanup and download failure recovery.

Real-browser save behavior and rendering are NOT RUN in this environment for
the browser-executable reason recorded above. iPad Safari's download/share
behavior and Blob lifetime, Edge save behavior, keyboard/touch operation, and
narrow viewport rendering remain target-browser checks. No physical validation,
classroom validation, Firmware integration, or permission to merge is implied.
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
