# Stopped-session history and review

Related to [Viewer #20](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/20).
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
  Start disables review; accepted new stream clears history.
- **Cursor authority:** one application-lifetime presentation controller takes
  immutable history summaries and stores only an epoch and a BigInt device-time
  right edge. It never invokes runtime actions or mutates the model. A new
  epoch resets to latest; Student/Professional remounts retain the same cursor.
- **Future CSV input:** the same stopped epoch's measurement ring, all retained
  records irrespective of the visible window or display profile. CSV is the
  follow-on #21 change, not an alternative retention authority.

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
never browser arrival time. Tick precision remains 0.1 s for 10-second windows
and integer seconds for 30/60-second windows.

After normal Stop, the initial view is latest. Native Back/Forward buttons
move half a display window, a native range spans the retained interval, and
Latest returns in one action. Range positions map to BigInt device time;
they select a viewport, never synthesize samples. A range position can fall
in a gap, which remains empty. All controls retain keyboard and touch semantics
and a 44 px target; their layout wraps below the primary measurement workspace.
The numeric readouts retain the final Stop value and are labelled accordingly.

Changing 10/30/60 after Stop expands the view from retained records. Both modes
use the same graph policy and history. Invalid measurements stay blank/no-data,
signed current stays signed, and the current graph's lower bound remains 0 A.
No interpolation, smoothing, missing-row synthesis, or gap compression is added.

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

After implementation: 14 product files PASS, comprising 80 named tests and
4 script gates (84 checks using the repository's combined counting convention).
Root harness: 30 self-tests and 13 live regressions PASS. New tests exercise
actual accepted frames, capacity/truncation, epoch isolation, mounted review
controls, stopped window changes, and zero construct/send/close deltas.

Browser checks: NOT RUN. Browser plugin is absent; existing Playwright 1.50.1
has no installed Chromium/Firefox/WebKit executable, and chromium-browser is
an uninstalled Snap launcher. No runtime or browser dependency was installed.
Actual rendered narrow viewport, keyboard/touch behavior, Windows Edge and
iPad Safari remain pending. DOM mocks are host evidence only.

Build authority remains Viewer Build Environment V1. Existing Candidate A
image matched the qualified digest and passed inventory verification. Candidate
identities are recorded externally in the Draft PR only after the final tracked
commit, avoiding a self-invalidating provenance commit. No Node 24 builder
changes or historical reproduction changes are included.
