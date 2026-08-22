# Device-to-Browser Viewer

A dependency-free, developer-oriented Viewer for receiving and replaying
`d2b-stream/0.1` `vi-measurement` data. It displays Voltage and Current against
device time, preserves sequence and device timestamp values as `BigInt` where
required, and keeps loss and invalidity visible.

[日本語](README_ja.md)

## Run locally

On Windows PowerShell, from the repository root:

~~~powershell
py -3 tools\serve.py
~~~

On Python 3 environments such as Linux or WSL:

~~~sh
python3 tools/serve.py
~~~

Open <http://127.0.0.1:8080/>. A deterministic screenshot-friendly preview is:

~~~
http://127.0.0.1:8080/?source=synthetic&scenario=stable&autostart=1
~~~

The browser self-test page is <http://127.0.0.1:8080/tests/>. It visibly emits
machine-readable TOTAL, PASS, and FAIL values; the current validation pass ran
it in both Chrome and Edge (TOTAL 17, PASS 17, FAIL 0). The static server binds
only to 127.0.0.1 by default, does not auto-open a browser, has no telemetry,
and rejects path traversal.

Run the DOM-free automated tests:

~~~
D2B_ORACLE="${D2B_ORACLE:-$HOME/Dev/Device-to-Browser-Data-Streaming}"
VAMETER_D2B_WORKTREE="${VAMETER_D2B_WORKTREE:-$HOME/Dev/worktrees/VAMeter-Edu/d2b-vi-planA-live}"

node --test tests/node-self-tests.mjs
node tests/node-self-tests.mjs
node tests/live-gate-regressions.mjs
python3 -m py_compile tools/serve.py
python3 \
  "$VAMETER_D2B_WORKTREE/tests/d2b_vi_integration/validate_live_capture.py" \
  --oracle "$D2B_ORACLE" \
  fixtures/capture/synthetic-live-capture.json
~~~

The Node test file contains 30 named semantic checks, including S1–S7 scenario
smoke coverage, transactional WebSocket controls, active-viewport isolation,
exact capture schema validation, orderly stream-end enforcement, lifecycle
races, and a legacy-frame-shape rejection. The external validator performs
authoritative capture-schema fixture validation backed by the D2B oracle. The
checked-in capture is synthetic and is not physical VAMeter evidence.

## Layout

- src/protocol/session-adapter.js: application-owned
  CONNECTED → READY → STREAMING → READY/CLOSED state machine.
- src/protocol/d2b-reference/: byte-for-byte upstream parser source.
- src/sources/: synthetic, saved-capture replay, and direct WebSocket sources.
- src/model/: fixed-capacity records and bounded segment/gap metadata.
- src/render/: Canvas 2D device-time scale and waveforms.
- fixtures/: upstream V/I golden vectors and a deterministic synthetic capture.
- tests/: browser and Node self-tests.
- tools/serve.py: local standard-library static server.

There are no npm packages, CDNs, React components, chart libraries, telemetry,
uploads, cloud calls, or build output.

## Contest 2026 validated configuration

The final Contest physical validation authority is Viewer commit
`80a9cd308cb3c6c5a1ccc27241cd645803675921`. The tested tree was clean. The
documentation commits after that point do not change the runtime source.

The validated Windows path was:

~~~text
VAMeter-Edu -> D2B -> Windows test-only Relay -> Viewer
~~~

It used Windows build 26100 and Chrome 151.0.7922.108 (64-bit). The result was
`PLAN_N_WINDOWS_E2E_PASS` and `LIVE_PHYSICAL_DEMO_PASS`. The observed run
received 5,996 binary frames and retained 5,995 samples in one segment. A
physical voltage change from 0 V to 2.4325 V was displayed. The two device-drop
counters were 0/0, and the Relay error/overflow/drop/timeout counters were
0/0/0/0 for this run. These observations are not a zero-loss guarantee or a
long-duration production qualification.

