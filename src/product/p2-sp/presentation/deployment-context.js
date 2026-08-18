import { validateCapabilities } from "../../source-export/viewer/src/protocol/d2b-reference/capabilities-validator.js";

const PUBLIC_STATUS_REQUIRED_FIELDS = Object.freeze(["protocol", "version", "state", "uptime_us"]);
const PUBLIC_STATUS_COUNTER_FIELDS = Object.freeze(["producer_drop_count", "output_queue_drop_count", "connected_client_count"]);
const PUBLIC_STATUS_FIELDS = new Set([...PUBLIC_STATUS_REQUIRED_FIELDS, ...PUBLIC_STATUS_COUNTER_FIELDS]);

const SHA256_ROUND_CONSTANTS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(value, amount) {
  return ((value >>> amount) | (value << (32 - amount))) >>> 0;
}

/** Dependency-free FIPS 180-4 SHA-256 over a byte range; used only when crypto.subtle is unavailable. */
function sha256FallbackDigest(view) {
  const messageBits = view.byteLength * 8;
  const paddedLength = (((view.byteLength + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLength);
  padded.set(view);
  padded[view.byteLength] = 0x80;
  const bitsHigh = Math.floor(messageBits / 0x100000000) >>> 0;
  const bitsLow = messageBits >>> 0;
  const tail = paddedLength - 8;
  padded[tail] = (bitsHigh >>> 24) & 0xff; padded[tail + 1] = (bitsHigh >>> 16) & 0xff;
  padded[tail + 2] = (bitsHigh >>> 8) & 0xff; padded[tail + 3] = bitsHigh & 0xff;
  padded[tail + 4] = (bitsLow >>> 24) & 0xff; padded[tail + 5] = (bitsLow >>> 16) & 0xff;
  padded[tail + 6] = (bitsLow >>> 8) & 0xff; padded[tail + 7] = bitsLow & 0xff;

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let t = 0; t < 16; t += 1) {
      const base = offset + t * 4;
      w[t] = ((padded[base] << 24) | (padded[base + 1] << 16) | (padded[base + 2] << 8) | padded[base + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr32(w[t - 15], 7) ^ rotr32(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr32(w[t - 2], 17) ^ rotr32(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_ROUND_CONSTANTS[t] + w[t]) >>> 0;
      const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  const hex = (word) => word.toString(16).padStart(8, "0");
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
}

export async function sha256RawBytes(bytes, cryptoImpl = globalThis.crypto) {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (cryptoImpl === globalThis.crypto && globalThis.crypto?.subtle?.digest) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", view);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  if (cryptoImpl?.subtle?.digest) {
    const digest = await cryptoImpl.subtle.digest("SHA-256", view);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return sha256FallbackDigest(view);
}

function samePageAndWsAuthority(pageAuthority, configuredWsAuthority) {
  try {
    const page = new URL(pageAuthority); const ws = new URL(configuredWsAuthority);
    return page.host === ws.host && ((page.protocol === "https:" && ws.protocol === "wss:") || (page.protocol === "http:" && ws.protocol === "ws:"));
  } catch { return false; }
}

export function assessDeployment({ target, pageAuthority, configuredWsAuthority, manifestHash, deviceBundleId, explicitDeveloperConfiguration = false }) {
  if (target === "device-hosted") {
    if (!manifestHash || !deviceBundleId) return Object.freeze({ target, startAllowed: false, message: "機器情報を確認できません", bundleStatus: "identity-unavailable" });
    const sameAuthority = samePageAndWsAuthority(pageAuthority, configuredWsAuthority);
    const sameBundle = manifestHash === deviceBundleId;
    if (!sameBundle) return Object.freeze({ target, startAllowed: false, message: "Viewerの更新状態が一致しません", bundleStatus: "mismatch" });
    return Object.freeze({ target, startAllowed: sameAuthority, message: sameAuthority ? "一致" : "Viewerと接続先が一致しません", bundleStatus: sameAuthority ? "matched" : "authority-mismatch" });
  }
  if (target === "external-development" && explicitDeveloperConfiguration) return Object.freeze({ target, startAllowed: true, message: "developer configuration", bundleStatus: "not-required" });
  return Object.freeze({ target: "external-development", startAllowed: false, message: "explicit developer configuration required", bundleStatus: "not-required" });
}

function advertisesLiveVi(capabilities) {
  return capabilities.streams.some((stream) => stream.id === "live-vi" && stream.profiles.some((profile) => profile.profile === "vi-measurement" && profile.parameter_sets.some((parameters) => (
    parameters.sample_format === "vi-f32le" && parameters.channel_count === 2 && parameters.channel_mask === 3 &&
    parameters.sample_rate?.numerator === 0 && parameters.sample_rate?.denominator === 0
  ))));
}

function isRedactedPublicStatus(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return false;
  if (Object.keys(status).some((key) => !PUBLIC_STATUS_FIELDS.has(key))) return false;
  if (status.protocol !== "d2b-stream" || status.version !== "0.1" || !["idle", "streaming"].includes(status.state)) return false;
  if (!PUBLIC_STATUS_REQUIRED_FIELDS.every((field) => Object.hasOwn(status, field))) return false;
  return ["uptime_us", ...PUBLIC_STATUS_COUNTER_FIELDS]
    .filter((field) => Object.hasOwn(status, field))
    .every((field) => Number.isSafeInteger(status[field]) && status[field] >= 0);
}

export async function bootstrapDeviceHosted({ fetcher = fetch, pageAuthority, configuredWsAuthority }) {
  try {
    const [manifestResponse, deviceResponse, capabilitiesResponse, statusResponse] = await Promise.all([
      fetcher("/viewer/asset-manifest.json"), fetcher("/viewer/device.json"), fetcher("/d2b/v0/capabilities"), fetcher("/d2b/v0/status"),
    ]);
    if (![manifestResponse, deviceResponse, capabilitiesResponse, statusResponse].every((response) => response.ok)) throw new Error("bootstrap response");
    const rawManifest = await manifestResponse.arrayBuffer();
    const manifestHash = await sha256RawBytes(rawManifest);
    JSON.parse(new TextDecoder().decode(rawManifest));
    const device = await deviceResponse.json();
    const capabilities = validateCapabilities(await capabilitiesResponse.json());
    const status = await statusResponse.json();
    if (!advertisesLiveVi(capabilities) || !isRedactedPublicStatus(status)) throw new Error("invalid public status");
    return assessDeployment({ target: "device-hosted", pageAuthority, configuredWsAuthority, manifestHash, deviceBundleId: device.viewer_bundle_id });
  } catch { return Object.freeze({ target: "device-hosted", startAllowed: false, message: "機器情報を確認できません", bundleStatus: "identity-unavailable" }); }
}
