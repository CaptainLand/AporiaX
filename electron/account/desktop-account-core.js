import { createHash, randomBytes } from "node:crypto";

export const APORIAX_DESKTOP_CLIENT_ID = "aporiax-desktop";
export const DEFAULT_APORIAX_ACCOUNT_WEB_URL = "https://aporiax-preview-ecutg2r-d0gdndswo0a18e7b3.webapps.tcloudbase.com";
export const DEFAULT_APORIAX_CLOUD_API_URL = "http://127.0.0.1:4100";
export const DEFAULT_APORIAX_MODEL_GATEWAY_URL = "http://127.0.0.1:4200";

function base64urlRandom(bytes) {
  return randomBytes(bytes).toString("base64url");
}

export function createDesktopPkce() {
  const codeVerifier = base64urlRandom(32);
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const state = base64urlRandom(24);
  return { codeVerifier, codeChallenge, state };
}

export function normalizeHttpBaseUrl(value, fallback) {
  const raw = String(value || fallback || "").trim();
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("APORIAX_ACCOUNT_URL_INVALID");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export function buildDesktopAuthorizationUrl({
  webBaseUrl,
  redirectUri,
  codeChallenge,
  state,
  deviceName,
  platform,
  appVersion,
}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(codeChallenge || ""))) {
    throw new Error("DESKTOP_PKCE_CHALLENGE_INVALID");
  }
  if (!/^[A-Za-z0-9._~-]{16,256}$/.test(String(state || ""))) {
    throw new Error("DESKTOP_STATE_INVALID");
  }

  const url = new URL(`${normalizeHttpBaseUrl(webBaseUrl)}/authorize/desktop`);
  url.searchParams.set("client_id", APORIAX_DESKTOP_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  if (deviceName) url.searchParams.set("device_name", String(deviceName).slice(0, 120));
  if (platform) url.searchParams.set("platform", String(platform).slice(0, 80));
  if (appVersion) url.searchParams.set("app_version", String(appVersion).slice(0, 40));
  return url.toString();
}

export function parseDesktopLoopbackCallback(callbackUrl, { redirectUri, state }) {
  const callback = new URL(callbackUrl);
  const expected = new URL(redirectUri);
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) {
    throw new Error("DESKTOP_CALLBACK_INVALID");
  }
  if (callback.searchParams.get("state") !== state) {
    throw new Error("DESKTOP_STATE_MISMATCH");
  }
  const error = callback.searchParams.get("error");
  if (error) {
    return { canceled: error === "access_denied", error };
  }
  const code = callback.searchParams.get("code") || "";
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(code)) {
    throw new Error("DESKTOP_AUTH_CODE_INVALID");
  }
  return { canceled: false, code };
}

export function projectAccountSnapshot({ me, quota, models, usage, devices }) {
  const email = me?.identities?.find((identity) => identity?.type === "email")?.identifier || "";
  const user = me?.user || null;
  const deviceId = me?.session?.deviceId || null;
  const device = Array.isArray(devices)
    ? devices.find((entry) => entry?.id === deviceId) || null
    : null;
  return {
    status: user ? "authenticated" : "anonymous",
    profile: user
      ? {
          id: user.id,
          displayName: user.displayName || "",
          email,
        }
      : null,
    quota: quota || null,
    models: Array.isArray(models) ? models : [],
    usage: usage || null,
    device,
    session: me?.session || null,
  };
}
