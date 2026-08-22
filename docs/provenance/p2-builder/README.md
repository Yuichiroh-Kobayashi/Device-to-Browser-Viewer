# p2-builder provenance

- builder SHA-256: `616e1e4aff16d21b49f4d0b8f3c8bda46a5f47ad09d4a2eb9a0b0227ca06c5aa`
- line count: 368
- committed builder: exact recovered bytes
- `EXPECTED_ROOT`: intentionally unchanged in this commit
- Git-managed reproduction: requires a throwaway-copy adapter/harness that
  substitutes the real checkout root for `EXPECTED_ROOT` in a disposable copy,
  never in the committed file
- adapter: must not mutate the committed builder
- V0 precedent: a one-line `EXPECTED_ROOT` adaptation was treated as
  test-harness behavior, not a product change, when this bundle was originally
  reproduced
- actual reproduction from this Git-managed source: not run as part of this
  commit
