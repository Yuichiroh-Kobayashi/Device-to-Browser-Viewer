# Copied d2b browser reference source

`d2b-reference/` is an unmodified, byte-for-byte source copy of the browser
reference source from:

- repository: <https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Data-Streaming>
- baseline commit: `b30ad676922af73448952d5a9cac312467a944f9`
- source root: `reference/browser/src`
- copied paths: `binary-envelope.js`, `capabilities-validator.js`,
  `control-parser.js`, `decoder-state.js`, `decoder.js`, `errors.js`,
  `protocol-constants.js`, `public-status-validator.js`, `strict-json.js`,
  `value-validators.js`,
  `profiles/pcm-audio.js`, and `profiles/vi-measurement.js`.

The Apache-2.0 license is retained at `../../LICENSES/Apache-2.0.txt`; all copied
files retain their SPDX headers. The Viewer calls the public
`createDecoderState()`, `decodeBinaryFrame()`, and `validatePublicStatus()`
APIs and does not substitute its own binary or public-status validator.

To update deliberately, select the merged upstream commit, copy the entire source
root without editing it, confirm its `LICENSE`, update the recorded commit and
path list, then review compatibility and rerun tests. Verify the complete tree
and Public Status R1 corpus with:

```sh
D2B_ORACLE="${D2B_ORACLE:-$HOME/Dev/Device-to-Browser-Data-Streaming}"

diff -qr src/protocol/d2b-reference \
  "$D2B_ORACLE/reference/browser/src"
cmp fixtures/golden/public-status.json \
  "$D2B_ORACLE/test-vectors/public-status.json"
```
