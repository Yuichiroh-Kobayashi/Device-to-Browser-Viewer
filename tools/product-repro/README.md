# Device-hosted product reproduction

These tools keep the device-hosted product Viewer separate from the
development/validation harness at the repository root. They use only Python's
standard library and objects already present in this Git repository. They do
not fetch, install, or substitute current harness source for a frozen input.

## Current product-development tests

From a clean checkout, materialize the missing import tree and run all product
tests:

~~~sh
python3 tools/product-repro/materialize-source-export.py
node --test src/product/p2-sp/tests/*.test.mjs
~~~

The materializer writes
`src/product/source-export/viewer/src/` from the exact `src/` tree at Viewer
commit `80a9cd308cb3c6c5a1ccc27241cd645803675921`. The generated tree is ignored
and must not be committed. Re-running the tool accepts an exact tree as an
idempotent no-op; a symlink, unexpected Git mode, missing file, extra file, or
byte mismatch fails without overwriting the existing target.

This current development path preserves every Git blob byte, including the LF
representation of `src/product/p2-sp/app.css`.

## Exact historical beta.1 reproduction

Run:

~~~sh
python3 tools/product-repro/verify-beta1-reproduction.py
~~~

The verifier independently materializes these pinned inputs in a disposable
temporary root:

- qualified product source commit
  `105bca2616ef372fe23ac0797f58b5c7383ee20c`;
- frozen source-export/runtime anchor
  `80a9cd308cb3c6c5a1ccc27241cd645803675921`;
- D2B authority `5411ba59a12882345d32218eda367bd6ba35ef5d`;
- recovered builder with SHA-256
  `616e1e4aff16d21b49f4d0b8f3c8bda46a5f47ad09d4a2eb9a0b0227ca06c5aa`.

The accepted beta.1 build used the same `app.css` text with a CRLF historical
input representation. The qualified Git blob is 1,686 LF bytes with SHA-256
`4801cc833dc751d8ddc78b3c8e37a27d7744cbe1932e3aad6bbed64075282a34`;
the historical input is 1,718 bytes with SHA-256
`9307bb0aefc010bb5ad00d22fa596b19341061782f91806a5918df6b79363f93`.
The verifier permits exactly that LF-to-CRLF transformation, only after checking
the source commit, path, bytes, hashes, LF/CRLF counts, and reverse byte
equivalence. It never changes the tracked CSS or makes CRLF a current/future
build rule.

The verifier copies the recovered builder and changes only its `EXPECTED_ROOT`
line in the disposable copy. It then checks the builder's two-run determinism
and every accepted stored representation against
[`beta1-accepted-viewer-identity.json`](../../docs/provenance/beta1-accepted-viewer-identity.json).
The snapshot is a historical verification oracle, not an expected bundle ID for
future product changes. A future product change must have a new bundle identity.

`/usr/bin/node`, webpack 5.76.1, and terser-webpack-plugin 5.3.7 are required.
The verifier performs no package installation. It exits nonzero and retains its
temporary evidence root when any authority, representation, toolchain,
determinism, byte count, or hash check differs.
