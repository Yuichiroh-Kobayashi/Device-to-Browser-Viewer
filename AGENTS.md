# Working agreement

This tree is a dependency-free static prototype. Keep the copied
`src/protocol/d2b-reference/` directory byte-for-byte identical to its documented
upstream baseline. Do not add package dependencies, telemetry, upload paths, or a
server-side relay. Generated captures, screenshots, browser profiles, and logs are
ignored; the small deterministic fixtures and tests are intentional source files.

The model retains device timestamps and sequences as `BigInt`. Browser receipt time
is scheduling metadata only and must never become a measurement X coordinate.

## Two things in one repository

Read [`README.md`](README.md) before editing anything. This repository holds
two distinct trees and they must not be conflated:

- The device-hosted product Viewer at `src/product/p2-sp/`, documented as
  current product behavior in
  [`docs/product/beta1-device-hosted-viewer-contract.md`](docs/product/beta1-device-hosted-viewer-contract.md),
  with source/build provenance in
  [`docs/viewer-source-authority.md`](docs/viewer-source-authority.md) and
  [`docs/provenance/`](docs/provenance/).
- The development/validation harness at the repository root (`index.html`,
  `src/` outside `src/product/`, `tools/serve.py`).

Do not describe development-only capabilities (synthetic generation, capture
replay, replay speed, an arbitrary WebSocket endpoint) as part of the
device-hosted product. Do not describe the device-hosted product's Student/
Professional contract as though it were the harness's default developer UI.

## Future work

Future work belongs in current, real GitHub Issues, not in unlinked roadmap
prose or internal process labels (`DEFERRED_AFTER_...`, `PARTIAL`, `frozen
G*`, stage/gate names). Do not invent an Issue link for an idea that has none
— state plainly that it is undecided instead. Do not create or mutate
GitHub Issues unless the user explicitly asks for that specific action.

## Before broad or multi-file edits

Read the current source, tests, and relevant `docs/` (`docs/product/`,
`docs/viewer-source-authority.md`, `docs/provenance/`) before changing
recorder-adjacent, protocol, or provenance-facing text. Do not assume a past
document is still accurate; verify against current source/tests. For
multi-file or broad changes, produce a short plan first.

## Physical and provenance claims

State only what has direct evidence (a recorded test run, a physical
validation note, a provenance manifest). Historical evidence under
`docs/archive/` is preserved unchanged and is not current product authority;
do not treat it as a live claim, and do not silently mark an unresolved
license/release status as resolved.

## Product source reproduction

- Before product-source work, run
  `python3 tools/product-repro/materialize-source-export.py` and all
  `src/product/p2-sp/tests/*.test.mjs` tests.
- The generated `src/product/source-export/` tree composes the pinned
  historical `80a9cd...:src` base with the current Viewer HEAD's tracked
  `src/protocol/d2b-reference/` blobs. It must not be committed or replaced
  with working-tree bytes or the current root harness.
- Current D2B provenance is the pinned commit plus exact copied-reference Git
  tree OID. Materialization and current candidate builds must verify the
  current HEAD subtree against that OID before generating any output.
- `tools/product-repro/verify-beta1-reproduction.py` verifies historical
  beta.1 only. Its app.css LF-to-CRLF adapter is restricted to the exact pinned
  beta.1 input inside a disposable tree; it is not a current product build
  rule.
- The accepted beta.1 identity is not the expected hash for future product
  changes. Any future product source change requires a new bundle identity.
- Build a current product candidate only from a clean final HEAD with
  `python3 tools/product-repro/build-current-product.py`. Any later tracked
  commit invalidates that candidate and requires a rebuild.
- Do not change product runtime source or the recovered historical builder to
  make the Issue #4 reproduction checks pass.

## Git safety

- The primary checkout should normally remain on `main`.
- Do not push directly to `main`, force-push, merge, tag, or mutate releases
  without the user's explicit authorization for that exact action.
- Prefer a linked worktree and a feature branch for changes, then a normal
  push and a pull request against `main`.
- Do not run destructive Git operations (`reset --hard`, `clean`, forced
  branch updates, worktree/branch deletion) without explicit authorization.
