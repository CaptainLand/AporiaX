import { app, safeStorage, shell } from "electron";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  APORIAX_DESKTOP_CLIENT_ID,
  DEFAULT_APORIAX_ACCOUNT_WEB_URL,
  DEFAULT_APORIAX_CLOUD_API_URL,
  buildDesktopAuthorizationUrl,
  createDesktopPkce,
  normalizeHttpBaseUrl,
  parseDesktopLoopbackCallback,
  projectAccountSnapshot,
} from "./desktop-account-core.js";

const REQUEST_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 150_000;

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
  const apiBaseUrl = normalizeHttpBaseUrl(
    options.apiBaseUrl || process.env.APORIAX_CLOUD_API_URL,
    DEFAULT_APORIAX_CLOUD_API_URL,
  );
  const webBaseUrl = normalizeHttpBaseUrl(
    options.webBaseUrl || process.env.APORIAX_ACCOUNT_WEB_URL,
    DEFAULT_APORIAX_ACCOUNT_WEB_URL,
  );
  const sessionPath = join(app.getPath("userData"), "aporiax-account-session.json");

  let accessToken = "";
  let currentSnapshot = emptySnapshot();
  let bootstrapPromise = null;
  let refreshPromise = null;
  let loginPromise = null;
  let activeServer = null;

  async function request(path, { method = "GET", body, token = "", timeout = REQUEST_TIMEOUT_MS } = {}) {
    const headers = new Headers({ Accept: "application/json" });
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
      JSON.stringify({ version: 1, encryptedRefreshToken }),
      "utf8",
    );
  }

  async function clearStoredSession() {
    accessToken = "";
    currentSnapshot = emptySnapshot();
    try {
      await rm(sessionPath, { force: true });
    } catch {
      // Local sign-out must still complete when cleanup is already satisfied.
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

  async function hydrateAccount() {
    const [me, quota, models, usage, devices] = await Promise.all([
      authenticatedRequest("/me"),
      authenticatedRequest("/quota/weekly"),
      authenticatedRequest("/models"),
      authenticatedRequest("/usage/summary?days=7"),
      authenticatedRequest("/devices"),
    ]);
    currentSnapshot = {
      ...projectAccountSnapshot({ me, quota, models, usage, devices }),
      error: "",
    };
    return currentSnapshot;
  }

  async function bootstrap() {
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
          response.end(`<!doctype html><meta charset="utf-8"><title>AporiaX</title><style>body{font-family:system-ui;background:#0d1117;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0}main{text-align:center;max-width:520px;padding:32px}h1{font-size:24px}p{color:#9da7b3}</style><main><h1>${result.canceled ? "Sign-in canceled" : "AporiaX Desktop connected"}</h1><p>${result.canceled ? "You can return to AporiaX Desktop." : "You can close this page and return to AporiaX Desktop."}</p></main>`);
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
    if (loginPromise) return loginPromise;
    loginPromise = (async () => {
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
        },
      });
      if (!tokenResult?.accessToken || !tokenResult?.refreshToken) {
        throw new Error("DESKTOP_TOKEN_RESPONSE_INVALID");
      }
      await storeRefreshToken(tokenResult.refreshToken);
      accessToken = tokenResult.accessToken;
      bootstrapPromise = Promise.resolve(currentSnapshot);
      return hydrateAccount();
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

  async function refresh() {
    const refreshed = await rotateRefreshToken();
    if (!refreshed) return currentSnapshot;
    return hydrateAccount();
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
    getSnapshot: bootstrap,
    startBrowserLogin,
    refresh,
    signOut,
    close: closeActiveServer,
  };
}
