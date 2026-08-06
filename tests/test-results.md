# Test results (primary validation session)

The final local project path was `/home/yu-ichirou/Dev/Device-to-Browser-Viewer`.
Run it with `python3 tools/serve.py`; the index is at
<http://127.0.0.1:8080/> and browser self-tests are at
<http://127.0.0.1:8080/tests/>.

## Oracle and reference harness

At D2B baseline commit `5411ba59a12882345d32218eda367bd6ba35ef5d`,
`python3 tools/validate_test_vectors.py` passed 3 schemas, 95 golden vectors,
2 negative self-tests, and 7 mutation tests.

The reference browser harness at
<http://127.0.0.1:8000/reference/browser/> reported:

- Chrome 150.0.7871.187: 95/95, parser-core 12/12, FAIL 0, no window errors.
- Edge 151.0.4129.59: 95/95, parser-core 12/12, FAIL 0, no window errors.

## Viewer checks

~~~sh
cd /home/yu-ichirou/Dev/Device-to-Browser-Viewer
node --test tests/node-self-tests.mjs
node tests/node-self-tests.mjs
python3 -m py_compile tools/serve.py
~~~

`node --test tests/node-self-tests.mjs` exited 0. Direct
`node tests/node-self-tests.mjs` reported 16/16 named semantic checks. The
`py_compile` check also exited 0.

Browser self-tests at `/tests/` reported TOTAL 14, PASS 14, FAIL 0 in both
Chrome and Edge. The scenario observations were:

- S1 stable: 250/1.
- S2 step: 250/1.
- S3 producer gap: 245/2, with gap 5 and producer 1.
- S4 output drop: 247/2, with gap 3 and output 1.
- S5 validity: invalid voltage/current 126/125.
- S6 reconnect: 250/2.
- S7 invalid-frame: `bad_magic` diagnostic, 250 accepted, and no fabricated gap.

The authoritative VAMeter fixture validator was run as follows from the final
project root:

~~~sh
python3 /home/yu-ichirou/Dev/worktrees/VAMeter-Edu/d2b-vi-planA-live/tests/d2b_vi_integration/validate_live_capture.py \
  --oracle /home/yu-ichirou/Dev/Device-to-Browser-Data-Streaming fixtures/capture/synthetic-live-capture.json
~~~

It passed with 2 data frames/2 samples and `stream_id` 7.

Server smoke checks returned index `200 text/html`, JavaScript `200 text/javascript`,
and traversal `403`. Parser, golden-vector, and license provenance byte
comparisons exited 0 with no diff.

Short synthetic/browser runs kept ring usage at or below 250 records. Hard
automated caps are 4096 records, 512 markers, and 100 diagnostics; no long
browser soak or heap-trend measurement was performed. Chrome/Edge screenshots
were saved outside Git as validation evidence and are not committed artifacts.

The viewer has no external packages, CDN dependencies, or telemetry.

## Explicit limitations

Live WebSocket mode is implemented but **NOT PHYSICALLY VALIDATED**. Live
VAMeter/iPad testing, long soak, CSV/export, device asset serving, GitHub Pages,
and a production release were not performed.
