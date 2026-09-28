import fs from "node:fs/promises";
import path from "node:path";

export const CONTROL_API_VERSION = 1;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class ControlClientError extends Error {
  constructor(code, message, details, status) {
    super(message);
    this.name = "ControlClientError";
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

function fail(code, message) {
  throw new ControlClientError(code, message);
}

async function readConfig(filename, { privateFile = false, label = "Configuration" } = {}) {
  if (typeof filename !== "string" || !path.isAbsolute(filename)) {
    fail("INVALID_CONNECTION", `${label} must use an absolute file path.`);
  }
  let handle;
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) {
      fail("INVALID_CONNECTION", `${label} must be a regular JSON file smaller than 64 KiB.`);
    }
    // The desktop creates this file with user-only access. Never put its token
    // in argv, environment variables, MCP configuration or diagnostics.
    if (process.platform !== "win32" && privateFile && (stat.mode & 0o077)) {
      fail("INSECURE_CONNECTION", `${label} is readable by other users. Set its permissions to 600 and retry.`);
    }
    if (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      fail("INSECURE_CONNECTION", `${label} must belong to the current operating-system user.`);
    }
    handle = await fs.open(filename, "r");
    const openedStat = await handle.stat();
    if (openedStat.dev !== stat.dev || openedStat.ino !== stat.ino || openedStat.size > MAX_CONFIG_BYTES) {
      fail("INVALID_CONNECTION", `${label} changed while being read. Retry the request.`);
    }
    const value = JSON.parse(await handle.readFile("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail("INVALID_CONNECTION", `${label} must contain a JSON object.`);
    }
    return value;
  } catch (error) {
    if (error instanceof ControlClientError) throw error;
    if (error.code === "ENOENT") {
      fail("CONNECTION_NOT_FOUND", `${label} was not found. Open AporiaX's External connections panel and create or copy this client's connection configuration.`);
    }
    if (error instanceof SyntaxError) fail("INVALID_CONNECTION", `${label} contains invalid JSON. Regenerate it in AporiaX.`);
    fail("CONNECTION_UNREADABLE", `${label} could not be read. Check that this process runs as the same operating-system user as AporiaX.`);
  } finally {
    await handle?.close();
  }
}

function validateEndpoint(discovery) {
  if (discovery.version !== CONTROL_API_VERSION || discovery.apiPath !== "/control/v1") {
    fail("API_VERSION_MISMATCH", "The desktop and control bridge use incompatible API versions. Update AporiaX and regenerate the client configuration.");
  }
  if (discovery.enabled !== true) {
    fail("CONTROL_DISABLED", "Local Control is disabled. Open AporiaX's External connections panel, enable it, and retry.");
  }
  let endpoint;
  try { endpoint = new URL(discovery.baseUrl); } catch { fail("INVALID_DISCOVERY", "AporiaX discovery contains an invalid service address."); }
  // IP literals prevent DNS rebinding. Redirects are rejected on every request.
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || endpoint.pathname !== "/" || !endpoint.port) {
    fail("UNSAFE_ENDPOINT", "The AporiaX control endpoint must be an HTTP loopback IP address with an explicit port and no credentials, path or query.");
  }
  return `${endpoint.origin}${discovery.apiPath}`;
}

export function publicError(error) {
  return {
    error: {
      code: error instanceof ControlClientError ? error.code : "BRIDGE_ERROR",
      message: error instanceof ControlClientError ? error.message : "The AporiaX bridge could not complete the request.",
      ...(error instanceof ControlClientError && error.status ? { status: error.status } : {}),
      ...(error instanceof ControlClientError && error.details != null ? { details: error.details } : {}),
    },
  };
}

function withoutCredential(value, token) {
  // Remote errors must never be able to reflect the bearer token to stdout.
  const encodedToken = JSON.stringify(token).slice(1, -1);
  return JSON.parse(JSON.stringify(value).replaceAll(encodedToken, "[redacted]"));
}

async function readResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail("RESPONSE_TOO_LARGE", "AporiaX returned more than 8 MiB. Use event or artifact pagination to read a smaller page.");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, length).toString("utf8");
  if (!body && response.status === 204) return {};
  try { return JSON.parse(body); } catch {
    fail("INVALID_RESPONSE", "AporiaX returned an invalid JSON response. Check that the desktop is running and update the bridge if needed.");
  }
}

export function createControlClient({ connectionPath, timeoutMs = 30_000 } = {}) {
  if (typeof connectionPath !== "string" || !path.isAbsolute(connectionPath)) {
    fail("INVALID_CONNECTION", "Use --connection with the absolute path of the private connection JSON created by AporiaX.");
  }
  const duration = Math.max(1, Math.min(120_000, Number(timeoutMs) || 30_000));
  return {
    async request(method, route, { body, query } = {}) {
      if (!/^\/[a-z0-9_%/-]+$/i.test(route) || route.includes("..")) {
        fail("INVALID_ROUTE", "The control bridge refused an invalid API route.");
      }
      const connection = await readConfig(connectionPath, { privateFile: true, label: "Client connection file" });
      if (connection.version !== CONTROL_API_VERSION || typeof connection.clientId !== "string" || !connection.clientId
          || typeof connection.token !== "string" || connection.token.length < 24
          || !/^[\x21-\x7e]+$/.test(connection.token)) {
        fail("INVALID_CONNECTION", "The client connection is invalid or uses an incompatible version. Regenerate it in AporiaX.");
      }
      // Re-read discovery for every operation. Restarting the desktop can
      // change its random port, while the client's connection remains valid.
      const discovery = await readConfig(connection.discoveryPath, { label: "Desktop discovery file" });
      const url = new URL(`${validateEndpoint(discovery)}${route}`);
      for (const [key, value] of Object.entries(query || {})) {
        if (value != null) url.searchParams.set(key, String(value));
      }
      let response;
      let data;
      try {
        response = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${connection.token}`, Accept: "application/json", ...(body != null ? { "Content-Type": "application/json" } : {}) },
          ...(body != null ? { body: JSON.stringify(body) } : {}),
          redirect: "error",
          signal: AbortSignal.timeout(duration),
        });
        data = withoutCredential(await readResponse(response), connection.token);
      } catch (error) {
        if (error instanceof ControlClientError) throw error;
        if (error.name === "TimeoutError" || error.name === "AbortError") {
          throw new ControlClientError("API_TIMEOUT", "The AporiaX API request timed out. A submitted run may still be active: query it or retry with the SAME idempotency_key before creating another run.");
        }
        throw new ControlClientError("DESKTOP_UNAVAILABLE", "Cannot reach AporiaX. Open the desktop's External connections panel and enable connections, then retry. Accepted runs are not cancelled by this connection failure.");
      }
      if (!response.ok) {
        const remote = data?.error;
        const fallback = response.status === 401 ? "This client credential is invalid or revoked. Create a new connection in AporiaX."
          : response.status === 403 ? "This operation is outside the client's AporiaX authorization."
          : `AporiaX rejected the request (HTTP ${response.status}).`;
        throw new ControlClientError(typeof remote?.code === "string" ? remote.code : "API_ERROR", typeof remote?.message === "string" ? remote.message : fallback, remote?.details, response.status);
      }
      return data;
    },
  };
}