Safari on an iPad Pro 11-inch (M1), running iPadOS 26.5, displayed the real
live V/I stream through a temporary Windows bridge. READY and STREAMING passed,
the sample count increased, one segment was shown, and a physical voltage
response of approximately 2.6-2.9 V appeared in the Viewer. Stop and Close also
passed on a clean lifecycle retry. The preserved result labels are
`P5_IPAD_VIEWER_HTTP_PASS`, `P5_IPAD_WEBSOCKET_READY_PASS`,
`P5_IPAD_LIVE_DATA_PASS`, `P8_IPAD_LIVE_PHYSICAL_PASS`, and
`IPAD_VIEWER_VIA_WINDOWS_PASS`.

The Viewer was also confirmed to display and operate successfully on a Lenovo
CT-X636F Chromebook running Chrome through the temporary Windows bridge
(ChromeOS board/version krane 150.16700.0, Chrome 150.0.7871.222). This is not a
claim of formal Chromebook end-to-end qualification.

The iPad and Chromebook path was:

~~~text
VAMeter-Edu -> D2B -> Windows test-only Relay -> Windows temporary bridge
             -> iPad Safari / Chromebook Chrome Viewer
~~~

The Windows bridge was used only for Contest integration and browser-device
validation. It is not intended as the final classroom architecture, is not
owned by this repository, and is not a requirement of the Viewer by design.
These results do not demonstrate direct iPad/Chromebook-to-VAMeter
communication, no-PC-required operation, multi-client support, or
production-ready tablet/Chromebook support.

## Primary-session validation evidence

The final local project was tested from the repository root and served with
`python3 tools/serve.py`. The index was checked at
<http://127.0.0.1:8080/> and the viewer self-tests at
<http://127.0.0.1:8080/tests/>. Server smoke checks returned index `200 text/html`,
JavaScript `200 text/javascript`, and traversal `403`.

The D2B oracle command `python3 tools/validate_test_vectors.py` at baseline
commit `5411ba59a12882345d32218eda367bd6ba35ef5d` passed 3 schemas, 95 golden
vectors, 2 negative self-tests, and 7 mutation tests. The reference browser
harness at <http://127.0.0.1:8000/reference/browser/> reported Chrome
150.0.7871.187 and Edge 151.0.4129.59 at 95/95 each, parser-core 12/12, FAIL
0, and no window errors.

Viewer checks passed as follows:

- `node --test tests/node-self-tests.mjs` exited 0; direct
  `node tests/node-self-tests.mjs` reported 30/30. The targeted live-gate suite
  reported 13/13.
- Browser self-tests at `/tests/` reported TOTAL 17, PASS 17, FAIL 0 in both
  Chrome and Edge.
- S1 stable: 250/1; S2 step: 250/1; S3 producer gap: 245/2 (gap 5,
  producer 1); S4 output drop: 247/2 (gap 3, output 1); S5 validity: invalid
  voltage/current 126/125; S6 reconnect: 250/2 cumulatively with only stream 2
  retained in the current viewport; S7 invalid-frame:
  `bad_magic` diagnostic, 250 accepted, and no fabricated gap.

The oracle-backed synthetic capture validation was run with:

~~~sh
D2B_ORACLE="${D2B_ORACLE:-$HOME/Dev/Device-to-Browser-Data-Streaming}"
VAMETER_D2B_WORKTREE="${VAMETER_D2B_WORKTREE:-$HOME/Dev/worktrees/VAMeter-Edu/d2b-vi-planA-live}"

python3 \
  "$VAMETER_D2B_WORKTREE/tests/d2b_vi_integration/validate_live_capture.py" \
  --oracle "$D2B_ORACLE" \
  fixtures/capture/synthetic-live-capture.json
~~~

Set these variables to the actual repository locations when the local layout
differs from the defaults.

It passed with 2 data frames/2 samples and `stream_id` 7. Parser, golden-vector,
and license provenance byte comparisons all exited 0 with no diff. Short
synthetic/browser runs kept ring usage at or below 250 records; the hard caps
remain 4096 records, 512 markers, and 100 diagnostics. No long browser soak or
heap-trend measurement was performed. Chrome/Edge screenshots were saved
outside Git as validation evidence and are not committed artifacts.

## Sources and scenarios

