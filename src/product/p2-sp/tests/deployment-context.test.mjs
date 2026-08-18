import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { assessDeployment, bootstrapDeviceHosted, sha256RawBytes } from "../presentation/deployment-context.js";

const raw = new TextEncoder().encode('{"a":1}');
const reserialized = new TextEncoder().encode('{ "a": 1 }');
const hash = await sha256RawBytes(raw);
const reserializedHash = await sha256RawBytes(reserialized);
const validCapabilities = Object.freeze({
  protocol: "d2b-stream", version: "0.1", maximum_binary_frame_size: 48, maximum_control_message_size: 2048,
  maximum_active_stream_sessions: 1, maximum_control_connections: 1, persistent_capture_supported: false,
  security_mode: "unauthenticated-read-only", streams: [{ id: "live-vi", label: "Live V/I", profiles: [{
    profile: "vi-measurement", parameter_sets: [{ sample_format: "vi-f32le", channel_count: 2, channel_mask: 3, sample_rate: { numerator: 0, denominator: 0 } }],
  }] }],
});
const validStatus = Object.freeze({ protocol: "d2b-stream", version: "0.1", state: "idle", uptime_us: 1, producer_drop_count: 0, output_queue_drop_count: 0, connected_client_count: 0 });

function responsesFor({ manifest = raw, bundleId = hash, capabilities = validCapabilities, status = validStatus } = {}) {
  return {
    "/viewer/asset-manifest.json": new Response(manifest),
    "/viewer/device.json": new Response(JSON.stringify({ viewer_bundle_id: bundleId })),
    "/d2b/v0/capabilities": new Response(JSON.stringify(capabilities)),
    "/d2b/v0/status": new Response(JSON.stringify(status)),
  };
}

async function bootstrap(options) {
  const responses = responsesFor(options);
  return bootstrapDeviceHosted({ fetcher: async (url) => responses[url], pageAuthority: "http://a/", configuredWsAuthority: "ws://a/d2b/v0/stream" });
}

const ok = assessDeployment({ target: "device-hosted", pageAuthority: "http://a/", configuredWsAuthority: "ws://a/d2b/v0/stream", manifestHash: hash, deviceBundleId: hash });
const mismatch = assessDeployment({ target: "device-hosted", pageAuthority: "http://a/", configuredWsAuthority: "ws://a/d2b/v0/stream", manifestHash: hash, deviceBundleId: "y" });
const unavailable = assessDeployment({ target: "device-hosted", pageAuthority: "http://a/", configuredWsAuthority: "ws://a/d2b/v0/stream" });
const explicitDevelopment = assessDeployment({ target: "external-development", explicitDeveloperConfiguration: true });
const implicitDevelopment = assessDeployment({ target: "external-development" });

assert.notEqual(hash, reserializedHash);
assert.equal(ok.startAllowed, true);
assert.equal((await bootstrap()).startAllowed, true);
assert.equal((await bootstrap({ capabilities: {} })).bundleStatus, "identity-unavailable");
assert.equal((await bootstrap({ status: {} })).bundleStatus, "identity-unavailable");
assert.equal((await bootstrap({ status: { ...validStatus, active_stream_id: 7 } })).bundleStatus, "identity-unavailable");
assert.equal((await bootstrap({ status: { ...validStatus, producer_drop_count: Number.MAX_SAFE_INTEGER + 1 } })).bundleStatus, "identity-unavailable");
assert.equal((await bootstrap({ status: { ...validStatus, unknown: true } })).bundleStatus, "identity-unavailable");
assert.equal((await bootstrap({ manifest: reserialized, bundleId: hash })).bundleStatus, "mismatch");
assert.equal(mismatch.bundleStatus, "mismatch");
assert.equal(mismatch.message, "Viewerの更新状態が一致しません");
assert.equal(unavailable.bundleStatus, "identity-unavailable");
assert.equal(unavailable.message, "機器情報を確認できません");
assert.equal(explicitDevelopment.startAllowed, true);
assert.equal(explicitDevelopment.bundleStatus, "not-required");
assert.equal(implicitDevelopment.startAllowed, false);

