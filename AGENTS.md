# Working agreement

This tree is a dependency-free static prototype. Keep the copied
`src/protocol/d2b-reference/` directory byte-for-byte identical to its documented
upstream baseline. Do not add package dependencies, telemetry, upload paths, or a
server-side relay. Generated captures, screenshots, browser profiles, and logs are
ignored; the small deterministic fixtures and tests are intentional source files.

The model retains device timestamps and sequences as `BigInt`. Browser receipt time
is scheduling metadata only and must never become a measurement X coordinate.