Synthetic frames are created at runtime as valid 48-byte V/I binary frames (a
32-byte envelope plus one 16-byte record) and are sent into the same session
adapter and copied reference decoder as other input. A normal synthetic preview
uses a 4 ms wall-clock tick for one 40 ms device sample (25 Hz), so it models ten
exact device seconds quickly without changing timestamps.

- **S1 Stable:** 3.3 V / 0.10 A at 25 Hz for ten device seconds.
- **S2 Step:** 0/0 A until 2 s, 5 V / 0.20 A from 2–7 s, then 5 V / 0.08 A.
- **S3 Gap:** logical positions 75–79 are omitted. Position 80 is the next
  delivered frame, so its sequence and timestamp both advance by six 40 ms
  sample intervals and it has DISCONTINUITY|PRODUCER_OVERFLOW.
- **S4 Output drop:** logical positions 125–127 are omitted. Position 128 is
  the next delivered frame, so its sequence and timestamp both advance by four
  40 ms sample intervals and it has DISCONTINUITY|OUTPUT_QUEUE_DROP.
- **S5 Validity:** voltage-only invalid, current-only invalid, both invalid, then
  both valid; invalidity is expressed only with the valid mask.
- **S6 Reconnect:** stream ID 1 ends, the transport reconnects, and stream ID 2
  begins behind a hard visible boundary.
- **S7 Invalid frame:** a bad-magic duplicate is rejected by the reference parser;
  the subsequent valid frame has the unchanged expected sequence.

Capture replay accepts only `vameter-d2b-live-capture/0.1`, with exactly these
top-level fields from VAMeter's `capture-live.js`:

~~~json
{
  "format": "vameter-d2b-live-capture/0.1",
  "captured_at": "...",
  "user_agent": "...",
  "device_base_url": "http://.../d2b/v0/",
  "duration_seconds": 5,
  "capabilities_text": "...",
  "status_before_text": "...",
  "controls": [],
  "frames": [],
  "status_after_text": "..."
}
~~~

Each control has exactly event_index, received_ms, direction, and text; each
frame has exactly event_index, received_ms, and hex—there is no frame direction
or `frame_hex` alias. `received_ms` may be fractional. Event indexes must be
nonnegative, unique, contiguous from zero after merge, and ordered by
nondecreasing received_ms. The source strictly validates capabilities, public
status snapshots, the `hello`→`welcome`→`start_stream`→`stream_started`→data/
stop/drain→`STREAM_END`→`stream_stopped` lifecycle, welcome limits, frame size,
and binary frames before scheduling. Choose 0.25×, 1×, 2×, or
as-fast-as-possible; only received_ms controls scheduling. Canvas X coordinates
always come from decoded device timestamps.

The checked-in fixtures/capture/synthetic-live-capture.json is deterministic
synthetic test data, not a real VAMeter/device capture.

Live WebSocket mode is an implementation of hello, welcome, start_stream,
stream_started, binary data, stop_stream, observed STREAM_END, stream_stopped,
close/error, and reopen readiness. Its endpoint defaults to
ws://current-host/d2b/v0/stream (or a local placeholder when there is no browser
host). It uses binaryType = arraybuffer and intentionally does not weaken
origin/security behavior or add a CORS/relay bypass.

Live physical validation is limited to the exact Contest configuration and
commit documented above. It does not change the source's direct-WebSocket
semantics or promote the temporary Relay/bridge into Viewer architecture.

The local static server is a development tool, not a production LAN server.
Public deployment still requires an explicit file allowlist, dotfile denial,
non-loopback warning, and CSP review. Viewer-owned code licensing is
`OWNER_DECISION_REQUIRED_BEFORE_RELEASE`; the copied parser's Apache-2.0
provenance is unchanged. Long-soak capacity-edge and heap-trend checks remain
`DEFERRED_BEFORE_SOAK`.

## Semantics and bounds

The model stores each retained record as:

~~~text
stream_id, sequence BigInt, timestamp_us BigInt, valid_mask,
voltage_V | null, current_A | null, flags, segment_id
~~~

