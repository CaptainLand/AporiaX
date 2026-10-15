import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DEFAULT_APORIAX_ACCOUNT_WEB_URL, DEFAULT_APORIAX_CLOUD_API_URL, DEFAULT_APORIAX_MODEL_GATEWAY_URL } from "./desktop-account-core.js";
const defaults = { accountWebUrl: DEFAULT_APORIAX_ACCOUNT_WEB_URL, accountApiUrl: DEFAULT_APORIAX_CLOUD_API_URL, modelGatewayUrl: DEFAULT_APORIAX_MODEL_GATEWAY_URL };
// Historical preview credentials must never become valid on the public domain.
// These endpoints are available only through an explicit legacy operator opt-in.
const legacy = {
  accountWebUrl: 'https://aporiax-preview-ecutg2r-d0gdndswo0a18e7b3.webapps.tcloudbase.com',
  accountApiUrl: 'https://captainlan.tail0f652a.ts.net',
  modelGatewayUrl: 'http://127.0.0.1:4200',
};
function normalize(value) {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || url.protocol === "http:" && loopback) || url.username || url.password || url.search || url.hash)
    throw new Error("APORIAX_CLOUD_ENDPOINT_INVALID");
  return url.toString().replace(/\/+$/, "");
}
// Trusted package-time/local operator configuration only; never network discovery.
export function loadCloudEndpoints(options = {}, env = process.env) {
  let manifest = null;
  try {
    const text = readFileSync(options.endpointManifest || new URL("../../config/cloud-endpoints.json", import.meta.url), "utf8");
    if (text.length > 4096) throw new Error("APORIAX_CLOUD_MANIFEST_INVALID");
    manifest = JSON.parse(text);
    if (manifest?.version !== 1) throw new Error("APORIAX_CLOUD_MANIFEST_INVALID");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const selected = {
    accountWebUrl: options.webBaseUrl || env.APORIAX_ACCOUNT_WEB_URL || manifest?.accountWebUrl,
    accountApiUrl: options.apiBaseUrl || env.APORIAX_CLOUD_API_URL || manifest?.accountApiUrl,
    modelGatewayUrl: options.modelGatewayBaseUrl || env.APORIAX_MODEL_GATEWAY_URL || manifest?.modelGatewayUrl,
  };
  const provided = Object.values(selected).filter(Boolean).length;
  if (provided && provided !== 3) throw new Error("APORIAX_CLOUD_ENDPOINTS_INCOMPLETE");
  const allowLegacy = env.APORIAX_ALLOW_LEGACY_CLOUD_ENDPOINTS === "true";
  const configured = provided === 3 || allowLegacy;
  const endpoints = Object.fromEntries(Object.entries(provided ? selected : allowLegacy ? legacy : defaults).map(([k,v]) => [k, normalize(v)]));
  return { ...endpoints, configured, source: provided ? "explicit" : allowLegacy ? "legacy-preview" : "unconfigured",
    sessionScope: createHash("sha256").update(JSON.stringify(options.connectionIdentity ? { ...endpoints, connectionIdentity: options.connectionIdentity } : endpoints)).digest("hex"),
    legacy: Object.entries(legacy).every(([k,v]) => endpoints[k] === v) };
}
export function sessionMatchesEndpoints(record, endpoints) {
  return endpoints.configured && (record?.endpointScope === endpoints.sessionScope || (!record?.endpointScope && endpoints.legacy));
}
