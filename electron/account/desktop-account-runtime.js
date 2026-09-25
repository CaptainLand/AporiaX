import { cloudModelAvailability, cloudVisionAvailability } from "../../shared/cloud-availability.js";
import { loadCloudEndpoints, sessionMatchesEndpoints } from "./cloud-endpoints.js";
import { compareVersions } from "../app-update-core.js";
import { app, safeStorage, shell } from "electron";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cleanupLegacyMobileData } from "./legacy-mobile-cleanup.js";
import { createCloudModelQueue } from "./cloud-model-queue.js";
import {
  APORIAX_DESKTOP_CLIENT_ID,
  buildDesktopAuthorizationUrl,
  createDesktopPkce,
  parseDesktopLoopbackCallback,
  projectAccountSnapshot,
} from "./desktop-account-core.js";
const REQUEST_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 150_000;
const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function emptySnapshot(extra = {}) {
  return {
    status: "anonymous",
    profile: null,
    quota: null,
    models: [],
    usage: null,
    device: null,
    session: null,
    error: "",
    ...extra,
  };
}

function responseError(payload, status, fallback) {
  const message = payload?.error?.message || payload?.error || payload?.message || fallback;
  const error = new Error(String(message || `HTTP_${status}`));
  error.status = status;
  error.payload = payload;
  return error;
}

