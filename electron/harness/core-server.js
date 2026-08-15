import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const MAX_JSON_BODY_BYTES = 128_000;

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

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) {
      throw Object.assign(new Error("request_body_too_large"), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid_json_body");
    }
    return parsed;
  } catch (error) {
    if (error?.statusCode) throw error;
    throw Object.assign(new Error("invalid_json_body"), { statusCode: 400 });
  }
}

function taskRoute(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1" || parts[1] !== "tasks") return null;
  return {
    runId: parts[2] ? decodeURIComponent(parts[2]) : "",
    action: parts[3] ? decodeURIComponent(parts[3]) : "",
    childId: parts[4] ? decodeURIComponent(parts[4]) : "",
  };
}

export function createHarnessCoreServer({
  kernel,
  host = "127.0.0.1",
  port = 0,
  token = "",
} = {}) {
  if (!kernel) throw new Error("Harness Core Server requires a kernel.");
  const accessToken = token || randomBytes(24).toString("hex");
  let server = null;
  let address = null;

  const handler = async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${accessToken}`) {
        unauthorized(res);
        return;
      }
      const url = new URL(req.url || "/", `http://${host}`);
      const taskRuntime = kernel.taskRuntime || null;
      const task = taskRoute(url.pathname);

      if (task) {
        if (!taskRuntime) {
          json(res, 503, { error: "task_rpc_unavailable" });
          return;
        }
        if (req.method === "GET" && !task.runId) {
          json(res, 200, await taskRuntime.snapshot());
          return;
        }
        if (req.method === "POST" && !task.runId) {
          if (!taskRuntime.canStartTasks?.()) {
            json(res, 503, { error: "task_creation_unavailable" });
            return;
          }
          const body = await readJsonBody(req);
          json(res, 202, await taskRuntime.startFromRpc(body));
          return;
        }
        if (req.method === "GET" && task.runId && !task.action) {
          const active = taskRuntime.getActiveRun(task.runId);
          if (active) {
            json(res, 200, { active: true, ...active });
            return;
          }
          try {
            const recovery = await taskRuntime.recoveryContext(task.runId);
            json(res, 200, { active: false, recovery });
          } catch {
            json(res, 404, { error: "task_not_found" });
          }
          return;
        }
        if (req.method === "POST" && task.runId) {
          let ok = false;
          if (task.action === "pause") {
            ok = await taskRuntime.pause(task.runId);
          } else if (task.action === "resume") {
            ok = await taskRuntime.resume(task.runId);
          } else if (task.action === "interrupt") {
            ok = taskRuntime.interrupt(task.runId);
          } else if (task.action === "steer") {
            const body = await readJsonBody(req);
            ok = taskRuntime.steer(task.runId, body.message || body);
          } else if (task.action === "approvals" && task.childId) {
            const body = await readJsonBody(req);
            ok = taskRuntime.respondApproval(task.runId, task.childId, {
              approved: Boolean(body.approved),
              scope: body.scope === "run" ? "run" : "once",
            });
          } else if (task.action === "acknowledge-recovery") {
            ok = await taskRuntime.acknowledgeRecovery(task.runId);
          } else {
            json(res, 404, { error: "task_rpc_method_not_found" });
            return;
          }
          json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "task_not_found" });
          return;
        }
        json(res, 405, { error: "method_not_allowed" });
        return;
      }

      if (req.method !== "GET") {
        json(res, 405, { error: "method_not_allowed" });
        return;
      }
      if (url.pathname === "/v1/health") {
        json(res, 200, {
          ok: true,
          version: kernel.version,
          capabilities: kernel.capabilities(),
          capabilitySummary: kernel.capabilitiesRegistry?.summary?.() || null,
        });
        return;
      }
      if (url.pathname === "/v1/snapshot") {
        json(res, 200, kernel.snapshot());
        return;
      }
      if (url.pathname === "/v1/capabilities") {
        json(res, 200, {
          capabilities:
            kernel.capabilitiesRegistry?.list?.({
              kind: url.searchParams.get("kind") || "",
              source: url.searchParams.get("source") || "",
              scopeId: url.searchParams.get("scopeId") || "",
            }) || [],
          summary: kernel.capabilitiesRegistry?.summary?.() || {
            total: 0,
            byKind: {},
            bySource: {},
          },
        });
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
      if (url.pathname === "/v1/skills") {
        json(res, 200, { skills: kernel.skills?.list?.() || [] });
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
    } catch (error) {
      json(res, Number(error?.statusCode) || 500, {
        error: String(error?.message || "internal_error"),
      });
    }
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
      server = createServer((req, res) => {
        void handler(req, res);
      });
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
      await new Promise((resolve, reject) =>
        closing.close((error) => (error ? reject(error) : resolve())),
      );
      kernel.events.emit({ type: "core.server.stopped" });
    },
  };
}
