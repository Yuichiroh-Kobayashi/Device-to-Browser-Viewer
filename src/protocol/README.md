# Copied d2b reference parser

`d2b-reference/` is an unmodified, byte-for-byte source copy of the browser
reference parser from:

- repository: <https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Data-Streaming>
- baseline commit: `5411ba59a12882345d32218eda367bd6ba35ef5d`
- source root: `reference/browser/src`
- copied paths: `binary-envelope.js`, `capabilities-validator.js`,
  `control-parser.js`, `decoder-state.js`, `decoder.js`, `errors.js`,
  `protocol-constants.js`, `strict-json.js`, `value-validators.js`,
  `profiles/pcm-audio.js`, and `profiles/vi-measurement.js`.

The Apache-2.0 license is retained at `../../LICENSES/Apache-2.0.txt`; all copied
files retain their SPDX headers. The viewer calls the public
`createDecoderState()` and `decodeBinaryFrame()` APIs and does not substitute its
own binary parser.

To update deliberately, check out the new upstream commit, copy the entire source
root without editing it, copy its `LICENSE`, update the recorded commit and path
list, then review parser compatibility and rerun tests. Verify this baseline with:

```sh
diff -qr src/protocol/d2b-reference \
  /home/yu-ichirou/Dev/Device-to-Browser-Data-Streaming/reference/browser/src
```
