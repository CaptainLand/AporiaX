import { createServer } from "node:http";
import { CONTROL_API_PATH, ControlError, fail } from "./contracts.js";

const MAX_BODY_BYTES = 128 * 1024;
const SEND_LIMIT_BYTES = 6 * 1024 * 1024;
function send(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > SEND_LIMIT_BYTES) {
    send(res, 413, { error: { code: "response_too_large", message: "Reduce the page size or read individual result artifacts." } });
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body),
    "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'",
  });
  res.end(body);
}
async function bodyOf(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || "")))
    fail(415, "unsupported_media_type", "Use Content-Type: application/json.");
  const contentLength = req.headers["content-length"];
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES))
    fail(413, "request_too_large", "The JSON request body exceeds 128 KiB.");
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) fail(413, "request_too_large", "The JSON request body exceeds 128 KiB.");
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { fail(400, "invalid_json", "The request body is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "invalid_request", "The request body must be a JSON object.");
  return value;
}

export const LOCAL_CONTROL_RATE_LIMITS = Object.freeze({ client: 240, global: 2400, unauthenticated: 240 });

export function createLocalControlServer({ service, port = 0, requestsPerMinute = LOCAL_CONTROL_RATE_LIMITS.client,
  globalRequestsPerMinute = requestsPerMinute * 10, unauthenticatedRequestsPerMinute = requestsPerMinute } = {}) {
  if (!service) throw new TypeError("A local control service is required.");
  for (const limit of [requestsPerMinute, globalRequestsPerMinute, unauthenticatedRequestsPerMinute])
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Local control rate limits must be positive integers.");
  let server = null, address = null, starting = null;
  const buckets = new Map();
  const acceptRate = (key, limit) => {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.since >= 60000) {
      if (buckets.size > 1024) for (const [id, value] of buckets) if (now - value.since >= 60000) buckets.delete(id);
      buckets.set(key, { since: now, count: 1 }); return true;
    }
    bucket.count += 1; return bucket.count <= limit;
  };
  const checkUnauthenticatedRate = () => {
    if (!acceptRate("unauthenticated", unauthenticatedRequestsPerMinute))
      fail(429, "rate_limited", "Too many unauthenticated requests. Retry after one minute.", { scope: "unauthenticated" });
  };
  const handler = async (req, res) => {
    try {
      const remote = req.socket.remoteAddress;
      if (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1") fail(403, "loopback_required", "Local control only accepts loopback clients.");
      // Exact numeric loopback Host prevents DNS rebinding. Browser origins are never authorized.
      if (req.headers.host !== `127.0.0.1:${address?.port}`) fail(403, "invalid_host", "Use the numeric loopback URL from AporiaX discovery.");
      if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "none")
        fail(403, "browser_origin_denied", "Browser-origin requests are not supported by the local control API.");
      if (!acceptRate("global", globalRequestsPerMinute)) fail(429, "rate_limited", "The local API global request limit was reached. Retry after one minute.", { scope: "global" });
      if (req.method !== "GET" && req.method !== "POST") fail(405, "method_not_allowed", "Use GET or POST for this API.");
      const auth = req.headers.authorization;
      if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
        checkUnauthenticatedRate(); fail(401, "unauthorized", "A local client Bearer token is required.");
      }
      let client;
      try { client = service.authenticate(auth.slice(7)); }
      catch (error) { if (error?.statusCode === 401) checkUnauthenticatedRate(); throw error; }
      if (!acceptRate(`client:${client.id}`, requestsPerMinute)) fail(429, "rate_limited", "This client's request limit was reached. Retry after one minute.", { scope: "client" });
      if (!req.url?.startsWith("/") || req.url.startsWith("//") || /%2f|%5c|\\/i.test(req.url)) fail(400, "invalid_path", "Use a relative API path without encoded separators.");
      const url = new URL(req.url, `http://127.0.0.1:${address.port}`);
      if (url.hash || url.username || url.password || url.origin !== `http://127.0.0.1:${address.port}` || !url.pathname.startsWith(CONTROL_API_PATH + "/"))
        fail(404, "not_found", "Unknown local control endpoint.");
      const query = Object.fromEntries(url.searchParams);
      const body = req.method === "POST" ? await bodyOf(req) : {};
      const value = await service.dispatch(client, req.method, url.pathname, query, body);
      send(res, req.method === "POST" && url.pathname === `${CONTROL_API_PATH}/runs` ? 202 : 200, value);
    } catch (error) {
      // A rejected request may still have an unread or deliberately incomplete body.
      // Close that connection so its bytes cannot be interpreted as a subsequent request.
      res.shouldKeepAlive = false;
      res.setHeader("connection", "close");
      if (error?.statusCode === 429) res.setHeader("retry-after", "60");
      if (error instanceof ControlError || Number.isInteger(error?.statusCode)) {
        send(res, error.statusCode, { error: { code: error.code || "invalid_request", message: error.message, ...(error.details ? { details: error.details } : {}) } });
      } else if (String(error?.code || error?.message).startsWith("CLARIFICATION_")) {
        send(res, 409, { error: { code: "clarification_unavailable", message: "The clarification was already answered, cancelled, or is no longer active." } });
      } else {
        // Never expose stack traces, provider credentials, SQL, or arbitrary filesystem paths over HTTP.
        send(res, 500, { error: { code: "internal_error", message: "The local control request failed. Inspect the desktop task status before retrying." } });
      }
    }
  };
  return {
    get url() { return address ? `http://127.0.0.1:${address.port}` : null; },
    async listen() {
      if (starting) return starting;
      if (server) return this;
      server = createServer({ maxHeaderSize: 8192 }, (req, res) => { void handler(req, res); });
      server.requestTimeout = 15000; server.headersTimeout = 10000;
      server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 1000;
      server.setTimeout(15000, socket => socket.destroy());
      server.on("clientError", (_error, socket) => { if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); });
      starting = new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          address = server.address(); resolve(this);
        });
      }).catch(error => {
        server?.close(); server = null; address = null; throw error;
      }).finally(() => { starting = null; });
      return starting;
    },
    async close() {
      if (starting) await starting.catch(() => {});
      if (!server) return;
      const current = server; server = null; address = null; buckets.clear();
      current.closeIdleConnections?.();
      await new Promise(resolve => current.close(resolve));
    },
  };
}