It keeps the BigInts through validation and only subtracts a device-time origin
before converting the relative delta to a plotting Number. Browser arrival time is
never a graph coordinate. Finite values only are drawn. There is no interpolation,
zero filling, hold-last-value behavior, timestamp compression, sequence
renumbering, or fake numeric marker for invalid data.

Reference segment metadata, explicit discontinuity, sequence gaps, timebase
changes, reconnects, and stream changes break the path. Per-channel invalid →
valid transitions also begin a new channel path. Canvas lines are not bridged
across a segment, invalid period, or stream ID. Gap/segment annotations label
producer and output-queue causes separately.

The hard retained measurement maximum is 4096 records. The display window defaults
to 60 device seconds and can be reduced but never increased beyond 60. Time-window
and ring-capacity removals increment viewerEvictionCount; these are viewer
conditions distinct from device sequenceGapCount. Segment/gap markers are capped at
512 and diagnostics at 100. Capture input is capped at 8 MiB and 100,000 merged
events; the replay plan is cleared on Close. Counters remain bounded scalar state:
samples, segments, gap events/gap samples, producer overflow, output queue drops,
invalid voltage/current records, and viewer evictions.

## Reference-parser provenance

The copied source is from
<https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Data-Streaming>, commit
5411ba59a12882345d32218eda367bd6ba35ef5d, source root
reference/browser/src. The complete copied paths are:

~~~text
binary-envelope.js
capabilities-validator.js
control-parser.js
decoder-state.js
decoder.js
errors.js
protocol-constants.js
strict-json.js
value-validators.js
profiles/pcm-audio.js
profiles/vi-measurement.js
~~~

They are unmodified byte-for-byte source copies, including SPDX headers and the
transitive PCM module. The upstream Apache-2.0 LICENSE is copied unchanged to
LICENSES/Apache-2.0.txt; the upstream V/I golden vector is copied unchanged to
fixtures/golden/vi-frames.json.

The viewer calls public createDecoderState() and decodeBinaryFrame(); it does not
replace decoding with a custom parser. To update, intentionally select a new
upstream commit, copy the entire reference/browser/src tree and LICENSE without
edits, update this provenance text and src/protocol/README.md, review
compatibility, and rerun all tests. Compare this baseline with:

~~~sh
D2B_ORACLE="${D2B_ORACLE:-$HOME/Dev/Device-to-Browser-Data-Streaming}"

diff -qr src/protocol/d2b-reference \
  "$D2B_ORACLE/reference/browser/src"
cmp fixtures/golden/vi-frames.json \
  "$D2B_ORACLE/test-vectors/vi-frames.json"
cmp LICENSES/Apache-2.0.txt \
  "$D2B_ORACLE/LICENSE"
~~~

## Current UI and future work

The current Viewer is intentionally developer-oriented and
protocol-validation-oriented. It exposes connection state, protocol state,
decoded record details, bounded diagnostics, and explicit Open, Start, Stop,
and Close lifecycle controls. This detail supported protocol and integration
validation; it is not yet the final student-facing classroom UI.

The next major UI step is to move from the current developer-oriented Viewer to
an education-oriented Viewer while preserving all measurement, timestamp,
validity, gap, and lifecycle semantics. Likely goals include:

- larger Voltage and Current values;
- larger, clearer graphs with classroom-appropriate auto-scaling;
- fewer protocol and diagnostic controls;
- a simpler student-facing Start/Stop workflow and clearer measurement-state
  indicators;
- tablet- and Chromebook-friendly layouts;
- a large-display/presentation mode; and
- stronger focus on information that helps students understand the observed
  electrical phenomenon.

These are future-work goals only; they are not implemented by this docs-only
finalization.

## Limitations / explicitly not performed

- Direct iPad/Chromebook-to-VAMeter communication, formal Chromebook E2E
  qualification, multi-client operation, and long-soak testing have not been
  performed.
- CSV/export, device asset serving, GitHub Pages, and a production release have
  not been performed.
- This prototype is a viewer, not a capture persistence service, firmware image,
  production server, or security relay.
- The validation note embedded in the frozen runtime page predates the final
  physical run. It remains unchanged so the runtime source stays byte-for-byte
  equivalent to the physically validated commit; this README records the final
  Contest validation authority and scope.
