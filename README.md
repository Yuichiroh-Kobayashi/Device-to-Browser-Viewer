# Device-to-Browser V/I Viewer prototype

A dependency-free static prototype for viewing and replaying d2b-stream/0.1
vi-measurement data. It preserves the decoder's exact BigInt sequence and device
timestamp fields, makes loss and invalidity visible, and intentionally does not
claim physical-device validation.

## Run locally

~~~
cd /home/yu-ichirou/Dev/Device-to-Browser-Viewer
python3 tools/serve.py
~~~

Open <http://127.0.0.1:8080/>. A deterministic screenshot-friendly preview is:

~~~
http://127.0.0.1:8080/?source=synthetic&scenario=stable&autostart=1
~~~

The browser self-test page is <http://127.0.0.1:8080/tests/>. It visibly emits
machine-readable TOTAL, PASS, and FAIL values; the primary validation pass ran
it in both Chrome and Edge (TOTAL 13, PASS 13, FAIL 0). The static server binds
only to 127.0.0.1 by default, does not auto-open a browser, has no telemetry,
and rejects path traversal.

Run the DOM-free automated tests:

~~~
node --test tests/node-self-tests.mjs
node tests/node-self-tests.mjs
python3 -m py_compile tools/serve.py
python3 /home/yu-ichirou/Dev/worktrees/VAMeter-Edu/d2b-vi-planA-live/tests/d2b_vi_integration/validate_live_capture.py \
  --oracle /home/yu-ichirou/Dev/Device-to-Browser-Data-Streaming fixtures/capture/synthetic-live-capture.json
~~~

The Node test file contains 13 named semantic checks, including S1–S7 scenario
smoke coverage, exact capture schema validation, and a legacy-frame-shape
rejection. The external validator is the authoritative VAMeter live-capture
check; it validates the fixture against the copied d2b reference oracle.

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

## Primary-session validation evidence

The final local project path was
`/home/yu-ichirou/Dev/Device-to-Browser-Viewer`; it was served with
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
  `node tests/node-self-tests.mjs` reported 13/13.
- Browser self-tests at `/tests/` reported TOTAL 13, PASS 13, FAIL 0 in both
  Chrome and Edge.
- S1 stable: 250/1; S2 step: 250/1; S3 producer gap: 245/2 (gap 5,
  producer 1); S4 output drop: 247/2 (gap 3, output 1); S5 validity: invalid
  voltage/current 126/125; S6 reconnect: 250/2; S7 invalid-frame:
  `bad_magic` diagnostic, 250 accepted, and no fabricated gap.

The authoritative VAMeter fixture check was run with:

~~~sh
python3 /home/yu-ichirou/Dev/worktrees/VAMeter-Edu/d2b-vi-planA-live/tests/d2b_vi_integration/validate_live_capture.py \
  --oracle /home/yu-ichirou/Dev/Device-to-Browser-Data-Streaming fixtures/capture/synthetic-live-capture.json
~~~

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

Live WebSocket mode is a direct implementation of hello, welcome, start_stream,
stream_started, binary data, stop_stream, observed STREAM_END, stream_stopped,
close/error, and reopen readiness. Its endpoint defaults to
ws://current-host/d2b/v0/stream (or a local placeholder when there is no browser
host). It uses binaryType = arraybuffer and intentionally does not weaken
origin/security behavior or add a CORS/relay bypass.

**Live mode is implemented, NOT PHYSICALLY VALIDATED. No live-device PASS is
claimed.**

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
diff -qr src/protocol/d2b-reference \
  /home/yu-ichirou/Dev/Device-to-Browser-Data-Streaming/reference/browser/src
cmp fixtures/golden/vi-frames.json \
  /home/yu-ichirou/Dev/Device-to-Browser-Data-Streaming/test-vectors/vi-frames.json
cmp LICENSES/Apache-2.0.txt \
  /home/yu-ichirou/Dev/Device-to-Browser-Data-Streaming/LICENSE
~~~

## Limitations / explicitly not performed

- Live WebSocket mode is implemented but **NOT PHYSICALLY VALIDATED**. Live
  VAMeter/iPad interoperability and long-soak testing have not been performed.
- CSV/export, device asset serving, GitHub Pages, and a production release have
  not been performed.
- This prototype is a viewer, not a capture persistence service, firmware image,
  production server, or security relay.
