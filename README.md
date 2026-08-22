# Device-to-Browser Viewer

This repository contains two distinct things. Keep them separate when reading
or extending this repository:

1. **The device-hosted product Viewer** (`src/product/p2-sp/`) — the Student /
   Professional Viewer shipped as part of VAMeter-Edu `v2.0.0-beta.1`. The
   device serves this bundle directly; no PC, cloud account, or relay is
   required. See [Device-hosted product Viewer](#device-hosted-product-viewer).
2. **The development / validation harness** (this repository's root
   `index.html`, `src/`, `tools/serve.py`) — a dependency-free,
   developer-oriented Viewer used to develop and validate `d2b-stream/0.1`
   `vi-measurement` handling: synthetic generation, saved-capture replay, and
   a raw live-WebSocket connection to an arbitrary endpoint. It is not the
   device-hosted product bundle and these development-only capabilities are
   intentionally excluded from it. See
   [Development / validation harness](#development--validation-harness).

[日本語](README_ja.md)

## Device-hosted product Viewer

Source: [`src/product/p2-sp/`](src/product/p2-sp/). Current product contract:
[`docs/product/beta1-device-hosted-viewer-contract.md`](docs/product/beta1-device-hosted-viewer-contract.md).
Source/build provenance: [`docs/viewer-source-authority.md`](docs/viewer-source-authority.md)
and [`docs/provenance/`](docs/provenance/).

The published beta.1 bundle from this lineage is what VAMeter-Edu's
device-hosted Viewer profile currently serves directly from the device. A
current-source successor is not device-served until a later Firmware Viewer
AssetPool/bundle intake. VAMeter-Edu records physical validation on
Windows Edge 151 and an iPad 7th generation running iPadOS 18.7.9 Safari for
this device-hosted architecture (see VAMeter-Edu's
`docs/product/device-hosted-viewer-contract.md`). Current behavior:

- Student and Professional modes only; there is no presentation mode.
- Student mode follows the device's exact `display_name`: `Voltage` shows
  Voltage only, `Current` shows Current only, `Both` shows both. A missing,
  malformed, unknown, or case-altered `display_name` fails closed — there is
  no silent fallback to `Both`.
- Professional mode always shows both Voltage and Current graphs.
- Published beta.1 and current source both fail closed on invalid public status.
  Current post-beta.1 source performs that check with the exact Public Status
  Standard R1 `validatePublicStatus()` reference source; this is source/build
  evidence, not a claim that the successor bundle is already device-served.
- Voltage and Current waveforms use device timestamps, preserve gaps, and
  never turn an invalid sample into zero.
- The device-time display window offers exactly 10, 30, and 60 seconds,
  defaults to 60 seconds, and changes without reconnecting or restarting the
  stream.
- Live-frame presentation updates keep the action DOM node identities stable,
  so a human Stop press is not lost to node replacement.
- No cloud account, internet access, or separate PC is required when the
  Viewer is served by the device.

Synthetic generation, capture replay, replay speed, and an arbitrary
WebSocket endpoint are intentionally excluded from this device-hosted bundle;
those remain development-only capabilities of the harness described below.

The product's missing import tree is reproducible from pinned Git history. From
a clean checkout, run:

~~~sh
python3 tools/product-repro/materialize-source-export.py
node --test src/product/p2-sp/tests/*.test.mjs
~~~

The generated `src/product/source-export/` tree composes the historical
`80a9cd...:src` base with the current HEAD's tracked D2B reference subtree.
It is ignored and is not source authority. After committing all current product
changes, a clean final HEAD can build a deterministic new candidate with:

~~~sh
python3 tools/product-repro/build-current-product.py
~~~

Exact historical beta.1 reproduction is a separate operation:

~~~sh
python3 tools/product-repro/verify-beta1-reproduction.py
~~~

That verifier retains the recovered builder's tracked bytes, applies the
verified historical CRLF representation of beta.1 `app.css` only in its
disposable input, and checks the complete result against the accepted Firmware
identity. It does not impose CRLF on current or future product source. See
[`tools/product-repro/README.md`](tools/product-repro/README.md) and
[`docs/viewer-source-authority.md`](docs/viewer-source-authority.md) for the
exact authority and representation boundaries. This build/provenance repair
does not change the published beta.1 runtime or its physical validation. The
current Viewer candidate also does not update an already served device bundle:
Firmware producer logic needs no R1 change, but a later Firmware Viewer
AssetPool/bundle intake is required.

Future work on this Viewer is tracked as GitHub Issues, not as unlinked
roadmap prose:

- [Device-to-Browser-Viewer Issue #1](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/1) —
  simplify Student mode to a single Start/Stop control and keep actions above
  the fold.
- [Device-to-Browser-Viewer Issue #4](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/4) —
  records the device-hosted Viewer Git-source reproducibility repair and its
  clean-checkout acceptance criteria.
- [VAMeter-Edu Issue #8](https://github.com/Yuichiroh-Kobayashi/VAMeter-Edu/issues/8) —
  multi-client product policy beyond the existing one-active-owner D2B safety
  contract. This is owned by VAMeter-Edu because the frozen D2B policy of one
  active stream owner, wrong-owner rejection, and relay safety lives there.
- [VAMeter-Edu Issue #9](https://github.com/Yuichiroh-Kobayashi/VAMeter-Edu/issues/9) —
  analog-meter answer-check display correction (アナログ計器の答え合わせ用表示補正), a
  presentation-only correction to the answer-check display value that does
  not touch CSV, D2B measurement values, or the measurement pipeline. Owned
  by VAMeter-Edu; see
  [`docs/product/beta1-device-hosted-viewer-contract.md`](docs/product/beta1-device-hosted-viewer-contract.md)
  for its current beta.1 boundary.

## Development / validation harness

A dependency-free, developer-oriented Viewer for receiving and replaying
`d2b-stream/0.1` `vi-measurement` data. It displays Voltage and Current against
device time, preserves sequence and device timestamp values as `BigInt` where
required, and keeps loss and invalidity visible. This is the harness used to
develop and validate the protocol handling that the device-hosted product
Viewer above is built from; it is not itself served by the device.

### Run locally

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
machine-readable TOTAL, PASS, and FAIL values. Run the DOM-free automated
tests:

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
checked-in capture is synthetic and is not physical VAMeter evidence. See
[`tests/test-results.md`](tests/test-results.md) for the last recorded
automated-test validation session (Node/browser self-test counts, oracle
validation, and server smoke checks) in full detail; the summary is not
repeated here to avoid duplication.

### Layout

- src/protocol/session-adapter.js: application-owned
  CONNECTED → READY → STREAMING → READY/CLOSED state machine.
- src/protocol/d2b-reference/: byte-for-byte upstream parser source.
- src/sources/: synthetic, saved-capture replay, and direct WebSocket sources.
- src/model/: fixed-capacity records and bounded segment/gap metadata.
- src/render/: Canvas 2D device-time scale and waveforms.
- src/product/p2-sp/: the device-hosted product Viewer source (see above).
- fixtures/: upstream V/I golden vectors and a deterministic synthetic capture.
- tests/: browser and Node self-tests for the harness.
- tools/serve.py: local standard-library static server.

There are no npm packages, CDNs, React components, chart libraries, telemetry,
uploads, cloud calls, or build output.

### Contest 2026 physical validation

The harness's live-WebSocket mode was physically validated during Contest
2026 at Viewer commit `80a9cd308cb3c6c5a1ccc27241cd645803675921`, receiving
real V/I data over `VAMeter-Edu -> D2B -> Windows test-only Relay -> Viewer`
(`PLAN_N_WINDOWS_E2E_PASS`, `LIVE_PHYSICAL_DEMO_PASS`), and, via a temporary
Windows bridge, on an iPad Safari and a Chromebook Chrome browser. That
Windows-Relay-and-bridge topology is not the classroom architecture — it was
superseded by the device-hosted product Viewer described above, which the
device serves directly with no PC, Relay, or bridge required. Full narrative,
exact numbers, and result labels are preserved unchanged in
[`docs/archive/contest-2026/physical-validation-narrative.md`](docs/archive/contest-2026/physical-validation-narrative.md).

### Sources and scenarios

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
non-loopback warning, and CSP review. The licensing status of Viewer-owned
code has not yet been finalized for an independent Viewer production release;
the copied parser's Apache-2.0 provenance is unchanged. Long-soak
capacity-edge and heap-trend validation has not been performed.

### Semantics and bounds

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

### Reference-source provenance

The copied source is from
<https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Data-Streaming>, commit
b30ad676922af73448952d5a9cac312467a944f9, source root
reference/browser/src. The complete copied paths are:

~~~text
binary-envelope.js
capabilities-validator.js
control-parser.js
decoder-state.js
decoder.js
errors.js
protocol-constants.js
public-status-validator.js
strict-json.js
value-validators.js
profiles/pcm-audio.js
profiles/vi-measurement.js
~~~

They are unmodified byte-for-byte source copies, including SPDX headers and the
transitive PCM module. The upstream Apache-2.0 LICENSE is copied unchanged to
LICENSES/Apache-2.0.txt; the upstream V/I and Public Status R1 golden vectors
are copied unchanged to `fixtures/golden/`.

The Viewer calls public createDecoderState(), decodeBinaryFrame(), and
validatePublicStatus(); it does not replace decoding or public-status
validation with a custom implementation. To update, intentionally select a new
upstream commit, copy the entire reference/browser/src tree and LICENSE without
edits, update this provenance text and src/protocol/README.md, review
compatibility, and rerun all tests. Compare this baseline with:

~~~sh
D2B_ORACLE="${D2B_ORACLE:-$HOME/Dev/Device-to-Browser-Data-Streaming}"

diff -qr src/protocol/d2b-reference \
  "$D2B_ORACLE/reference/browser/src"
cmp fixtures/golden/vi-frames.json \
  "$D2B_ORACLE/test-vectors/vi-frames.json"
cmp fixtures/golden/public-status.json \
  "$D2B_ORACLE/test-vectors/public-status.json"
cmp LICENSES/Apache-2.0.txt \
  "$D2B_ORACLE/LICENSE"
~~~

### Harness limitations / explicitly not performed

- Direct iPad/Chromebook-to-VAMeter communication, formal Chromebook E2E
  qualification, multi-client operation, and long-soak testing have not been
  performed.
- CSV/export, device asset serving, GitHub Pages, and a production release have
  not been performed.
- This harness is a viewer, not a capture persistence service, firmware image,
  production server, or security relay.
- The validation note embedded in the frozen runtime page predates the final
  physical run. It remains unchanged so the runtime source stays byte-for-byte
  equivalent to the physically validated commit; this README records the final
  Contest validation authority and scope.

For device-hosted product limitations (multi-client policy, numeric
presentation style, etc.), see
[`docs/product/beta1-device-hosted-viewer-contract.md`](docs/product/beta1-device-hosted-viewer-contract.md).
