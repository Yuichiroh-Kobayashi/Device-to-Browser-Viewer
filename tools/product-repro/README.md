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

The materializer writes a composite
`src/product/source-export/viewer/src/` from Git objects only:

- base: the exact `src/` tree at historical Viewer commit
  `80a9cd308cb3c6c5a1ccc27241cd645803675921`;
- overlay: the exact tracked `src/protocol/d2b-reference/` tree at the current
  Viewer `HEAD`, pinned in provenance to D2B commit
  `b30ad676922af73448952d5a9cac312467a944f9` and Git tree OID
  `6e5b4844548c1355dea7e5cbbcb1200c9d2335fd`.

The overlay replaces only the D2B reference subtree. Dirty working-tree bytes,
a sibling D2B checkout, and the network are never source authorities. The
materializer verifies the current HEAD subtree tree OID before inspecting or
creating the generated target. A mismatch fails before materialization. The
generated tree is ignored and must not be committed. Re-running the tool
accepts an exact composite as an idempotent no-op; a symlink, unexpected Git
mode, missing file, extra file, or byte mismatch fails without overwriting or
deleting the existing target.

This current development path preserves every Git blob byte, including the LF
representation of `src/product/p2-sp/app.css`.

## Current product candidate

After all tracked changes are committed and the Viewer worktree is clean, run:

~~~sh
python3 tools/product-repro/build-current-product.py
~~~

The standard-library-only tool materializes the current committed
`src/product/p2-sp/` source and the same composite source-export in a
collision-free `/tmp` evidence root. Before creating that root or adapting the
builder, it requires the current copied D2B subtree to match the pinned Git tree
OID, and it requires the exact committed files under `src/product/p2-sp/` to
match its own explicit `CURRENT_PRODUCT_ALLOWLIST` (see "Current-product file
scope" below) -- a missing or unreviewed-extra file fails closed before any
evidence root is created. It then verifies the recovered builder's tracked
SHA-256 `616e1e4aff16d21b49f4d0b8f3c8bda46a5f47ad09d4a2eb9a0b0227ca06c5aa`,
then changes exactly `EXPECTED_ROOT`, `VIEWER_COMMIT`, `D2B_COMMIT`, the
obsolete graph inventory entry, and `PROTOTYPE_ALLOWLIST` in a disposable copy. Current LF `app.css` is used
unchanged; the historical CRLF adapter is not applied.

### Current-product file scope

The recovered historical builder (`tools/p2-builder/p2-builder.py`) carries
its own `PROTOTYPE_ALLOWLIST`, frozen at the files approved when that builder
was recovered. It is never edited to accept a new file -- that would remove
its fail-closed approval boundary and is exactly the kind of change this tool
must not make (see the tracked `BUILDER_SHA256` identity check).

Instead, `build-current-product.py` owns a second, independent, explicit
allowlist -- `CURRENT_PRODUCT_ALLOWLIST` -- listing every file currently
approved for `src/product/p2-sp/`. Before doing anything else, it compares
this set against the exact committed files under `HEAD:src/product/p2-sp/`
and fails closed, with marker `CURRENT_PRODUCT_FILE_SCOPE_APPROVAL_REQUIRED`
and explicit `missing=[...] extra=[...]` lists, on any mismatch. There is no
wildcard acceptance of "whatever exists in HEAD".

When a deliberately reviewed product change adds a new `src/product/p2-sp/`
file, `CURRENT_PRODUCT_ALLOWLIST` in `build-current-product.py` must be
updated to include it as part of that same review -- this is a source edit to
the current-build tool, not something the tool infers automatically. Once
`CURRENT_PRODUCT_ALLOWLIST` is updated, the disposable adapter carries it into
the disposable builder copy's own `PROTOTYPE_ALLOWLIST`, so the disposable
copy's internal `validate_prototype()` check (which still independently
enumerates the disposable copy's own files at build time) is checked against
the same, currently-approved set. Reversing all five disposable substitutions
(`EXPECTED_ROOT`, `VIEWER_COMMIT`, `D2B_COMMIT`, the graph inventory entry,
`PROTOTYPE_ALLOWLIST`) still
reproduces the tracked historical builder byte-for-byte; the historical
builder's own `BUILDER_SHA256`/line-count identity is unchanged by any of
this. Historical beta.1 reproduction (`verify-beta1-reproduction.py`) is
unaffected -- it continues to use the recovered builder's own historical
`PROTOTYPE_ALLOWLIST` unmodified.

The JSON summary records the final Viewer commit, D2B commit/tree authority,
observed copied-tree OID, new bundle ID, stored representations, two-run
determinism, and evidence root. A later tracked commit invalidates that
candidate and requires another build. An external Protocol checkout is required
only when establishing or deliberately updating the pin.

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
