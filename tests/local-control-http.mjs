import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalControlService } from "../electron/control/service.js";
import { createLocalControlServer } from "../electron/control/server.js";

const directory = await mkdtemp(join(tmpdir(), "aporiax-control-http-"));
await mkdir(join(directory, "workspace"));
const runtime = { subscribeRunFinished: () => () => {}, getRunResult: async () => null, interrupt: () => true };
let service, server;
try {
  service = await createLocalControlService({ dataDirectory: directory, taskRuntime: runtime,
    listProviders: () => [{ id: "p", models: ["m"] }], startRun: async request => ({ runId: request.runId }) });
  const workspace = await service.admin("registerWorkspace", { path: join(directory, "workspace") });
  const connection = await service.admin("createClient", { name: "HTTP", workspaceIds: [workspace.id], profiles: ["review"], providerIds: ["p"] });
  await service.admin("setEnabled", { enabled: true });
  server = createLocalControlServer({ service }); await server.listen(); await service.setEndpoint(server.url);
  const fetchJson = async (path, options = {}) => {
    const response = await fetch(server.url + path, { ...options, headers: { Authorization: `Bearer ${connection.token}`, ...options.headers } });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const raw = (headers, path = "/control/v1/meta", method = "GET", body = "") => new Promise((resolve, reject) => {
    const req = request(server.url + path, { method, headers: { Authorization: `Bearer ${connection.token}`, ...headers } }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks)) }));
    }); req.on("error", reject); req.end(body);
  });
  const meta = await fetchJson("/control/v1/meta");
  assert.equal(meta.status, 200); assert.equal(meta.data.api_version, 1);
  assert.equal(meta.headers.get("cache-control"), "no-store");
  assert.equal(meta.data.openapi_path, "/control/v1/openapi");
  const specification = await fetchJson(meta.data.openapi_path);
  assert.equal(specification.status, 200);
  const spec = specification.data;
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.servers[0].url, server.url);
  assert.equal(spec.components.securitySchemes.ClientBearer.scheme, "bearer");
  assert.deepEqual(spec.security, [{ ClientBearer: [] }]);
  assert.equal(JSON.stringify(spec).includes(connection.token), false);
  const expectedOperations = [
    "GET /meta", "GET /openapi", "GET /workspaces", "GET /profiles", "GET /providers", "GET /runs", "POST /runs",
    "GET /runs/{run_id}", "GET /runs/{run_id}/result", "GET /runs/{run_id}/events", "GET /runs/{run_id}/agents",
    "GET /runs/{run_id}/questions", "GET /runs/{run_id}/approvals", "GET /runs/{run_id}/artifacts",
    "GET /runs/{run_id}/artifacts/{artifact_id}", "POST /runs/{run_id}/messages",
    "POST /runs/{run_id}/questions/{question_id}/answer", "POST /runs/{run_id}/pause",
    "POST /runs/{run_id}/resume", "POST /runs/{run_id}/cancel",
  ].map(value => value.replace(" /", " /control/v1/")).sort();
  const documentedOperations = Object.entries(spec.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, entry]) => {
    assert.equal(typeof entry.operationId, "string", "OpenAPI reserved camelCase keys must be preserved");
    if (method === "post") assert.ok(entry.requestBody);
    assert.ok(entry.responses["401"] && entry.responses["429"] && entry.responses["503"]);
    return `${method.toUpperCase()} ${path}`;
  })).sort();
  assert.deepEqual(documentedOperations, expectedOperations, "OpenAPI must document every actual operation without inventing API routes");
  assert.ok(spec.paths["/control/v1/runs"].post.responses["202"]);
  assert.equal(spec.components.schemas.RunCreateInput.additionalProperties, false);
  assert.deepEqual(spec.components.schemas.RunCreateInput.required, ["instruction", "workspace_id", "profile", "idempotency_key"]);
  assert.equal(spec.components.schemas.Limits.properties.max_model_calls.minimum, 0);
  assert.equal(spec.components.schemas.Limits.properties.max_duration_seconds.minimum, 1);
  assert.equal(spec.components.schemas.ArtifactPage.properties.encoding.const, "base64");
  assert.equal(spec.paths["/control/v1/runs/{run_id}/events"].get.parameters.find(parameter => parameter.name === "limit").schema.maximum, 1000);
  assert.equal(spec.paths["/control/v1/runs/{run_id}/artifacts/{artifact_id}"].get.parameters.find(parameter => parameter.name === "limit").schema.maximum, 65536);
  const checkRefs = value => {
    if (!value || typeof value !== "object") return;
    if (value.$ref) {
      assert.ok(value.$ref.startsWith("#/components/"));
      assert.ok(value.$ref.slice(2).split("/").reduce((current, key) => current?.[key], spec), `Unresolved OpenAPI reference: ${value.$ref}`);
    }
    for (const child of Object.values(value)) checkRefs(child);
  };
  checkRefs(spec);
  assert.equal((await raw({ Host: "evil.example" })).status, 403);
  assert.equal((await raw({ Origin: "http://127.0.0.1" })).status, 403);
  assert.equal((await raw({ Origin: "null" })).status, 403);
  assert.equal((await raw({ "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await raw({ Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await raw({ Authorization: "Bearer wrong" }, "/control/v1/openapi")).status, 401, "OpenAPI must be authenticated");
  assert.equal((await raw({}, "/control/v1/meta", "OPTIONS")).status, 405);
  assert.equal((await raw({}, "/control/v1/runs", "POST", "{}")).status, 415);
  assert.equal((await raw({ "Content-Type": "application/json" }, "/control/v1/runs", "POST", "not json")).status, 400);
  assert.equal((await raw({ "Content-Type": "application/json", "Content-Length": "131073" }, "/control/v1/runs", "POST", "{}")).status, 413);
  assert.equal((await raw({}, "/control/v1/runs%2fsecret")).status, 400);
  assert.equal((await raw({}, "/v1/tasks")).status, 404, "Legacy privileged RPC must not be reachable through this listener");
  const input = { workspace_id: workspace.id, profile: "review", instruction: "Inspect", idempotency_key: "http-1" };
  const started = await fetchJson("/control/v1/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  assert.equal(started.status, 202); assert.ok(started.data.run_id);
  const retry = await fetchJson("/control/v1/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  assert.equal(retry.data.run_id, started.data.run_id);
  const invalid = await fetchJson("/control/v1/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, approvalMode: "full-access" }) });
  assert.equal(invalid.status, 400); assert.equal(invalid.data.error.code, "unknown_fields");
  const approval = await fetchJson(`/control/v1/runs/${started.data.run_id}/approvals/a`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(approval.status, 403); assert.equal(approval.data.error.code, "human_approval_required");
  await service.admin("revokeClient", { clientId: connection.client.id });
  assert.equal((await fetchJson("/control/v1/meta")).status, 401);
  await service.admin("setEnabled", { enabled: false });
  assert.equal((await fetchJson("/control/v1/meta")).status, 503);
  await server.close(); server = createLocalControlServer({ service, requestsPerMinute: 2 });
  await service.admin("setEnabled", { enabled: true }); await server.listen();
  await raw({ Authorization: "Bearer bad" }); await raw({ Authorization: "Bearer bad" });
  const invalidLimited = await raw({ Authorization: "Bearer bad" });
  assert.equal(invalidLimited.status, 429); assert.equal(invalidLimited.data.error.details.scope, "unauthenticated");
  const rateGrant = { name: "Rate fixture", workspaceIds: [workspace.id], profiles: ["review"], providerIds: ["p"] };
  const rateA = await service.admin("createClient", rateGrant), rateB = await service.admin("createClient", rateGrant);
  for (const token of [rateA.token, rateB.token]) {
    assert.equal((await raw({ Authorization: `Bearer ${token}` })).status, 200, "Invalid authentication attempts must not consume a valid client's quota");
    assert.equal((await raw({ Authorization: `Bearer ${token}` })).status, 200, "Different authenticated clients have independent quotas");
    const limited = await raw({ Authorization: `Bearer ${token}` });
    assert.equal(limited.status, 429); assert.equal(limited.data.error.details.scope, "client");
  }
  await server.close();
  server = createLocalControlServer({ service, requestsPerMinute: 100, globalRequestsPerMinute: 3 });
  await server.listen();
  for (let i = 0; i < 3; i += 1) assert.equal((await raw({ Authorization: `Bearer ${rateA.token}` })).status, 200);
  const globalLimited = await fetchJson("/control/v1/meta", { headers: { Authorization: `Bearer ${rateB.token}` } });
  assert.equal(globalLimited.status, 429); assert.equal(globalLimited.data.error.details.scope, "global");
  assert.equal(globalLimited.headers.get("retry-after"), "60");
  console.log("PASS local control HTTP: loopback Host/Origin, auth, OpenAPI route/schema coverage, body bounds, methods, idempotency, revocation, independent rate limits");
} finally {
  await server?.close(); await service?.shutdown(); await rm(directory, { recursive: true, force: true });
}
