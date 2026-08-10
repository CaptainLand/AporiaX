import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function unauthorized(res) {
  json(res, 401, { error: "unauthorized" });
}

export function createHarnessCoreServer({ kernel, host = "127.0.0.1", port = 0, token = "" } = {}) {
  if (!kernel) throw new Error("Harness Core Server requires a kernel.");
  const accessToken = token || randomBytes(24).toString("hex");
  let server = null;
  let address = null;

  const handler = (req, res) => {
    if (req.headers.authorization !== `Bearer ${accessToken}`) {
      unauthorized(res);
      return;
    }
    const url = new URL(req.url || "/", `http://${host}`);
    if (req.method !== "GET") {
      json(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (url.pathname === "/v1/health") {
      json(res, 200, { ok: true, version: kernel.version, capabilities: kernel.capabilities() });
      return;
    }
    if (url.pathname === "/v1/snapshot") {
      json(res, 200, kernel.snapshot());
      return;
    }
    if (url.pathname === "/v1/agents") {
      json(res, 200, { agents: kernel.agents.list() });
      return;
    }
    if (url.pathname === "/v1/plugins") {
      json(res, 200, { plugins: kernel.plugins.list() });
      return;
    }
    if (url.pathname === "/v1/sessions") {
      json(res, 200, { sessions: kernel.sessions.list() });
      return;
    }
    if (url.pathname === "/v1/events") {
      json(res, 200, {
        events: kernel.events.history({
          since: Number(url.searchParams.get("since") || 0),
          type: url.searchParams.get("type") || "*",
          limit: Number(url.searchParams.get("limit") || 200),
        }),
      });
      return;
    }
    json(res, 404, { error: "not_found" });
  };

  return {
    get token() {
      return accessToken;
    },
    get url() {
      return address ? `http://${address.address}:${address.port}` : null;
    },
    async listen() {
      if (server) return this;
      server = createServer(handler);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      address = server.address();
      kernel.events.emit({ type: "core.server.started", host, port: address.port });
      return this;
    },
    async close() {
      if (!server) return;
      const closing = server;
      server = null;
      await new Promise((resolve, reject) => closing.close((error) => (error ? reject(error) : resolve())));
      kernel.events.emit({ type: "core.server.stopped" });
    },
  };
}