// --- SHA-256 fallback: correctness against a node:crypto oracle, for the crypto.subtle-unavailable path ---
function nodeSha256Hex(bytes) {
  return createHash("sha256").update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest("hex");
}
function lcgBytes(length, seed) {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[i] = (state >>> 16) & 0xff;
  }
  return out;
}
const CRYPTO_MISSING = undefined;
const CRYPTO_NO_SUBTLE = Object.freeze({});
const fallbackVectors = [
  new Uint8Array(0),
  new TextEncoder().encode("abc"),
  lcgBytes(1, 1), lcgBytes(55, 2), lcgBytes(56, 3), lcgBytes(63, 4), lcgBytes(64, 5), lcgBytes(65, 6),
  lcgBytes(119, 7), lcgBytes(120, 8), lcgBytes(127, 9), lcgBytes(128, 10), lcgBytes(129, 11),
  new Uint8Array([0x00, 0xff, 0x00, 0xff, 0x7f, 0x80, 0x01, 0xfe]),
  lcgBytes(1024, 12), lcgBytes(1536, 13),
  raw,
];
for (const vector of fallbackVectors) {
  const oracle = nodeSha256Hex(vector);
  assert.equal(await sha256RawBytes(vector, CRYPTO_NO_SUBTLE), oracle, `fallback digest mismatch for length ${vector.byteLength}`);
  assert.equal(await sha256RawBytes(vector, CRYPTO_MISSING), oracle, `fallback digest mismatch (crypto undefined) for length ${vector.byteLength}`);
}
console.log(`PASS fallback SHA-256 matches node:crypto oracle for ${fallbackVectors.length} vectors (0..1536 bytes, boundary block sizes, binary 0x00/0xff)`);

// --- path selection: native WebCrypto preferred when available; fallback only otherwise ---
// Node's own globalThis.crypto is not populated for plain ES module execution on this
// toolchain (Node 18.19.1) without --experimental-global-webcrypto, so node:crypto's
// `webcrypto` export (Node's WebCrypto implementation, always available) stands in for
// "a real crypto.subtle.digest implementation" here, matching production's browser contract.
let nativeDigestCalls = 0;
const spyNativeCrypto = { subtle: { digest: async (algorithm, data) => { nativeDigestCalls += 1; return webcrypto.subtle.digest(algorithm, data); } } };
const viaSpyNative = await sha256RawBytes(raw, spyNativeCrypto);
assert.equal(nativeDigestCalls, 1);
assert.equal(viaSpyNative, nodeSha256Hex(raw));

const viaNoSubtle = await sha256RawBytes(raw, CRYPTO_NO_SUBTLE);
const viaNoCrypto = await sha256RawBytes(raw, CRYPTO_MISSING);
assert.equal(viaNoSubtle, nodeSha256Hex(raw));
assert.equal(viaNoCrypto, nodeSha256Hex(raw));
assert.equal(viaNoSubtle, viaSpyNative);
console.log("PASS native WebCrypto path used when crypto.subtle.digest exists; fallback used only when it does not (both agree)");

// --- fail-closed: single-byte manifest mutation and explicit fetch failure must not be silently accepted ---
// raw is '{"a":1}'; mutate only the digit (index 5) so the byte-flip stays valid JSON and
// the mismatch is attributable to the hash comparison itself, not an incidental parse failure.
assert.equal(String.fromCharCode(raw[5]), "1");
const mutatedRaw = new Uint8Array(raw);
mutatedRaw[5] ^= 0x01;
assert.notEqual(await sha256RawBytes(mutatedRaw), await sha256RawBytes(raw));
assert.equal((await bootstrap({ manifest: mutatedRaw, bundleId: hash })).bundleStatus, "mismatch");
assert.equal((await bootstrap({ manifest: mutatedRaw, bundleId: hash })).startAllowed, false);

const fetchFailure = await bootstrapDeviceHosted({
  fetcher: async () => { throw new Error("network unavailable"); },
  pageAuthority: "http://a/", configuredWsAuthority: "ws://a/d2b/v0/stream",
});
assert.equal(fetchFailure.startAllowed, false);
assert.equal(fetchFailure.bundleStatus, "identity-unavailable");
console.log("PASS single-byte manifest mutation and fetch failure both remain fail-closed");

console.log("PASS strict capabilities, redacted status, raw-byte identity, bundle, and external deployment policy");
