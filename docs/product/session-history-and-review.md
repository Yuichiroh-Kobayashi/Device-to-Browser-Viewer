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
  Start temporarily disables review. A failed hello/start before acceptance retains
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
retained across streams. Tick precision is 0.1 s for 1/2/5/10-second windows
and integer seconds for 30/60-second windows. The existing major tick ladder
is selected from plot width; it does not assume ten X divisions.

After normal Stop, the initial view is latest. Native Back/Forward buttons
move half a display window, a native range spans the retained interval, and
Latest returns in one action. Range positions map to BigInt device time;
they select a viewport, never synthesize samples. A range position can fall
in a gap, which remains empty. All controls retain keyboard and touch semantics
and a 44 px target; their layout wraps below the primary measurement workspace.
The numeric readouts retain the final Stop value and are labelled accordingly.

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
Only pointers starting on that same canvas can pair. Pointer capture is released
on up/cancel/lost capture, remount, destroy and accepted epoch change. After a
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
Y motion is ignored. Live pan and live Y pinch are inactive. Current's lower
bound remains exactly 0 A. Vertical pan/Y origin is explicitly outside this
implementation: [Viewer #25](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/25)
is design HOLD, subject to [Viewer #14](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/14)
and [VAMeter-Edu #15](https://github.com/Yuichiroh-Kobayashi/VAMeter-Edu/issues/15).

Native X/Y selects and adjacent zoom buttons share GraphPolicyController state
with pinch. Disabled controls remain mounted with native disabled semantics,
reduced opacity and a dashed border. Live Y controls are visible and disabled.
Native range/Back/Forward/Latest remain alternatives to drag. Scoped
`.graph-panel canvas { touch-action: none; }` declares graph ownership before
pointerdown; page, controls, browser zoom, OS sharing and accessibility remain
browser/OS-owned. No proprietary gestures, global suppression or dependencies.

Each graph's centered semantic output is above its canvas and does not cover
the waveform. It has `pointer-events: none` and `aria-live="off"`. Its 秒/目盛
comes from the very same `makeXAxisGrid()` result used to draw grid lines;
V/目盛 or A/目盛 is the frame scale without current-unit substitution. The old
canvas scale text was removed to avoid duplicate readouts; engineering Y tick
labels and the current 0 A boundary remain.

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
pointer cleanup, pan, control synchronization and actual grid readout tests.
Final command counts and immutable provisional build identities are recorded
in Draft PR #22 after the final tracked commit.
Root harness: 30 self-tests and 13 live regressions PASS. New tests exercise
actual accepted frames, capacity/truncation, epoch isolation, mounted review
controls, stopped window changes, and zero construct/send/close deltas.

Browser checks: NOT RUN. Browser plugin is absent; existing Playwright 1.50.1
has no installed Chromium/Firefox/WebKit executable, and chromium-browser is
an uninstalled Snap launcher. No runtime or browser dependency was installed.
Actual rendered narrow viewport, keyboard/touch behavior, Windows Edge,
iPad Safari and Chromebook Chrome remain pending. DOM mocks are host evidence only.

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

Schema and byte representation:

```csv
voltage,current,elapsed_ms
```

- UTF-8 without BOM, CRLF after each row including the last row.
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

### #21 verification

Base: #20 commit `a3117a6ef420d2017f7b27a0343d750e86df7ad2`, tree
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
