import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createControlClient } from "../electron/control/bridge/client.js";
import { getClientConfiguration } from "../electron/control/bridge/config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aporiax-control-mcp-"));
const connectionPath = path.join(temporary, "client.json");
const discoveryPath = path.join(temporary, "discovery.json");
const entry = path.join(root, "electron/control/bridge/entry.js");
const bundle = path.join(root, "build/control-bridge.cjs");
const token = randomBytes(32).toString("base64url");
const runs = new Map();
const requests = [];
const timers = new Set();
const connections = new Set();
const artifactBytes = Buffer.from("AporiaX 任务结果\nUTF-8 切块正常\n", "utf8");
let server;
let port;
let instance = 0;
let checks = 0;
const checked = label => { checks += 1; process.stdout.write(`PASS ${label}\n`); };

async function writeDiscovery(overrides = {}) {
  await fs.writeFile(discoveryPath, JSON.stringify({ version: 1, baseUrl: `http://127.0.0.1:${port}`, apiPath: "/control/v1", instanceId: String(instance), enabled: true, ...overrides }), { mode: 0o600 });
}
async function writeConnection(overrides = {}) {
  await fs.writeFile(connectionPath, JSON.stringify({ version: 1, clientId: "fixture-client", token, discoveryPath, ...overrides }), { mode: 0o600 });
}

async function listenFixture() {
  instance += 1;
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const reply = (status, data) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
    const error = (status, code, message) => reply(status, { error: { code, message } });
    if (request.headers.authorization !== `Bearer ${token}`) return error(401, "invalid_client", "The client was revoked or its token is invalid.");
    let body = {};
    if (request.method === "POST") {
      let raw = "";
      for await (const part of request) raw += part;
      body = JSON.parse(raw || "{}");
    }
    requests.push({ method: request.method, pathname: url.pathname, body });
    const route = url.pathname.replace(/^\/control\/v1/, "");
    if (route === "/meta") return reply(200, { api_version: 1, instance_id: String(instance), client_id: "fixture-client" });
    if (route === "/workspaces") return reply(200, { workspaces: [{ id: "ws-1", name: "Fixture workspace" }] });
    if (route === "/profiles") return reply(200, { profiles: [{ id: "review" }, { id: "workspace" }] });
    if (route === "/providers") return reply(200, { providers: [{ id: "fixture", models: ["fixture-model"] }] });
    if (route === "/runs" && request.method === "GET") return reply(200, { runs: [...runs.values()].map(({ run_id, status }) => ({ run_id, status })) });
    if (route === "/runs" && request.method === "POST") {
      if (body.workspace_id === "forbidden") return error(403, "workspace_denied", `Access refused. Reflected token must be redacted: ${token}`);
      const previous = [...runs.values()].find(run => run.input.idempotency_key === body.idempotency_key);
      if (previous) {
        if (JSON.stringify(previous.input) !== JSON.stringify(body)) return error(409, "idempotency_conflict", "Different input used with the same key.");
        return reply(200, { run_id: previous.run_id, status: previous.status, replayed: true });
      }
      const run_id = `run-${runs.size + 1}`;
      const run = { run_id, status: "running", input: body, events: Array.from({ length: 5 }, (_, index) => ({ seq: index + 1, at: Date.now(), type: "progress", payload: { text: `step ${index + 1}` } })) };
      runs.set(run_id, run);
      const timer = setTimeout(() => { run.status = "completed"; run.events.push({ seq: 6, at: Date.now(), type: "completed", payload: {} }); timers.delete(timer); }, 150);
      timers.add(timer);
      return reply(202, { run_id, task_id: `task-${runs.size}`, status: run.status, created_at: new Date().toISOString() });
    }
    const match = /^\/runs\/([^/]+)(.*)$/.exec(route);
    if (!match || !runs.has(match[1])) return error(404, "run_not_found", "Unknown or unauthorized run.");
    const run = runs.get(match[1]);
    const suffix = match[2];
    if (!suffix) return reply(200, { run_id: run.run_id, status: run.status });
    if (suffix === "/result") return run.status === "running" ? error(409, "result_not_ready", "The task is still running.") : reply(200, { run_id: run.run_id, status: run.status, summary: "Fixture result", verification: { status: "not_verified" } });
    if (suffix === "/events") {
      const after = Number(url.searchParams.get("after_seq") || 0);
      const all = run.events.filter(item => item.seq > after);
      const events = all.slice(0, Number(url.searchParams.get("limit") || 100));
      return reply(200, { events, next_seq: events.at(-1)?.seq ?? after, has_more: all.length > events.length });
    }
    if (suffix === "/agents") return reply(200, { agents: [{ agent_id: "main", status: run.status }] });
    if (suffix === "/questions") return reply(200, { questions: [{ question_id: "question-1", question: "Which report format?" }] });
    if (suffix === "/approvals") return reply(200, { approvals: [{ approval_id: "approval-1", status: "pending" }] });
    if (suffix === "/artifacts") return reply(200, { artifacts: [{ artifact_id: "artifact-1", name: "report.txt" }] });
    if (suffix === "/artifacts/artifact-1") {
      const offset = Number(url.searchParams.get("offset") || 0);
      const end = Math.min(artifactBytes.length, offset + Number(url.searchParams.get("limit") || 65536));
      return reply(200, { artifact_id: "artifact-1", name: "report.txt", mime_type: "text/plain", encoding: "base64", content: artifactBytes.subarray(offset, end).toString("base64"), offset, next_offset: end, total_bytes: artifactBytes.length, has_more: end < artifactBytes.length });
    }
    if (suffix === "/messages") return reply(200, { accepted: true, content: body.content });
    if (suffix === "/questions/question-1/answer") return reply(200, { answered: true, answer: body.answer });
    if (["/pause", "/resume", "/cancel"].includes(suffix)) {
      run.status = { "/pause": "paused", "/resume": "running", "/cancel": "cancelled" }[suffix];
      return reply(200, { run_id: run.run_id, status: run.status });
    }
    return error(404, "not_found", "No fixture endpoint.");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  await writeDiscovery();
}

