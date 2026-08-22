# Beta.1 device-hosted Viewer contract

This document is the current beta.1 product contract for the device-hosted Viewer. The product source is [`src/product/p2-sp/`](../../src/product/p2-sp/); its historical source and build provenance is recorded unchanged in [`docs/viewer-source-authority.md`](../viewer-source-authority.md) and [`docs/provenance/`](../provenance/) and is not repeated here.

## Restored Contest parity

- Voltage and Current waveforms use device timestamps, preserve gaps, and never turn invalid samples into zero.
- The action DOM remains stable during live-frame presentation updates so a human Stop press retains its node identity.
- The device-time display window offers exactly 10, 30, and 60 seconds, defaults to 60 seconds, and changes without reconnecting or restarting the stream.
- Professional mode always presents both Voltage and Current graphs.
- Student mode presents graphs from the exact device `display_name`: `Voltage` shows Voltage only, `Current` shows Current only, and `Both` shows both.
- A device-hosted bootstrap with a missing, malformed, unknown, or case-altered `display_name` fails closed. There is no silent `Both` fallback.

## Current beta.1 boundaries

- Numeric values retain `value.toFixed(3)` for beta.1.
- Analog-meter answer-check display correction (アナログ計器の答え合わせ用表示補正) is not implemented for beta.1. It is a presentation-only correction to the value shown at an explicit student answer-check step, matched to the pointer of the physical analog meter and range the student is reading; it does not correct CSV records, D2B measurement values, or any other point in the measurement pipeline. It is tracked at [VAMeter-Edu Issue #9](https://github.com/Yuichiroh-Kobayashi/VAMeter-Edu/issues/9) ("design pointer-matching presentation profile"), which specifies that a missing, malformed, mismatched, or unknown-version profile disables the correction and falls back to the normal measurement value.
- Multi-client product policy beyond the existing one-active-owner D2B safety contract is not addressed by beta.1; it is tracked at [VAMeter-Edu Issue #8](https://github.com/Yuichiroh-Kobayashi/VAMeter-Edu/issues/8).
- The frozen D2B policy of one active stream owner, wrong-owner rejection, and relay safety is unchanged.
- beta.1 does not add a dedicated mutable lifecycle-diagnostic state or a separate timebase-reset UI state. Professional diagnostics reuse only existing bounded state.

## Device-hosted exclusions

Synthetic generation, capture replay, replay speed, and an arbitrary WebSocket endpoint are intentionally excluded from the device-hosted product. They remain development-only capabilities and must not be retained in the device-hosted bundle.

This document describes beta.1 product behavior. It does not by itself establish production qualification or multi-client support.

## Source reproduction

The accepted beta.1 device-hosted bundle can be reproduced exactly from pinned Git-managed inputs. Current product tests use an ignored source-export generated without byte conversion; historical reproduction applies the proven beta.1 CRLF representation of `app.css` only inside a disposable verifier tree. See [`tools/product-repro/README.md`](../../tools/product-repro/README.md), [`docs/viewer-source-authority.md`](../viewer-source-authority.md), and [Device-to-Browser-Viewer Issue #4](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/4).

This source/build provenance repair does not modify the beta.1 runtime, its accepted bundle identity, Firmware/AssetPool, or the recorded physical validation.
