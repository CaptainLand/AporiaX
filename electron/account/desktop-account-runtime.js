import { cloudModelAvailability, cloudVisionAvailability, remoteServiceSupported } from "../../shared/cloud-availability.js";
import { loadCloudEndpoints, sessionMatchesEndpoints } from "./cloud-endpoints.js";
import { app, dialog, safeStorage, shell } from "electron";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRemoteCommandInbox, remoteOwnerKey } from "./remote-command-inbox.js";
import {
  APORIAX_DESKTOP_CLIENT_ID,
  buildDesktopAuthorizationUrl,
  createDesktopPkce,
  parseDesktopLoopbackCallback,
  projectAccountSnapshot,
} from "./desktop-account-core.js";
import {
  executeRemoteFileCommand as executeFileBrokerCommand,
  readRemoteFileSettings,
  writeRemoteFileSettings,
} from "./remote-file-broker.js";

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
  const remoteFileSettingsPath = join(userDataPath, "aporiax-remote-file-access.json");
  let inbox = null;
  const commandInbox = () => inbox ||= createRemoteCommandInbox(join(userDataPath, "aporiax-remote-commands.sqlite3"));
  let commandPoll = null;
  const fileExecutions = new Set();

  let accessToken = "";
  let currentSnapshot = emptySnapshot();
  let bootstrapPromise = null;
  let refreshPromise = null;
  let loginPromise = null;
  let activeServer = null;
  let installationIdPromise = null;

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
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
      throw new Error("APORIAX_AUTHENTICATED_PATH_INVALID");
    }
    if (!accessToken) {
      const refreshed = await rotateRefreshToken();
      if (!refreshed?.accessToken) throw new Error("DESKTOP_ACCOUNT_SIGNED_OUT");
    }
    const headers = new Headers(init.headers || {});
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
    if (path === "/v1/chat/completions") {
      await bootstrap();
      if (Date.now() - (currentSnapshot.availabilityCheckedAt || 0) > 30_000) await refreshAvailability();
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
      const state = body.model === "aporia-cloud-vision"
        ? cloudVisionAvailability(currentSnapshot) : cloudModelAvailability(currentSnapshot, body.model);
      if (!state.available) throw Object.assign(new Error(state.reason), { code: state.reason, retryable: false });
      const headers = new Headers(init.headers);
      if (!headers.has("Idempotency-Key")) headers.set("Idempotency-Key", randomUUID());
      init = { ...init, headers };
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

  async function setRemoteEnabled(enabled) {
    const snapshot = await bootstrap();
    if (enabled && !remoteServiceSupported(snapshot)) throw new Error("REMOTE_SERVICE_UNAVAILABLE");
    const deviceId = snapshot?.device?.id;
    if (!deviceId) throw new Error("DESKTOP_DEVICE_REQUIRED");
    const device = await authenticatedRequest(`/devices/${encodeURIComponent(deviceId)}`, {
      method: "PATCH",
      body: { remoteEnabled: Boolean(enabled) },
    });
    const remoteFiles = enabled
      ? await readRemoteFileSettings(remoteFileSettingsPath)
      : await writeRemoteFileSettings(remoteFileSettingsPath, false);
    currentSnapshot = { ...currentSnapshot, device, remoteFiles, error: "" };
    bootstrapPromise = Promise.resolve(currentSnapshot);
    return currentSnapshot;
  }

  async function setRemoteFileAccess(enabled) {
    const snapshot = await bootstrap();
    if (snapshot?.status !== "authenticated") throw new Error("DESKTOP_ACCOUNT_SIGNED_OUT");
    if (enabled && (!remoteServiceSupported(snapshot) || !snapshot?.device?.remoteEnabled)) throw new Error("REMOTE_SYNC_REQUIRED");
    const remoteFiles = await writeRemoteFileSettings(remoteFileSettingsPath, Boolean(enabled));
    currentSnapshot = { ...currentSnapshot, remoteFiles, error: "" };
    bootstrapPromise = Promise.resolve(currentSnapshot);
    return currentSnapshot;
  }

  async function syncRemoteTasks(payload) {
    const snapshot = await bootstrap();
    if (snapshot?.status !== "authenticated") return { enabled: false, reason: "SIGNED_OUT" };
    if (!remoteServiceSupported(snapshot) || !snapshot?.device?.remoteEnabled) return { enabled: false, reason: "REMOTE_SERVICE_UNAVAILABLE" };
    const result = await authenticatedRequest("/remote/desktop/tasks", {
      method: "PUT",
      body: payload,
      timeout: 20_000,
    });
    return { enabled: true, ...result };
  }

  async function pollRemoteCommands() {
    if (commandPoll) return commandPoll;
    commandPoll = pollCommandsOnce().finally(() => { commandPoll = null; });
    return commandPoll;
  }

  function commandOwner(snapshot = currentSnapshot) {
    if (snapshot?.status !== "authenticated" || !remoteServiceSupported(snapshot) || !snapshot?.device?.remoteEnabled) throw new Error("REMOTE_SYNC_DISABLED");
    return remoteOwnerKey(apiBaseUrl, snapshot.profile?.id, snapshot.device?.id);
  }

  async function flushCommandReceipts(owner) {
    for (const receipt of commandInbox().receipts(owner)) {
      if (commandOwner() !== owner) return;
      try {
        await authenticatedRequest(`/remote/desktop/commands/${encodeURIComponent(receipt.id)}`, {
          method: "PATCH", body: { status: receipt.status, result: receipt.result },
        });
        commandInbox().acknowledge(owner, receipt.id);
      } catch { break; } // The durable outbox will retry; never re-execute the command.
    }
  }

  async function pollCommandsOnce() {
    const snapshot = await bootstrap();
    if (snapshot?.status !== "authenticated" || !remoteServiceSupported(snapshot) || !snapshot?.device?.remoteEnabled) return [];
    const owner = commandOwner(snapshot);
    await flushCommandReceipts(owner);
    const commands = await authenticatedRequest("/remote/desktop/commands", { timeout: 12_000 });
    if (commandOwner() !== owner) return [];
    commandInbox().ingest(owner, Array.isArray(commands) ? commands : []);
    return commandInbox().pending(owner);
  }

  async function claimRemoteCommand(commandId, consumerId) {
    await bootstrap();
    return commandInbox().claim(commandOwner(), commandId, consumerId);
  }

  async function acknowledgeRemoteCommand(commandId, status, result = "", claim) {
    if (!commandId) throw new Error("REMOTE_COMMAND_ID_REQUIRED");
    const owner = commandOwner();
    commandInbox().complete(owner, commandId, claim, status, result);
    fileExecutions.delete(`${owner}:${commandId}`);
    await flushCommandReceipts(owner);
    return { saved: true };
  }

  async function uploadRemoteCommandFile(commandId, file) {
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "X-AporiaX-File-Type": file.mime || "application/octet-stream",
      "X-AporiaX-File-Name": encodeURIComponent(file.name || "download"),
      "X-AporiaX-File-Size": String(file.size || file.buffer?.length || 0),
    });
    const response = await authenticatedFetch(
      apiBaseUrl,
      `/remote/desktop/commands/${encodeURIComponent(commandId)}/file`,
      { method: "PUT", headers, body: file.buffer, signal: AbortSignal.timeout(60_000) },
    );
    const payload = await parseJson(response);
    if (!response.ok) throw responseError(payload, response.status, "REMOTE_FILE_UPLOAD_FAILED");
    return payload;
  }

  async function executeRemoteFileCommand(command) {
    if (!command?.id) throw new Error("REMOTE_COMMAND_ID_REQUIRED");
    const snapshot = await bootstrap();
    if (snapshot?.status !== "authenticated" || !remoteServiceSupported(snapshot) || !snapshot?.device?.remoteEnabled) {
      throw new Error("REMOTE_SYNC_DISABLED");
    }
    const owner = commandOwner(snapshot);
    const saved = commandInbox().executing(owner, command.id, command.claim);
    const executionKey = `${owner}:${command.id}`;
    if (fileExecutions.has(executionKey)) throw new Error("REMOTE_COMMAND_ALREADY_EXECUTING");
    fileExecutions.add(executionKey);
    return await executeFileBrokerCommand(saved, {
      configPath: remoteFileSettingsPath,
      confirm: async ({ action, path: targetPath }) => {
        const verb = action === "preview" ? "预览" : "下载";
        const result = await dialog.showMessageBox({
          type: "warning",
          title: `允许手机${verb}文件？`,
          message: `AporiaX Mobile 请求${verb}此文件`,
          detail: `${targetPath}\n\n仅本次允许。文件内容会通过 AporiaX Cloud 临时传输，最多保留 10 分钟。`,
          buttons: ["允许一次", "拒绝"],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        return result.response === 0;
      },
      upload: (file) => {
        if (commandOwner() !== owner) throw new Error("REMOTE_IDENTITY_CHANGED");
        commandInbox().executing(owner, saved.id, command.claim);
        return uploadRemoteCommandFile(saved.id, file);
      },
    });
  }

  async function hydrateAccount() {
    const [me, availability, usage, devices, remoteFiles] = await Promise.all([
      authenticatedRequest("/me"), readAvailability(),
      authenticatedRequest("/usage/summary?days=7").catch(() => null),
      authenticatedRequest("/devices"), readRemoteFileSettings(remoteFileSettingsPath),
    ]);
    currentSnapshot = { ...projectAccountSnapshot({ me, ...availability, usage, devices }),
      ...availability, remoteFiles, endpointSource: endpoints.source, error: "" };
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
    await writeRemoteFileSettings(remoteFileSettingsPath, false);
    await clearStoredSession();
    return currentSnapshot;
  }

  return {
    apiBaseUrl,
    webBaseUrl,
    modelGatewayBaseUrl,
    getSnapshot: bootstrap,
    startBrowserLogin,
    setRemoteEnabled,
    setRemoteFileAccess,
    syncRemoteTasks,
    pollRemoteCommands,
    claimRemoteCommand,
    abandonRemoteCommands: (consumerId) => inbox?.abandon(consumerId),
    acknowledgeRemoteCommand,
    executeRemoteFileCommand,
    fetchModelGateway,
    refresh,
    signOut,
    close: () => { closeActiveServer(); inbox?.close(); inbox = null; },
  };
}
