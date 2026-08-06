# Fixtures

- `golden/vi-frames.json` is copied byte-for-byte from the documented d2b
  upstream baseline. It is not generated or edited by this viewer.
- `capture/synthetic-live-capture.json` is a deterministic synthetic fixture,
  **not** a user or physical-device capture. It has the exact top-level fields
  `format`, `captured_at`, `user_agent`, `device_base_url`, `duration_seconds`,
  `capabilities_text`, `status_before_text`, `controls`, `frames`, and
  `status_after_text` used by VAMeter's `capture-live.js` format.

Capture controls each have exactly `event_index`, `received_ms`, `direction`, and
`text`. Frame entries each have exactly `event_index`, `received_ms`, and `hex`;
they deliberately have neither `direction` nor `frame_hex`. `received_ms` may be
fractional. Events are merged by contiguous `event_index`; `received_ms` is only
replay scheduling metadata, never graph time. Hex accepts lower- or upper-case
pairs. The viewer rejects files larger than 8 MiB or more than 100,000 combined
controls and frames, and drops the prepared capture plan on Close.