async function parseJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createDesktopAccountRuntime(options = {}) {
  const endpoints = loadCloudEndpoints(options);
  const { accountApiUrl: apiBaseUrl, accountWebUrl: webBaseUrl, modelGatewayUrl: modelGatewayBaseUrl } = endpoints;
  const userDataPath = app.getPath("userData");
  const sessionPath = join(userDataPath, "aporiax-account-session.json");
  const installationPath = join(userDataPath, "aporiax-installation.json");
  // Only obsolete companion caches are removed; task history is never touched.
  const legacyCleanup = cleanupLegacyMobileData(userDataPath);
  let accessToken = "";
  let currentSnapshot = emptySnapshot();
  let bootstrapPromise = null;
  let refreshPromise = null;
  let loginPromise = null;
  let accountPagePromise = null;
  let activeServer = null;
  let installationIdPromise = null;
  const modelQueue = createCloudModelQueue();

  async function request(path, { method = "GET", body, token = "", timeout = REQUEST_TIMEOUT_MS } = {}) {
    await options.ensureConnection?.();
    const headers = new Headers({ Accept: "application/json" });
    headers.set("X-Aporia-Desktop-Version", app.getVersion());
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const payload = await parseJson(response);
    if (!response.ok) throw responseError(payload, response.status, "APORIAX_CLOUD_REQUEST_FAILED");
    return payload;
  }

  async function getOrCreateInstallationId() {
    if (installationIdPromise) return installationIdPromise;
    installationIdPromise = (async () => {
      try {
        const record = JSON.parse(await readFile(installationPath, "utf8"));
        if (INSTALLATION_ID_PATTERN.test(String(record?.installationId || ""))) {
          return String(record.installationId).toLowerCase();
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          // Invalid/corrupt local identity is replaced with a fresh random id.
        }
      }

      const installationId = randomUUID();
      await mkdir(dirname(installationPath), { recursive: true });
      await writeFile(
        installationPath,
        JSON.stringify({ version: 1, installationId }),
        { encoding: "utf8", mode: 0o600 },
      );
      return installationId;
    })().catch((error) => {
      installationIdPromise = null;
      throw error;
    });
    return installationIdPromise;
  }

  function decryptStoredRefresh(record) {
    if (!record?.encryptedRefreshToken) return "";
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("SECURE_STORAGE_UNAVAILABLE");
    }
    return safeStorage.decryptString(Buffer.from(record.encryptedRefreshToken, "base64"));
  }

  async function readStoredRefreshToken() {
    try {
      const record = JSON.parse(await readFile(sessionPath, "utf8"));
      if (!sessionMatchesEndpoints(record, endpoints)) return "";
      return decryptStoredRefresh(record);
    } catch (error) {
      if (error?.code === "ENOENT") return "";
      if (error?.message === "SECURE_STORAGE_UNAVAILABLE") throw error;
      return "";
    }
  }

  async function storeRefreshToken(refreshToken) {
    if (!refreshToken) throw new Error("DESKTOP_REFRESH_TOKEN_MISSING");
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("SECURE_STORAGE_UNAVAILABLE");
    }
    const encryptedRefreshToken = safeStorage
      .encryptString(refreshToken)
      .toString("base64");
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(
      sessionPath,
      JSON.stringify({ version: 2, endpointScope: endpoints.sessionScope, encryptedRefreshToken }),
      "utf8",
    );
  }

  async function clearStoredSession() {
    accessToken = "";
    currentSnapshot = emptySnapshot();
    try {
      await rm(sessionPath, { force: true });
    } catch {
      // Installation identity deliberately survives sign-out.
    }
  }

  async function rotateRefreshToken(explicitRefreshToken = "") {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const refreshToken = explicitRefreshToken || await readStoredRefreshToken();
      if (!refreshToken) return null;
      try {
        const result = await request("/auth/refresh", {
          method: "POST",
          body: { refreshToken, clientType: "desktop" },
        });
        if (!result?.accessToken || !result?.refreshToken) {
          throw new Error("DESKTOP_REFRESH_RESPONSE_INVALID");
        }
        await storeRefreshToken(result.refreshToken);
        accessToken = result.accessToken;
        return result;
      } catch (error) {
        if (error?.status === 401 && error?.message === "SESSION_INVALID") {
          await clearStoredSession();
          return null;
        }
        throw error;
      }
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  async function authenticatedRequest(path, options = {}, retry = true) {
    if (!accessToken) {
      const refreshed = await rotateRefreshToken();
      if (!refreshed?.accessToken) throw new Error("DESKTOP_ACCOUNT_SIGNED_OUT");
    }
    try {
      return await request(path, { ...options, token: accessToken });
    } catch (error) {
      if (retry && error?.status === 401) {
        const refreshed = await rotateRefreshToken();
        if (!refreshed?.accessToken) throw new Error("DESKTOP_ACCOUNT_SIGNED_OUT");
        return authenticatedRequest(path, options, false);
      }
      throw error;
    }
  }

  async function authenticatedFetch(baseUrl, path, init = {}, retry = true) {
    await options.ensureConnection?.();
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
      throw new Error("APORIAX_AUTHENTICATED_PATH_INVALID");
    }
    if (!accessToken) {
      const refreshed = await rotateRefreshToken();
      if (!refreshed?.accessToken) throw new Error("DESKTOP_ACCOUNT_SIGNED_OUT");
    }
    const headers = new Headers(init.headers || {});
    headers.set("X-Aporia-Desktop-Version", app.getVersion());
    headers.set("Authorization", `Bearer ${accessToken}`);
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (response.status === 401 && retry) {
      try {
        await response.body?.cancel();
      } catch {
        // The response may already be fully consumed by the runtime.
      }
      const refreshed = await rotateRefreshToken();
      if (!refreshed?.accessToken) throw new Error("DESKTOP_ACCOUNT_SIGNED_OUT");
      return authenticatedFetch(baseUrl, path, init, false);
    }
    return response;
  }

  async function fetchModelGateway(path, init = {}) {
    if (!endpoints.configured) throw new Error("APORIAX_CLOUD_ENDPOINTS_NOT_CONFIGURED");
    // This authenticated transport is for inference and billing reconciliation,
    // not a generic Cloud upload/remote-control tunnel.
    if (!["/v1/chat/completions", "/v1/capabilities", "/v1/capabilities/vision"].includes(path)
      && !/^\/v1\/requests\/[a-f0-9-]{36}$/i.test(path)) {
      throw new Error("APORIAX_MODEL_GATEWAY_PATH_NOT_ALLOWED");
    }
    if (path === "/v1/chat/completions") {
      await bootstrap();
      if (Date.now() - (currentSnapshot.availabilityCheckedAt || 0) > 30_000) await refreshAvailability();
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
      const imageInput = body.messages?.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url"));
      const state = imageInput && body.model === "aporia-cloud-default"
        ? cloudVisionAvailability(currentSnapshot) : cloudModelAvailability(currentSnapshot, body.model);
      if (!state.available) throw Object.assign(new Error(state.reason), { code: state.reason, retryable: false });
      const headers = new Headers(init.headers);
      if (!headers.has("Idempotency-Key")) headers.set("Idempotency-Key", randomUUID());
      init = { ...init, headers };
      const { onCloudQueue, ...wireInit } = init;
      const owner = currentSnapshot.profile?.id;
      return modelQueue.run(() => {
        if (owner !== currentSnapshot.profile?.id) throw new Error("DESKTOP_ACCOUNT_CHANGED");
        return authenticatedFetch(modelGatewayBaseUrl, path, wireInit, true);
      }, { signal: init.signal, onQueue: onCloudQueue,
        getLimits: () => currentSnapshot.gatewayCapabilities?.modelGateway?.concurrency });
    }
    return authenticatedFetch(modelGatewayBaseUrl, path, init, true);
  }
  let availabilityPromise;
  async function readAvailability() {
    const [models, quota, capabilities, gateway] = await Promise.all([
      authenticatedRequest("/models").catch(() => null),
      authenticatedRequest("/quota/weekly").catch(() => null),
      authenticatedRequest("/capabilities").catch(() => null),
      authenticatedFetch(modelGatewayBaseUrl, "/v1/capabilities", { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
        .then(async response => ({ status: response.status, body: response.ok ? await parseJson(response) : null }))
        .catch(() => ({ status: 0, body: null })),
    ]);
    return { models, quota, capabilities,
      gatewayCapabilities: gateway.body?.protocolVersion === 1 && Array.isArray(gateway.body.models) ? gateway.body : null,
      gatewayStatus: gateway.status === 404 ? "legacy" : gateway.body?.protocolVersion === 1 && Array.isArray(gateway.body.models) ? "verified" : "unavailable",
      availabilityCheckedAt: Date.now() };
  }
  async function refreshAvailability() {
    return availabilityPromise ||= readAvailability().then(info => { currentSnapshot = { ...currentSnapshot, ...info }; return currentSnapshot; })
      .finally(() => { availabilityPromise = null; });
  }

  async function hydrateAccount() {
    const [me, availability, usage, devices] = await Promise.all([
      authenticatedRequest("/me"), readAvailability(),
      authenticatedRequest("/usage/summary?days=7").catch(() => null),
      authenticatedRequest("/devices"),
    ]);
    currentSnapshot = { ...projectAccountSnapshot({ me, ...availability, usage, devices }),
      ...availability, endpointSource: endpoints.source, error: "" };
    return currentSnapshot;
  }

  async function bootstrap() {
    await legacyCleanup;
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      try {
        const refreshToken = await readStoredRefreshToken();
        if (!refreshToken) {
          currentSnapshot = emptySnapshot();
          return currentSnapshot;
        }
        const refreshed = await rotateRefreshToken(refreshToken);
        if (!refreshed) return currentSnapshot;
        return await hydrateAccount();
      } catch (error) {
        currentSnapshot = emptySnapshot({
          status: "error",
          error: error?.message || "APORIAX_ACCOUNT_BOOTSTRAP_FAILED",
          hasStoredSession: Boolean(await readStoredRefreshToken().catch(() => "")),
        });
        return currentSnapshot;
      }
    })();
    return bootstrapPromise;
  }

  function closeActiveServer() {
    if (!activeServer) return;
    try {
      activeServer.close();
    } catch {
      // Listener may already be closed by the callback path.
    }
    activeServer = null;
  }

  async function waitForBrowserCallback({ state, codeChallenge }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        closeActiveServer();
        if (error) reject(error);
        else resolve(value);
      };

      const server = createServer((requestMessage, response) => {
        try {
          const address = server.address();
          const port = typeof address === "object" && address ? address.port : 0;
          const callbackUrl = new URL(requestMessage.url || "/", `http://127.0.0.1:${port}`);
          if (callbackUrl.pathname !== "/callback") {
            response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("Not found");
            return;
          }
          const redirectUri = `http://127.0.0.1:${port}/callback`;
          const result = parseDesktopLoopbackCallback(callbackUrl.toString(), {
            redirectUri,
            state,
          });
          response.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          });
          response.end(`<!doctype html><meta charset="utf-8"><title>AporiaX</title><style>body{font-family:system-ui;background:#0d1117;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0}main{text-align:center;max-width:520px;padding:32px}h1{font-size:24px}p{color:#9da7b3}</style><main><h1>${result.canceled ? "Sign-in canceled" : "Authorization returned to AporiaX Desktop"}</h1><p>${result.canceled ? "You can return to AporiaX Desktop." : "AporiaX is completing sign-in. Return to the app to see the final result."}</p></main>`);
          finish(null, { ...result, redirectUri });
        } catch (error) {
          response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Invalid AporiaX Desktop callback.");
          finish(error);
        }
      });

      activeServer = server;
      server.once("error", (error) => finish(error));
      server.listen(0, "127.0.0.1", async () => {
        try {
          const address = server.address();
          const port = typeof address === "object" && address ? address.port : 0;
          if (!port) throw new Error("DESKTOP_LOOPBACK_LISTENER_FAILED");
          const redirectUri = `http://127.0.0.1:${port}/callback`;
          const authorizationUrl = buildDesktopAuthorizationUrl({
            webBaseUrl,
            redirectUri,
            codeChallenge,
            state,
            deviceName: hostname() || "AporiaX Desktop",
            platform: process.platform,
            appVersion: app.getVersion(),
          });
          await shell.openExternal(authorizationUrl);
        } catch (error) {
          finish(error);
        }
      });

      timer = setTimeout(() => finish(new Error("DESKTOP_LOGIN_TIMEOUT")), LOGIN_TIMEOUT_MS);
    });
  }

  async function startBrowserLogin() {
    if (!endpoints.configured) throw new Error("APORIAX_CLOUD_ENDPOINTS_NOT_CONFIGURED");
    if (loginPromise) return loginPromise;
    loginPromise = (async () => {
      await options.ensureConnection?.();
      const beta = await request("/beta/status").catch(error => {
        if (error?.status === 404) return null;
        throw error;
      });
      const minimum = beta?.desktopUpdate?.minimumVersion;
      if (minimum && compareVersions(app.getVersion(), minimum) < 0) throw new Error("DESKTOP_UPDATE_REQUIRED");
      const installationId = await getOrCreateInstallationId();
      const { codeVerifier, codeChallenge, state } = createDesktopPkce();
      const callback = await waitForBrowserCallback({ state, codeChallenge });
      if (callback.canceled) return { ...currentSnapshot, canceled: true };
      const tokenResult = await request("/auth/desktop/token", {
        method: "POST",
        body: {
          clientId: APORIAX_DESKTOP_CLIENT_ID,
          code: callback.code,
          codeVerifier,
          redirectUri: callback.redirectUri,
          installationId,
        },
      });
      if (!tokenResult?.accessToken || !tokenResult?.refreshToken) {
        throw new Error("DESKTOP_TOKEN_RESPONSE_INVALID");
      }
      await storeRefreshToken(tokenResult.refreshToken);
      accessToken = tokenResult.accessToken;
      const hydrated = await hydrateAccount();
      bootstrapPromise = Promise.resolve(hydrated);
      return hydrated;
    })().catch((error) => {
      currentSnapshot = {
        ...currentSnapshot,
        error: error?.message || "DESKTOP_LOGIN_FAILED",
      };
      throw error;
    }).finally(() => {
      loginPromise = null;
      closeActiveServer();
    });
    return loginPromise;
  }

  function openAccountCenter() {
    if (!endpoints.configured) return Promise.reject(new Error("APORIAX_CLOUD_ENDPOINTS_NOT_CONFIGURED"));
    if (accountPagePromise) return accountPagePromise;
    accountPagePromise = (async () => {
      await options.ensureConnection?.();
      // Fixed trusted route; never accept renderer URLs or put credentials in links.
      const url = new URL("account", `${webBaseUrl}/`);
      await shell.openExternal(url.toString());
      return { opened: true };
    })().finally(() => { accountPagePromise = null; });
    return accountPagePromise;
  }

  async function refresh() {
    const refreshed = await rotateRefreshToken();
    if (!refreshed) {
      bootstrapPromise = Promise.resolve(currentSnapshot);
      return currentSnapshot;
    }
    const hydrated = await hydrateAccount();
    bootstrapPromise = Promise.resolve(hydrated);
    return hydrated;
  }

  async function signOut() {
    try {
      if (accessToken) {
        await request("/auth/logout", { method: "POST", token: accessToken });
      }
    } catch {
      // Local credential removal is authoritative for user-requested sign-out.
    }
    bootstrapPromise = null;
    await clearStoredSession();
    return currentSnapshot;
  }

  return {
    apiBaseUrl,
    webBaseUrl,
    modelGatewayBaseUrl,
    getSnapshot: bootstrap,
    startBrowserLogin,
    openAccountCenter,
    fetchModelGateway,
    refresh,
    signOut,
    close: () => { closeActiveServer(); return options.closeConnection?.(); },
  };
}
