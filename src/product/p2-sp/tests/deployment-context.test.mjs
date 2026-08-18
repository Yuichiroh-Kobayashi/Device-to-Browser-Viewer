import assert from "node:assert/strict";
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
console.log("PASS strict capabilities, redacted status, raw-byte identity, bundle, and external deployment policy");