async function connectMcp(filename = entry, selectedConnection = connectionPath, options = {}) {
  let stderr = "";
  const transport = new StdioClientTransport({ command: options.command || process.execPath, env: options.env, args: [filename, "mcp", "--connection", selectedConnection], stderr: "pipe" });
  transport.stderr?.on("data", part => { stderr += part; });
  const client = new Client({ name: "aporiax-bridge-integration-test", version: "1.0.0" });
  await client.connect(transport);
  connections.add(client);
  return { client, stderr: () => stderr, close: async () => { connections.delete(client); await client.close(); } };
}
async function call(client, name, input = {}) {
  return client.callTool({ name: `aporiax_${name}`, arguments: input });
}
function data(result) { return result.structuredContent ?? JSON.parse(result.content[0].text); }
async function cli(args, input, filename = entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [filename, ...args], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CLI fixture timed out")); }, 15_000);
    child.stdout.on("data", part => { stdout += part; });
    child.stderr.on("data", part => { stderr += part; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input || "");
  });
}

try {
  await writeConnection();
  await listenFixture();
  let mcp = await connectMcp();
  const list = await mcp.client.listTools();
  assert.equal(list.tools.length, 19);
  assert.equal(list.tools.find(tool => tool.name === "aporiax_list_approvals").annotations.readOnlyHint, true);
  assert.equal(list.tools.some(tool => /approve/.test(tool.name)), false);
  checked("official SDK Client initializes and discovers all 19 tools over real stdio");

  for (const name of ["status", "list_workspaces", "list_profiles", "list_providers", "list_runs"]) {
    const result = await call(mcp.client, name);
    assert.notEqual(result.isError, true, name);
  }
  assert.equal(data(await call(mcp.client, "status")).api_version, 1);
  checked("status and discovery tools call the authenticated versioned API");

  const input = { instruction: "Review fixture", workspace_id: "ws-1", profile: "review", idempotency_key: "mcp-first", limits: { max_subagents: 0 } };
  const started = data(await call(mcp.client, "start_run", input));
  const run_id = started.run_id;
  assert.equal(started.status, "running");
  const replay = data(await call(mcp.client, "start_run", input));
  assert.equal(replay.run_id, run_id);
  assert.equal(replay.replayed, true);
  const conflict = await call(mcp.client, "start_run", { ...input, instruction: "Different request" });
  assert.equal(conflict.isError, true);
  assert.equal(data(conflict).error.code, "idempotency_conflict");
  checked("task creation returns immediately and preserves task-level idempotency/errors");

  const beforeValidation = requests.length;
  for (const args of [{ ...input, profile: "admin" }, { ...input, limits: { max_model_calls: "all" } }, { ...input, approvals: true }]) {
    const result = await call(mcp.client, "start_run", args);
    assert.equal(result.isError, true);
    assert.equal(data(result).error.code, "INVALID_ARGUMENTS");
  }
  assert.equal(requests.length, beforeValidation);
  checked("unknown fields and malformed tool inputs fail before any network mutation");

  await assert.rejects(() => mcp.client.request({ method: "tools/call", params: { name: "aporiax_start_run", arguments: { ...input, idempotency_key: "unsupported-mcp-task" }, task: {} } }, CallToolResultSchema));
  assert.equal(requests.length, beforeValidation);
  checked("unsupported MCP Tasks requests cannot start work before protocol rejection");

  const denied = await call(mcp.client, "start_run", { ...input, idempotency_key: "denied", workspace_id: "forbidden" });
  assert.equal(denied.isError, true);
  assert.equal(data(denied).error.status, 403);
  assert.equal(JSON.stringify(denied).includes(token), false);
  checked("API authorization failures remain errors and reflected credentials are redacted");

  let cursor = 0;
  const received = [];
  do {
    const page = data(await call(mcp.client, "read_events", { run_id, after_seq: cursor, limit: 2 }));
    received.push(...page.events.map(event => event.seq));
    cursor = page.next_seq;
    if (!page.has_more) break;
  } while (cursor < 100);
  assert.deepEqual(received.slice(0, 5), [1, 2, 3, 4, 5]);
  checked("durable event cursors are forwarded without skipping early pages");

  for (const name of ["get_run", "list_agents", "list_questions", "list_approvals", "list_artifacts"]) assert.notEqual((await call(mcp.client, name, { run_id })).isError, true);
  assert.equal(data(await call(mcp.client, "send_message", { run_id, content: "Please include source references." })).accepted, true);
  assert.equal(data(await call(mcp.client, "answer_question", { run_id, question_id: "question-1", answer: "Markdown" })).answered, true);
  checked("run/agent/question/approval/artifact discovery and task steering reach exact routes");

  const artifactChunks = [];
  let offset = 0;
  while (true) {
    const page = data(await call(mcp.client, "read_artifact", { run_id, artifact_id: "artifact-1", offset, limit: 7 }));
    artifactChunks.push(Buffer.from(page.content, page.encoding));
    offset = page.next_offset;
    if (!page.has_more) break;
  }
  assert.deepEqual(Buffer.concat(artifactChunks), artifactBytes);
  checked("artifact byte pagination preserves Chinese UTF-8 across split code points");

  await mcp.close();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(requests.some(request => request.pathname.endsWith("/cancel")), false);
  assert.equal(runs.get(run_id).status, "completed");
  mcp = await connectMcp();
  assert.equal(data(await call(mcp.client, "get_result", { run_id })).summary, "Fixture result");
  checked("stdio disconnection never cancels an accepted run; reconnect retrieves its result");

  await new Promise(resolve => server.close(resolve));
  await listenFixture();
  assert.equal(data(await call(mcp.client, "status")).instance_id, "2");
  checked("the same MCP process discovers the new random port after desktop restart");

  for (const [operation, expected] of [["pause_run", "paused"], ["resume_run", "running"], ["cancel_run", "cancelled"]]) assert.equal(data(await call(mcp.client, operation, { run_id })).status, expected);
  checked("pause/resume/explicit cancel expose API state changes");

  const cliRun = await cli(["run", "--connection", connectionPath, "--input", "-"], JSON.stringify({ ...input, idempotency_key: "cli-stdin" }));
  assert.equal(cliRun.code, 0, cliRun.stderr);
  assert.equal(cliRun.stderr, "");
  assert.match(JSON.parse(cliRun.stdout).run_id, /^run-/);
  const cliArgs = await cli(["run", "--connection", connectionPath, "--workspace", "ws-1", "--profile", "review", "--instruction", "中文 instructions", "--request-id", "cli-flags", "--max-subagents", "0"]);
  assert.equal(cliArgs.code, 0, cliArgs.stderr);
  assert.match(JSON.parse(cliArgs.stdout).run_id, /^run-/);
  checked("CLI accepts JSON stdin and named flags with clean JSON stdout");

  const invalidJson = await cli(["run", "--connection", connectionPath, "--input", "-"], "{broken");
  assert.equal(invalidJson.code, 1);
  assert.equal(invalidJson.stdout, "");
  assert.equal(JSON.parse(invalidJson.stderr).error.code, "CLI_ARGUMENTS");
  const tokenFlag = await cli(["status", "--connection", connectionPath, "--token", token]);
  assert.equal(tokenFlag.code, 1);
  assert.equal(`${tokenFlag.stdout}${tokenFlag.stderr}`.includes(token), false);
  checked("CLI malformed input and forbidden token arguments fail cleanly without credential logs");

  const direct = createControlClient({ connectionPath });
  await writeDiscovery({ baseUrl: "http://example.com:80" });
  await assert.rejects(() => direct.request("GET", "/meta"), { code: "UNSAFE_ENDPOINT" });
  await writeDiscovery({ baseUrl: `http://localhost:${port}` });
  await assert.rejects(() => direct.request("GET", "/meta"), { code: "UNSAFE_ENDPOINT" });
  await writeDiscovery({ baseUrl: `http://127.0.0.1:${port}/redirect` });
  await assert.rejects(() => direct.request("GET", "/meta"), { code: "UNSAFE_ENDPOINT" });
  checked("discovery refuses public hosts, DNS names and URL path injection");

  await writeDiscovery({ version: 2 });
  await assert.rejects(() => direct.request("GET", "/meta"), { code: "API_VERSION_MISMATCH" });
  await writeDiscovery({ enabled: false });
  await assert.rejects(() => direct.request("GET", "/meta"), { code: "CONTROL_DISABLED" });
  await writeDiscovery();
  await writeConnection({ token: randomBytes(32).toString("base64url") });
  await assert.rejects(() => direct.request("GET", "/meta"), { code: "invalid_client", status: 401 });
  await writeConnection();
  checked("protocol mismatch, disabled control and revoked clients have actionable errors");

  if (process.platform !== "win32") {
    await fs.chmod(connectionPath, 0o644);
    await assert.rejects(() => direct.request("GET", "/meta"), { code: "INSECURE_CONNECTION" });
    await fs.chmod(connectionPath, 0o600);
    checked("world-readable private connection files are refused on POSIX");
  }

  const config = getClientConfiguration({ execPath: 'C:\\Program Files\\AporiaX\\AporiaX.exe', bridgePath: 'C:\\Program Files\\AporiaX\\resources\\control-bridge.cjs', connectionPath: 'C:\\Users\\兰\\AporiaX\\client.json' });
  assert.equal(config.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(config.mcpConfig.mcpServers.aporiax.args.at(-1), 'C:\\Users\\兰\\AporiaX\\client.json');
  assert.ok(config.codexToml.includes('command = "C:\\\\Program Files\\\\AporiaX\\\\AporiaX.exe"'));
  assert.equal(JSON.stringify(config).includes(token), false);
  assert.throws(() => getClientConfiguration({ execPath: "relative.exe", bridgePath: "/bridge", connectionPath: "/connection" }));
  checked("copyable MCP JSON and Codex TOML escape Windows paths and omit tokens");

  const build = await cli([], undefined, path.join(root, "scripts/build-control-bridge.mjs"));
  assert.equal(build.code, 0, build.stderr);
  const standaloneBundle = path.join(temporary, "standalone-control-bridge.cjs");
  await fs.copyFile(bundle, standaloneBundle);
  const bundledMcp = await connectMcp(standaloneBundle);
  assert.equal((await bundledMcp.client.listTools()).tools.length, 19);
  assert.equal(data(await call(bundledMcp.client, "status")).api_version, 1);
  await bundledMcp.close();
  checked("the bundled standalone CJS bridge runs the real SDK transport without external packages");

  const electronExecutable = createRequire(import.meta.url)("electron");
  const electronMcp = await connectMcp(standaloneBundle, connectionPath, { command: electronExecutable, env: { ELECTRON_RUN_AS_NODE: "1" } });
  assert.equal((await electronMcp.client.listTools()).tools.length, 19);
  assert.equal(data(await call(electronMcp.client, "status")).api_version, 1);
  await electronMcp.close();
  checked("Electron's bundled Node runtime performs a real MCP stdio handshake without a Node executable command");

  await new Promise(resolve => server.close(resolve));
  server = null;
  const offline = await call(mcp.client, "status");
  assert.equal(offline.isError, true);
  assert.equal(data(offline).error.code, "DESKTOP_UNAVAILABLE");
  await mcp.close();
  checked("offline desktops produce explicit tool errors instead of false success");

  // Exercise the production control service/server/store as well as the
  // protocol fixture above. Only the model execution callback is simulated.
  const { createLocalControlService } = await import("../electron/control/service.js");
  const { createLocalControlServer } = await import("../electron/control/server.js");
  const realDirectory = path.join(temporary, "production-service");
  const workspacePath = path.join(realDirectory, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });
  const active = new Map();
  const runtime = {
    subscribeRunFinished: () => () => {}, getRunResult: async () => null,
    getActiveRun: id => active.has(id) ? { runId: id, clarifications: [{ id: "question-real", question: "Output format?", status: "pending" }] } : null,
    getPendingApprovals: () => [],
    pause: async () => true, resume: async () => true, interrupt: () => true, steer: () => true,
    respondClarification: async () => ({ accepted: true }),
  };
  const serviceOptions = { dataDirectory: realDirectory, taskRuntime: runtime,
    listProviders: () => [{ id: "local", apiKey: "secret-provider-key", models: ["fixture-model"] }],
    startRun: async (request, context) => {
      active.set(request.runId, context);
      await context.onPrepared({ workspacePath });
      context.onEvent({ type: "response.delta", delta: "Production service event", agentId: "main", role: "main" });
      return { runId: request.runId };
    },
  };
  let realService;
  let realServer;
  let realMcp;
  try {
    realService = await createLocalControlService(serviceOptions);
    const ws = await realService.admin("registerWorkspace", { path: workspacePath });
    const grant = await realService.admin("createClient", { name: "SDK production service test", workspaceIds: [ws.id], profiles: ["review"], providerIds: ["local"] });
    await realService.admin("setEnabled", { enabled: true });
    realServer = createLocalControlServer({ service: realService });
    await realServer.listen();
    await realService.setEndpoint(realServer.url);
    realMcp = await connectMcp(bundle, grant.connectionFile);
    const productionMeta = data(await call(realMcp.client, "status"));
    assert.equal(productionMeta.api_version, 1);
    assert.equal(productionMeta.openapi_path, "/control/v1/openapi");
    const openapiCli = await cli(["openapi", "--connection", grant.connectionFile], undefined, bundle);
    assert.equal(openapiCli.code, 0, openapiCli.stderr);
    const spec = JSON.parse(openapiCli.stdout);
    assert.equal(spec.openapi, "3.1.0");
    assert.ok(spec.paths["/control/v1/runs"].post.operationId);
    assert.ok(spec.components.securitySchemes);
    assert.equal(openapiCli.stdout.includes(grant.token), false);
    checked("CLI exports the authenticated production OpenAPI schema with reserved keys intact and no credential");
    assert.equal(JSON.stringify(await call(realMcp.client, "list_providers")).includes("secret-provider-key"), false);
    const realInput = { instruction: "Use the production local API", workspace_id: ws.id, profile: "review", idempotency_key: "real-service-1", limits: { max_subagents: 0 } };
    const realRun = data(await call(realMcp.client, "start_run", realInput));
    assert.ok(realRun.run_id);
    assert.equal(data(await call(realMcp.client, "start_run", realInput)).run_id, realRun.run_id);
    for (let index = 0; index < 12; index += 1) await new Promise(resolve => setImmediate(resolve));
    assert.ok(active.has(realRun.run_id));
    assert.notEqual((await call(realMcp.client, "send_message", { run_id: realRun.run_id, content: "Include a summary" })).isError, true);
    assert.notEqual((await call(realMcp.client, "answer_question", { run_id: realRun.run_id, question_id: "question-real", answer: "Markdown" })).isError, true);
    const actualEvents = data(await call(realMcp.client, "read_events", { run_id: realRun.run_id, after_seq: 0, limit: 100 }));
    assert.ok(actualEvents.events.some(event => event.type === "response.delta"));
    await active.get(realRun.run_id).onResult({ runId: realRun.run_id, result: { status: "completed", content: "Actual durable result", verification: { status: "not_verified" } } });
    const actualResult = data(await call(realMcp.client, "get_result", { run_id: realRun.run_id }));
    assert.equal(actualResult.result.content, "Actual durable result");
    const artifact = actualResult.artifacts[0];
    assert.ok(artifact.artifact_id);
    const actualArtifact = data(await call(realMcp.client, "read_artifact", { run_id: realRun.run_id, artifact_id: artifact.artifact_id }));
    assert.equal(actualArtifact.encoding, "base64");
    assert.ok(Buffer.from(actualArtifact.content, "base64").length > 0);
    checked("production API + SQLite + official MCP SDK agree on start/retry/events/steering/questions/results/artifacts");
    await realServer.close(); realServer = null;
    await realService.shutdown(); realService = null;
    realService = await createLocalControlService(serviceOptions);
    realServer = createLocalControlServer({ service: realService });
    await realServer.listen(); await realService.setEndpoint(realServer.url);
    const afterRestart = data(await call(realMcp.client, "get_result", { run_id: realRun.run_id }));
    assert.equal(afterRestart.result.content, "Actual durable result");
    assert.equal(data(await call(realMcp.client, "status")).api_version, 1);
    checked("the same bundled MCP process reads persistent results after a real service/database restart");
  } finally {
    await realMcp?.close();
    await realServer?.close();
    await realService?.shutdown();
  }
  process.stdout.write(`\n${checks} checks passed. Real MCP SDK + stdio/CLI and production control API/SQLite; model callbacks were simulated. No real provider or external Harness UI was used.\n`);
} finally {
  for (const timer of timers) clearTimeout(timer);
  for (const client of connections) await client.close().catch(() => {});
  if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  await fs.rm(temporary, { recursive: true, force: true });
}
