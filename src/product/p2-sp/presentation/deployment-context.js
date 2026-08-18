import { validateCapabilities } from "../../source-export/viewer/src/protocol/d2b-reference/capabilities-validator.js";

const PUBLIC_STATUS_REQUIRED_FIELDS = Object.freeze(["protocol", "version", "state", "uptime_us"]);
const PUBLIC_STATUS_COUNTER_FIELDS = Object.freeze(["producer_drop_count", "output_queue_drop_count", "connected_client_count"]);
const PUBLIC_STATUS_FIELDS = new Set([...PUBLIC_STATUS_REQUIRED_FIELDS, ...PUBLIC_STATUS_COUNTER_FIELDS]);

export async function sha256RawBytes(bytes) {
  const data = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
