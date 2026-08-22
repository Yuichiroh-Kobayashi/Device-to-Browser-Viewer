# Beta.1 device-hosted Viewer contract

This document is the current beta.1 product contract for the device-hosted Viewer. The product source is [`src/product/p2-sp/`](../../src/product/p2-sp/); its historical source and build provenance is recorded unchanged in [`docs/viewer-source-authority.md`](../viewer-source-authority.md) and [`docs/provenance/`](../provenance/) and is not repeated here.

## Restored Contest parity

- Voltage and Current waveforms use device timestamps, preserve gaps, and never turn invalid samples into zero.
- The action DOM remains stable during live-frame presentation updates so a human Stop press retains its node identity.
- The device-time display window offers exactly 10, 30, and 60 seconds, defaults to 60 seconds, and changes without reconnecting or restarting the stream.
- Professional mode always presents both Voltage and Current graphs.
- Student mode presents graphs from the exact device `display_name`: `Voltage` shows Voltage only, `Current` shows Current only, and `Both` shows both.
- A device-hosted bootstrap with a missing, malformed, unknown, or case-altered `display_name` fails closed. There is no silent `Both` fallback.

## Preserved and deferred decisions

- Numeric values retain `value.toFixed(3)` for beta.1.
- Analog-style browser numeric presentation has not been decided and is not implemented for beta.1. There is no GitHub Issue tracking it yet; do not present it as a committed roadmap item until one exists.
- Multi-client product policy beyond the existing one-active-owner D2B safety contract is deferred; it is tracked at [VAMeter-Edu Issue #8](https://github.com/Yuichiroh-Kobayashi/VAMeter-Edu/issues/8).
- The frozen D2B policy of one active stream owner, wrong-owner rejection, and relay safety is unchanged.
- New lifecycle diagnostic state and an explicit new timebase-reset UI state are deferred when they would require new mutable runtime state. Professional diagnostics reuse only existing bounded state.

## Device-hosted exclusions

Synthetic generation, capture replay, replay speed, and an arbitrary WebSocket endpoint are intentionally excluded from the device-hosted product. They remain development-only capabilities and must not be retained in the device-hosted bundle.

No feature that has not received an explicit release classification may be promoted into this contract. This contract does not issue beta.1 GO, a production qualification, or a multi-client behavior claim.
