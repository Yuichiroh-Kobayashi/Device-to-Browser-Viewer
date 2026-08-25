# Viewer source authority

This document is source and build provenance evidence. It does not describe
current product behavior; for the current device-hosted product contract, see
[`docs/product/beta1-device-hosted-viewer-contract.md`](product/beta1-device-hosted-viewer-contract.md).
For the two-layer split between the device-hosted product Viewer and the
development/validation harness, see the top of [`README.md`](../README.md).

1. Device-to-Browser-Viewer base/regression lineage:
   `bef258e16513bd7e12cc15198d97af3203c70f91`

2. Contest physical runtime validation anchor:
   `80a9cd308cb3c6c5a1ccc27241cd645803675921`

3. P2-SP product source:
   `src/product/p2-sp/`

4. Recovered exact builder:
   `tools/p2-builder/p2-builder.py`

5. P2-SP recovery generation:
   `20260814-1407-g1-ms-r2`

6. Accepted historical P2-SP bundle identity:
   `9053e0a206070c1b5c137cd8f563a58e335addac67a737a26d45e62853df52ce`

7. Historical `viewer_source_commit` ambiguity:
   the historical Git Viewer commit represented the base/regression Viewer
   lineage, not the complete P2-SP product source. This commit restores that
   missing product-source lineage into Git.

8. The current `src/protocol/d2b-reference` is an exact whole-tree copy of
   D2B authority commit `b30ad676922af73448952d5a9cac312467a944f9`
   and `reference/browser/src` tree OID
   `6e5b4844548c1355dea7e5cbbcb1200c9d2335fd`, including the Public Status
   Standard R1 `validatePublicStatus()` reference source.
   Historical beta.1 reproduction remains pinned separately to
   `5411ba59a12882345d32218eda367bd6ba35ef5d`.

9. This commit does not fix the `deployment-context.js` WebCrypto/secure-context
   problem.

10. That behavior change is a separate, later change (not part of this commit).

11. The missing product import tree is materialized by
    `tools/product-repro/materialize-source-export.py` as a composite: the
    exact `80a9cd308cb3c6c5a1ccc27241cd645803675921:src` historical base,
    with only `src/protocol/d2b-reference/` replaced by tracked blobs from the
    current Viewer HEAD. The generated `src/product/source-export/` tree is
    ignored and is not a second source authority. An exact existing composite
    is an idempotent pass; unknown content is not overwritten or deleted. The
    materializer verifies the copied subtree tree OID before materialization.

12. A clean product-development layout uses the current Git blob
    representation unchanged. After materialization, all five
    `src/product/p2-sp/tests/*.test.mjs` files load and pass without
    `ERR_MODULE_NOT_FOUND`.

13. `tools/product-repro/verify-beta1-reproduction.py` independently reproduced
    the accepted beta.1 device-hosted bundle ID
    `cbcbd7eab111b49c0c6119b22a7f50ae55981933fd799abfd98d92d0dc5d96e5`
    from qualified product source `105bca2616ef372fe23ac0797f58b5c7383ee20c`,
    frozen source-export `80a9cd308cb3c6c5a1ccc27241cd645803675921`,
    and the byte-identical recovered builder. The accepted identity snapshot is
    `docs/provenance/beta1-accepted-viewer-identity.json`.

14. The qualified `app.css` Git blob is 1,686 LF bytes, SHA-256
    `4801cc833dc751d8ddc78b3c8e37a27d7744cbe1932e3aad6bbed64075282a34`.
    The accepted beta.1 builder input used the same text as a 1,718-byte CRLF
    representation, SHA-256
    `9307bb0aefc010bb5ad00d22fa596b19341061782f91806a5918df6b79363f93`.
    Only the historical verifier performs this fail-closed LF-to-CRLF adapter
    in a disposable tree. It is not a current or future source/build policy.

15. Exact bundle reproduction and the five product tests prove the
    `80a9cd308cb3c6c5a1ccc27241cd645803675921:src` source-export hypothesis
    for this beta.1 authority. They do not make the current development harness
    a substitute product authority.

16. No Windows Relay becomes production architecture as a result of this change.

17. No machine-specific absolute paths appear in this document or in
    `docs/provenance/p2-sp-source-manifest.tsv`.

18. `tools/product-repro/build-current-product.py` builds a new current
    Student+Professional candidate only from a clean committed Viewer HEAD. It
    uses the recovered builder through a disposable adapter that changes only
    `EXPECTED_ROOT`, `VIEWER_COMMIT`, `D2B_COMMIT`, and (see item 21)
    `PROTOTYPE_ALLOWLIST`; the tracked historical builder remains
    byte-identical. The copied D2B subtree must match the pinned tree OID
    before an evidence root or builder adaptation is created.

19. Current product builds use the tracked LF `app.css` unchanged. The
    historical beta.1 CRLF adapter remains exclusive to
    `verify-beta1-reproduction.py`.

20. Merging a Viewer candidate does not update the bundle served by an existing
    VAMeter-Edu firmware image. The Firmware `/status` producer needs no logic
    change for R1, but a later Firmware Viewer AssetPool/bundle intake is
    required to serve the new Viewer identity.

21. The recovered historical builder's own `PROTOTYPE_ALLOWLIST` is frozen at
    its recovered identity (`BUILDER_SHA256` in
    `tools/product-repro/build-current-product.py`) and reflects only the
    files approved as of that recovery. A later, deliberately reviewed
    current-product change (for example a new `src/product/p2-sp/` source or
    test file) is not automatically accepted: `build-current-product.py` owns
    its own explicit `CURRENT_PRODUCT_ALLOWLIST`, checked with
    `verify_current_product_file_scope()` against the exact committed files
    under `HEAD:src/product/p2-sp/` before any evidence root or builder
    adaptation is created. A missing or unreviewed-extra file fails closed
    with `CURRENT_PRODUCT_FILE_SCOPE_APPROVAL_REQUIRED` (mirroring the
    historical builder's own `SCRATCH_FILE_SCOPE_APPROVAL_REQUIRED`, which
    still guards the disposable copy's own file enumeration at build time).
    There is no wildcard or implicit "whatever exists in HEAD is approved"
    behavior in either check. When `CURRENT_PRODUCT_ALLOWLIST` differs from
    the historical builder's own `PROTOTYPE_ALLOWLIST`, the disposable
    adapter additionally substitutes the disposable copy's
    `PROTOTYPE_ALLOWLIST` block with the current, explicitly reviewed
    allowlist -- reversing all four disposable substitutions still reproduces
    the tracked historical builder byte-for-byte. Extending
    `CURRENT_PRODUCT_ALLOWLIST` to include a new file is a deliberate source
    edit to `build-current-product.py`, not a build-time convenience. This
    rule does not change historical beta.1 reproduction, which continues to
    use the recovered builder's own historical `PROTOTYPE_ALLOWLIST`
    unmodified via `verify-beta1-reproduction.py`.
