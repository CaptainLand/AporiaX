import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createControlActivityTracker, createDesktopLocalControl, createExternalTaskAdapter, desktopControlBridgePath } from "../electron/control/desktop-runtime.js";
import { currentLocalControlPolicy, acquireLocalControlWorker } from "../electron/control/policy.js";
import { createHarnessTaskRuntime } from "../electron/harness/task-runtime.js";
import { closeRunJournalStore } from "../electron/run-store.js";
import { createPermissionPolicy } from "../electron/agent-core.js";
import { TOOL_REGISTRY } from "../electron/runtime/native-tool-catalog.js";
import { dispatchNativeTool } from "../electron/runtime/tool-dispatcher.js";
import { callModelProviderOnce } from "../electron/runtime/provider-stream.js";
import { runHarness } from "../electron/agent-runtime.js";
import { createServer } from "node:http";
import { createFileAccessSettings } from "../electron/runtime/file-access-settings.js";
import { configureNativeFileAccess } from "../electron/runtime/file-access-policy.js";

// The HTTP service, desktop adapter, policy gates, worktree copying, journals,
// lifecycle and result callbacks are real. Only provider transport and the
// final authorized native filesystem operation use deterministic fixtures.
const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "aporiax-control-desktop-"));
const dataDirectory = join(directory, "data");
const source = join(directory, "project");
const otherSource = join(directory, "other-project");
const nativeFetch = globalThis.fetch;
const provider = { id: "fixture-provider", name: "Fixture", baseUrl: "https://control-fixture.invalid/v1", apiKey: "fixture-not-a-real-secret", models: [{ id: "model-allowed" }, { id: "model-denied" }] };
const snapshots = new Map();
const operations = [];
const deliveries = [];
const deliveryReads = [];
const desktopEvents = [];
const executionWaits = new Map();
let modelRequests = 0;
let nextMcpBarrier = null;
let desktop;
let runtime;
let activity;
let modelServer;
let realProvider;
const realRequests = new Map();
const modelServerFailures = [];
let checks = 0;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const eventually = async (predicate, message = "Timed out waiting for desktop lifecycle") => {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
};
const check = async (name, callback) => {
  await callback(); checks += 1; console.log(`PASS ${name}`);
};
const serverCount = () => process.getActiveResourcesInfo().filter(name => name === "TCPServerWrap").length;

function startFixtureHarness(request, context) {
  const policy = currentLocalControlPolicy();
  assert.ok(policy, "The trusted external policy must survive detached runtime startup");
  assert.equal(context.strictProvider, true);
  assert.equal(context.detached, true);
  assert.equal(request.knowledgeEnabled, false);
  assert.equal(request.extensionPolicy.skill, false);
  snapshots.set(request.runId, { request, policy, context });
  return runtime.start({
    runId: request.runId, taskId: request.taskId, clientId: context.clientId,
    metadata: { workspacePath: request.workspacePath, providerId: request.providerId, modelId: request.modelId,
      sourceUserId: request.sourceUserId, prompt: request.prompt },
    detached: context.detached, onEvent: context.onEvent,
    onResult: delivery => {
      deliveries.push(delivery);
      deliveryReads.push(runtime.getRunResult(delivery.runId).then(persisted => assert.deepEqual(persisted, delivery.result)));
      return context.onResult(delivery);
    },
    execute: async ({ signal: runtimeSignal, control, emit, requestApproval, clarification }) => {
      assert.equal(currentLocalControlPolicy(), policy, "Async context must reach the detached executor");
      const signal = AbortSignal.any([runtimeSignal, context.signal]);
      const native = async (toolName, input) => dispatchNativeTool({
        toolCall: { id: `call-${request.runId}-${operations.length}`, function: { name: toolName, arguments: JSON.stringify(input) } },
        registry: TOOL_REGISTRY, permissionPolicy: createPermissionPolicy(request.permission),
        approvalMode: request.approvalMode, requestApproval, signal,
        parseArguments: call => JSON.parse(call.function.arguments), executeContext: { workspaceRoot: request.workspacePath },
        executeAuthorized: async () => {
          operations.push({ runId: request.runId, toolName, input });
          const path = resolve(request.workspacePath, input.path);
          if (toolName === "read_file") return { modelResult: { content: await readFile(path, "utf8") } };
          if (toolName === "write_file") { await writeFile(path, input.content); return { modelResult: { path, written: true } }; }
          assert.fail(`Unexpected authorized tool ${toolName}`);
        },
      });
      let result;
      try {
        if (request.prompt.startsWith("native-")) {
          result = await runHarness({ ...request, provider: realProvider, signal, control,
            onEvent: emit, requestApproval, clarification, sandboxDataDirectory: dataDirectory,
            sandboxStatusResolver: async () => ({ available: false, localAvailable: true }),
            loopPolicy: { maxBriefSummaries: 0 }, language: "en" });
          return context.transformResult(result);
        }
        emit({ type: "agent.started", agentId: "main", role: "main" });
        if (request.prompt === "tool-zero") await native("read_file", { path: "readme.txt" });
        if (request.prompt === "worker-zero") acquireLocalControlWorker({ agentId: "forbidden-worker", role: "explore" });
        const reply = await callModelProviderOnce({ provider,
          body: { model: request.prompt === "malicious-model" ? "model-denied" : request.modelId, messages: request.messages }, signal });
        const content = reply.message.content;
        const original = await native("read_file", { path: "readme.txt" });
        if (request.prompt === "escape-workspace") await native("read_file", { path: join(otherSource, "private.txt") });
        if (request.permission === "workspace-write") {
          await native("write_file", { path: "readme.txt", content: "external change\n" });
          await native("write_file", { path: "answer.md", content: "# External result\n" });
        }
        if (request.prompt === "read-only-write") await native("write_file", { path: "readme.txt", content: "forbidden\n" });
        if (request.prompt.startsWith("wait-")) {
          const release = deferred();
          executionWaits.set(request.runId, { release, control });
          await new Promise((resolve, reject) => {
            const interrupted = () => reject(Object.assign(new Error("Fixture execution cancelled"), { name: "AbortError" }));
            if (signal.aborted) return interrupted();
            signal.addEventListener("abort", interrupted, { once: true });
            release.promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", interrupted));
          });
          await control.waitIfPaused(signal);
        }
        const steering = control.consumeSteering();
        emit({ type: "response.delta", delta: content, agentId: "main" });
        result = { status: "completed", content, steps: [{ name: "fixture-observation", original: original.modelResult.content, steering }], changes: [] };
      } catch (error) {
        result = { status: signal.aborted ? "interrupted" : "failed", content: error.message, error: error.code || error.name, changes: [] };
      }
      // This is the same trusted transform hook passed to main.startHarnessTask:
      // worktree outputs are computed before Runtime's journal and onResult.
      return context.transformResult(result);
    },
  });
}

async function launch() {
  runtime = createHarnessTaskRuntime({ dataDirectory });
  activity = createControlActivityTracker();
  const fileAccessSettings = await createFileAccessSettings({ dataDirectory });
  configureNativeFileAccess(fileAccessSettings.policy);
  return createDesktopLocalControl({ dataDirectory, taskRuntime: runtime, startHarnessTask: startFixtureHarness, fileAccessSettings,
    listProviders: async () => [provider, { ...provider, id: "provider-denied" }],
    execPath: process.execPath, bridgePath: desktopControlBridgePath({ isPackaged: false, appPath: root }),
    onEvent: event => { activity.observe(event); desktopEvents.push(event); },
    loadMcp: async () => {
      if (nextMcpBarrier) {
        const barrier = nextMcpBarrier; nextMcpBarrier = null;
        barrier.entered.resolve(); await barrier.release.promise;
      }
      return { servers: [{ id: "mcp-granted", enabled: true }, { id: "mcp-private", enabled: true }], errors: [] };
    },
  });
}

try {
  await mkdir(source); await mkdir(otherSource);
  await writeFile(join(source, "readme.txt"), "committed version\n");
  await writeFile(join(otherSource, "private.txt"), "other project secret\n");
  await exec("git", ["init", "--quiet", source]);
  await exec("git", ["-C", source, "add", "readme.txt"]);
  await exec("git", ["-C", source, "-c", "user.name=Control Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  await writeFile(join(source, "readme.txt"), "local uncommitted version\n");
  await writeFile(join(source, "untracked.txt"), "local untracked file\n");
  globalThis.fetch = async (url, options) => {
    if (new URL(typeof url === "string" ? url : url.url || String(url)).hostname !== "control-fixture.invalid") return nativeFetch(url, options);
    modelRequests += 1;
    return new Response('data: {"choices":[{"delta":{"content":"Fixture finished"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
  };

  const listenerBaseline = serverCount();
  desktop = await launch();
  let status = await desktop.request({ action: "status" });
  await check("desktop starts disabled with no HTTP listener or discoverable endpoint", async () => {
    assert.equal(status.enabled, false); assert.equal(status.endpoint, null);
    assert.equal(JSON.parse(await readFile(status.discoveryPath, "utf8")).baseUrl, null);
    assert.equal(serverCount(), listenerBaseline);
  });
  const workspace = await desktop.request({ action: "registerWorkspace", input: { path: source, label: "Fixture project" } });
  const otherWorkspace = await desktop.request({ action: "registerWorkspace", input: { path: otherSource } });
  await desktop.request({ action: "setEnabled", input: { enabled: true } });
  status = await desktop.request({ action: "status" });
  let baseUrl = status.endpoint;
  const clientInput = { name: "External harness", workspaceIds: [workspace.id], profiles: ["review", "workspace"],
    providerIds: [provider.id], modelIds: ["model-allowed"], capabilities: { mcp: true }, allowedMcpServerIds: ["mcp-granted"] };
  const connection = await desktop.request({ action: "createClient", input: clientInput });
  const stranger = await desktop.request({ action: "createClient", input: { ...clientInput, name: "Independent harness" } });
  const api = async (method, path, body, token = connection.token) => {
    const response = await nativeFetch(`${baseUrl}/control/v1${path}`, { method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const requestRun = (instruction, overrides = {}) => api("POST", "/runs", {
    instruction, workspace_id: workspace.id, profile: "review", provider_id: provider.id, model_id: "model-allowed",
    idempotency_key: instruction, ...overrides,
  });
  await check("only trusted desktop requests can enable global file access", async () => {
    assert.equal(status.fileAccess.enabled, false);
    await assert.rejects(() => desktop.request({ action: "setFileAccess", input: { enabled: true } }), /risk confirmation/);
    for (const path of ["/setFileAccess", "/settings/file-access"]) {
      assert.equal((await api("POST", path, { enabled: true, riskAcknowledged: true })).status, 404);
    }
    assert.equal((await desktop.request({ action: "status" })).fileAccess.enabled, false);
  });
  const completed = async runId => eventually(async () => {
    const value = await desktop.request({ action: "getResult", input: { runId } });
    return value.result && !runtime.getActiveRun(runId) ? value : null;
  }, `Run ${runId} did not complete`);

  await check("enable starts numeric loopback HTTP and generates private credential-file MCP configuration", async () => {
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await api("GET", "/meta")).data.api_version, 1);
    assert.equal(serverCount(), listenerBaseline + 1);
    const config = JSON.parse(connection.connectionConfig.mcpJson).mcpServers.aporiax;
    assert.deepEqual(config.args.slice(-2), ["--connection", connection.connectionFile]);
    assert.equal(config.env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(config.command, process.execPath);
    assert.equal(JSON.stringify(connection.connectionConfig).includes(connection.token), false);
    assert.equal(JSON.stringify(await desktop.request({ action: "status" })).includes(connection.token), false);
    const privateFile = JSON.parse(await readFile(connection.connectionFile, "utf8"));
    assert.equal(privateFile.token, connection.token);
    if (process.platform !== "win32") assert.equal((await stat(connection.connectionFile)).mode & 0o777, 0o600);
  });

  await check("HTTP and actual execution both enforce workspace, provider and model grants", async () => {
    for (const [overrides, code] of [
      [{ workspace_id: otherWorkspace.id }, "scope_denied"],
      [{ provider_id: "provider-denied" }, "provider_denied"],
      [{ model_id: "model-denied" }, "model_denied"],
    ]) {
      const refused = await requestRun(`grant-${code}`, overrides);
      assert.equal(refused.status, 403); assert.equal(refused.data.error.code, code);
    }
    const before = modelRequests;
    const malicious = await requestRun("malicious-model");
    const failure = await completed(malicious.data.run_id);
    assert.equal(failure.result.error, "LOCAL_CONTROL_FORBIDDEN");
    assert.equal(modelRequests, before, "An internally substituted model must fail before provider transport");
    const escaped = await requestRun("escape-workspace");
    const escapeResult = await completed(escaped.data.run_id);
    assert.equal(escapeResult.result.error, "LOCAL_CONTROL_FORBIDDEN");
    assert.equal(operations.some(item => item.input.path === join(otherSource, "private.txt")), false);
    assert.equal((await api("GET", `/runs/${escaped.data.run_id}`, undefined, stranger.token)).status, 404);
  });

  let editedRun;
  await check("detached edit snapshots dirty source, persists enhanced results and serves patch artifacts", async () => {
    const accepted = await requestRun("edit-project", { profile: "workspace" });
    assert.equal(accepted.status, 202); editedRun = accepted.data.run_id;
    const result = await completed(editedRun);
    assert.equal(result.status, "completed");
    assert.equal(result.result.steps[0].original, "local uncommitted version\n");
    assert.equal(result.result.workspace.mode, "worktree");
    assert.equal(result.result.workspace.mergeRequired, true);
    assert.notEqual(result.result.workspace.path, source);
    assert.equal(await readFile(join(source, "readme.txt"), "utf8"), "local uncommitted version\n");
    assert.equal(await readFile(join(result.result.workspace.path, "readme.txt"), "utf8"), "external change\n");
    assert.equal(await readFile(join(result.result.workspace.path, "untracked.txt"), "utf8"), "local untracked file\n");
    await assert.rejects(readFile(join(source, "answer.md")), { code: "ENOENT" });
    assert.deepEqual(result.result.workspaceChanges.map(change => change.path).sort(), ["answer.md", "readme.txt"]);
    assert.deepEqual(snapshots.get(editedRun).request.mcpServers.map(server => server.id), ["mcp-granted"]);
    assert.equal(result.result.controlUsage.modelCalls, 1);
    assert.equal(result.result.controlUsage.toolCalls, 3);
    assert.ok(deliveries.find(delivery => delivery.runId === editedRun).result.workspaceChanges.length);
    await Promise.all(deliveryReads);
    const patch = result.artifacts.find(artifact => artifact.name.endsWith("changes.patch"));
    assert.ok(patch, "Finalized patch must be registered as an API artifact");
    const downloaded = await api("GET", `/runs/${editedRun}/artifacts/${patch.id}`);
    assert.equal(downloaded.status, 200);
    const patchText = Buffer.from(downloaded.data.content, "base64").toString("utf8");
    assert.match(patchText, /-local uncommitted version/);
    assert.match(patchText, /\+external change/);
    assert.ok(desktopEvents.some(event => event.type === "run.completed" && event.runId === editedRun));
  });

  await check("read-only cannot write and explicit zero budgets stop before model/tool/worker work", async () => {
    const readonly = await requestRun("read-only-write");
    assert.equal((await completed(readonly.data.run_id)).result.error, "LOCAL_CONTROL_FORBIDDEN");
    assert.equal(await readFile(join(source, "readme.txt"), "utf8"), "local uncommitted version\n");
    for (const [instruction, limits] of [
      ["model-zero", { max_model_calls: 0 }],
      ["tool-zero", { max_tool_calls: 0 }],
      ["worker-zero", { max_subagents: 0, max_parallel_agents: 0 }],
    ]) {
      const beforeModels = modelRequests, beforeTools = operations.length;
      const accepted = await requestRun(instruction, { limits });
      const result = await completed(accepted.data.run_id);
      assert.equal(result.status, "failed");
      assert.match(result.result.error, /^LOCAL_CONTROL_(BUDGET_EXCEEDED|CONCURRENCY_LIMIT)$/);
      assert.equal(modelRequests, beforeModels); assert.equal(operations.length, beforeTools);
    }
  });

  await check("guidance remains literal text, owned controls work and pause/resume preserve the run", async () => {
    const accepted = await requestRun("wait-guidance");
    const runId = accepted.data.run_id;
    const waiting = await eventually(() => executionWaits.get(runId));
    await eventually(async () => (await desktop.request({ action: "getRun", input: { runId } })).status === "running");
    assert.equal(activity.listRuns().length, 1);
    assert.equal(runtime.listActiveRuns().length, 1);
    assert.equal(activity.combined(runtime.listActiveRuns()).length, 1, "A running external task must not be counted twice");
    const guidance = "@browser use my private page; @skill global-secret; [file](../other-project/private.txt)";
    assert.equal((await api("POST", `/runs/${runId}/messages`, { content: guidance })).status, 200);
    assert.equal((await api("POST", `/runs/${runId}/pause`, {})).status, 200);
    assert.equal(runtime.getActiveRun(runId).paused, true);
    assert.equal((await api("POST", `/runs/${runId}/resume`, {}, stranger.token)).status, 404);
    assert.equal((await api("POST", `/runs/${runId}/resume`, {})).status, 200);
    waiting.release.resolve();
    const result = await completed(runId);
    assert.equal(result.result.steps[0].steering.length, 1);
    assert.equal(result.result.steps[0].steering[0].content, guidance);
    assert.deepEqual(result.result.steps[0].steering[0].attachments || [], []);
    const runEvents = (await api("GET", `/runs/${runId}/events?limit=1000`)).data.events;
    assert.ok(runEvents.some(event => event.type === "message.sent"));
    assert.ok(runEvents.some(event => event.type === "control.paused"));
    assert.ok(runEvents.some(event => event.type === "control.resumed"));
  });

  await check("cancelling during preparation prevents runtime/model execution", async () => {
    const barrier = { entered: deferred(), release: deferred() }; nextMcpBarrier = barrier;
    const beforeModels = modelRequests;
    const accepted = await requestRun("cancel-preparation", { profile: "workspace" });
    const runId = accepted.data.run_id;
    await barrier.entered.promise;
    assert.equal(snapshots.has(runId), false);
    const preparing = await desktop.request({ action: "getRun", input: { runId } });
    assert.equal(preparing.status, "starting");
    assert.equal(runtime.hasActiveRuns(), false);
    assert.equal(activity.listRuns().length, 1, "Accepted preparation must keep background/quit/update activity nonzero before Runtime registers");
    assert.equal(activity.combined(runtime.listActiveRuns())[0].runId, runId);
    assert.notEqual(preparing.executionWorkspacePath, source, "Trusted execution root is saved before startup");
    assert.equal((await api("POST", `/runs/${runId}/cancel`, {})).status, 200);
    barrier.release.resolve();
    const result = await completed(runId);
    assert.equal(result.status, "cancelled");
    assert.equal(snapshots.has(runId), false); assert.equal(modelRequests, beforeModels);
    assert.equal(activity.listRuns().length, 0, "Completion must clear pending desktop activity");
  });

  await check("cancelling execution retains worktree changes and persists interrupted runtime results", async () => {
    const accepted = await requestRun("wait-cancel", { profile: "workspace" });
    const runId = accepted.data.run_id;
    await eventually(() => executionWaits.has(runId));
    assert.equal((await api("POST", `/runs/${runId}/cancel`, {})).status, 200);
    const result = await completed(runId);
    assert.equal(result.status, "cancelled");
    assert.equal(result.result.workspace.mergeRequired, true);
    assert.equal(result.result.workspaceChanges.length, 2);
    const journalResult = await runtime.getRunResult(runId);
    assert.equal(journalResult.status, "interrupted");
    assert.equal(journalResult.workspaceChanges.length, 2);
    assert.equal(await readFile(join(source, "readme.txt"), "utf8"), "local uncommitted version\n");
    executionWaits.get(runId).release.resolve();
  });

  await check("disabling closes the listener; restart keeps credentials, ordered events and final results", async () => {
    const firstInstance = status.instanceId;
    const eventsBefore = (await api("GET", `/runs/${editedRun}/events?limit=1000`)).data.events;
    await desktop.request({ action: "setEnabled", input: { enabled: false } });
    await assert.rejects(nativeFetch(`${baseUrl}/control/v1/meta`, { headers: { Authorization: `Bearer ${connection.token}` } }));
    assert.equal((await desktop.request({ action: "status" })).endpoint, null);
    await eventually(() => serverCount() === listenerBaseline);
    await desktop.request({ action: "setEnabled", input: { enabled: true } });
    await desktop.shutdown(); desktop = null;
    await closeRunJournalStore(dataDirectory);
    desktop = await launch();
    status = await desktop.request({ action: "status" }); baseUrl = status.endpoint;
    assert.equal(status.enabled, true); assert.notEqual(status.instanceId, firstInstance);
    assert.equal((await api("GET", "/meta")).status, 200);
    const discovery = JSON.parse(await readFile(connection.discoveryPath, "utf8"));
    assert.equal(discovery.baseUrl, baseUrl); assert.equal(discovery.instanceId, status.instanceId);
    const result = (await api("GET", `/runs/${editedRun}/result`)).data;
    assert.equal(result.result.content, "Fixture finished");
    assert.equal(result.result.workspace.merge_required, true);
    assert.equal(result.result.workspace_changes.length, 2);
    const events = [];
    let cursor = 0, more = true;
    while (more) {
      const page = (await api("GET", `/runs/${editedRun}/events?after_seq=${cursor}&limit=7`)).data;
      for (const event of page.events) { assert.ok(event.seq > cursor); cursor = event.seq; events.push(event); }
      more = page.has_more;
    }
    assert.deepEqual(events, eventsBefore);
  });

  await check("real runHarness review and write loops execute native tools through a local HTTP model fixture", async () => {
    modelServer = createServer(async (req, res) => {
      try {
        assert.equal(req.url, "/v1/chat/completions");
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const external = JSON.stringify(body.messages).includes("native-external");
        const editing = external || JSON.stringify(body.messages).includes("native-edit");
        const scenario = external ? "native-external" : editing ? "native-edit" : "native-review";
        const requests = realRequests.get(scenario) || []; requests.push(body); realRequests.set(scenario, requests);
        assert.ok(requests.length <= (editing ? 4 : 2), "Native loop made unexpected extra provider calls");
        assert.equal(body.model, "model-allowed");
        const toolNames = body.tools.map(tool => tool.function.name);
        assert.ok(toolNames.includes("read_file"));
        assert.equal(toolNames.includes("search_skills"), false);
        assert.equal(toolNames.includes("browser_open"), false);
        assert.equal(toolNames.includes("run_command"), false);
        let toolName, input;
        if (requests.length === 1) { toolName = "read_file"; input = { path: "readme.txt" }; }
        else if (editing && requests.length === 2) {
          assert.ok(JSON.stringify(body.messages).includes("local uncommitted version"), "The real read_file result must reach the provider");
          toolName = "write_file"; input = { path: external ? join(otherSource, "private.txt") : "native-output.txt", content: "Native agent wrote this output\n" };
        } else if (editing && requests.length === 3) { toolName = "read_file"; input = { path: external ? join(otherSource, "private.txt") : "native-output.txt" }; }
        else { toolName = "finish_task"; input = { status: "completed", summary: editing ? "Native edit verified." : "Native review completed." }; }
        const payload = { choices: [{ delta: { tool_calls: [{ index: 0, id: `${scenario}-${requests.length}`, type: "function",
          function: { name: toolName, arguments: JSON.stringify(input) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 40, completion_tokens: 10 } };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
      } catch (error) {
        modelServerFailures.push(error);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "The deterministic model fixture rejected an unexpected request." } }));
      }
    });
    await new Promise((resolve, reject) => { modelServer.once("error", reject); modelServer.listen(0, "127.0.0.1", resolve); });
    realProvider = { ...provider, vendor: "deepseek", baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
      models: [{ id: "model-allowed", supportsTools: true, contextWindow: 64000 }] };
    const nativeClient = await desktop.request({ action: "createClient", input: { ...clientInput, name: "Native loop client",
      capabilities: {}, allowedMcpServerIds: [], limits: { maxDurationSeconds: 30, maxModelCalls: 8, maxToolCalls: 20, maxSubagents: 0, maxParallelAgents: 0 } } });
    for (const [instruction, profile] of [["native-review", "review"], ["native-edit", "workspace"], ["native-external", "workspace"]]) {
      if (instruction === "native-external") await desktop.request({ action: "setFileAccess", input: { enabled: true, riskAcknowledged: true } });
      const accepted = await api("POST", "/runs", { instruction, profile, workspace_id: workspace.id,
        provider_id: provider.id, model_id: "model-allowed", idempotency_key: instruction }, nativeClient.token);
      assert.equal(accepted.status, 202);
      // Do not wait for the UI's run.completed notification: an API consumer
      // acts as soon as it first observes a terminal run. Delivery must already
      // contain every registered artifact at that boundary.
      await eventually(async () => {
        const run = await desktop.request({ action: "getRun", input: { runId: accepted.data.run_id } });
        return ["completed", "failed", "blocked", "partial", "cancelled", "interrupted"].includes(run.status);
      });
      if (instruction === "native-edit") {
        const initialDelivery = await desktop.request({ action: "getResult", input: { runId: accepted.data.run_id } });
        assert.ok(initialDelivery.artifacts.some(artifact => artifact.name.endsWith("changes.patch")),
          "The first terminal status must expose the completed patch artifact without waiting for a later event");
      }
      const result = await completed(accepted.data.run_id);
      assert.deepEqual(modelServerFailures, [], modelServerFailures[0]?.stack);
      assert.equal(result.status, "completed", JSON.stringify(result.result));
      assert.match(result.result.content, instruction !== "native-review" ? /Native edit verified/ : /Native review completed/);
      assert.ok(result.result.steps.some(step => step.name === "read_file" && step.success === true));
      assert.equal(result.result.controlUsage.modelCalls, instruction !== "native-review" ? 4 : 2);
      if (instruction === "native-external") {
        assert.equal(await readFile(join(otherSource, "private.txt"), "utf8"), "Native agent wrote this output\n");
        assert.deepEqual(result.result.workspaceChanges, [], "External host changes are not workspace patch artifacts");
        await desktop.request({ action: "setFileAccess", input: { enabled: false } });
      }
      assert.equal(await readFile(join(source, "readme.txt"), "utf8"), "local uncommitted version\n");
      await assert.rejects(readFile(join(source, "native-output.txt")), { code: "ENOENT" });
      if (instruction === "native-edit") {
        assert.ok(result.result.steps.some(step => step.name === "write_file" && step.success === true));
        assert.equal(await readFile(join(result.result.workspace.path, "native-output.txt"), "utf8"), "Native agent wrote this output\n");
        assert.deepEqual(result.result.workspaceChanges.map(change => change.path), ["native-output.txt"]);
        const patch = result.artifacts.find(artifact => artifact.name.endsWith("changes.patch"));
        assert.ok(patch);
        const downloaded = await api("GET", `/runs/${accepted.data.run_id}/artifacts/${patch.id}`, undefined, nativeClient.token);
        assert.match(Buffer.from(downloaded.data.content, "base64").toString(), /\+Native agent wrote this output/);
        assert.equal((await runtime.getRunResult(accepted.data.run_id)).workspaceChanges.length, 1);
      } else if (instruction === "native-review") {
        assert.equal(result.result.workspace.mode, "read-only");
        assert.equal(result.result.workspace.path, source);
      }
    }
    const before = realRequests.get("native-review").length;
    const zero = await api("POST", "/runs", { instruction: "native-review-zero", profile: "review", workspace_id: workspace.id,
      provider_id: provider.id, model_id: "model-allowed", idempotency_key: "native-review-zero", limits: { max_model_calls: 0 } }, nativeClient.token);
    const zeroResult = await completed(zero.data.run_id);
    assert.equal(zeroResult.status, "failed");
    assert.equal(zeroResult.result.controlUsage.modelCalls, 0);
    assert.equal(realRequests.get("native-review").length, before, "Real Harness initialization must not bypass a zero model budget");
    await Promise.all(deliveryReads);
  });

  await check("adapter rejects forged owner context and development/packaged bridge paths match packaging", async () => {
    const adapter = createExternalTaskAdapter({ dataDirectory, taskRuntime: runtime, startHarnessTask: startFixtureHarness });
    await assert.rejects(adapter.startRun({ workspacePath: source, externalControl: { clientId: "owner" } }, { clientId: "external:stranger" }), /trusted external client/);
    const devBridge = desktopControlBridgePath({ isPackaged: false, appPath: root });
    assert.equal((await stat(devBridge)).isFile(), true);
    const packagedBridge = desktopControlBridgePath({ isPackaged: true, resourcesPath: join(directory, "resources") });
    assert.equal(packagedBridge, join(directory, "resources", "control-bridge.cjs"));
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.ok(pkg.build.extraResources.some(entry => entry.from === "build/control-bridge.cjs" && entry.to === "control-bridge.cjs"));
    assert.match(pkg.scripts.build, /build:control-bridge/);
  });

  console.log(`Local control desktop integration: ${checks} checks passed (real HTTP, detached Runtime, durable journal, policy gates, worktrees, cancellation and restart).`);
} finally {
  nextMcpBarrier?.release.resolve();
  for (const waiting of executionWaits.values()) waiting.release.resolve();
  await desktop?.shutdown();
  await new Promise(resolve => { if (!modelServer) return resolve(); modelServer.closeIdleConnections?.(); modelServer.close(resolve); });
  await eventually(() => !runtime?.hasActiveRuns()).catch(() => {});
  await closeRunJournalStore(dataDirectory).catch(() => {});
  globalThis.fetch = nativeFetch;
  configureNativeFileAccess(() => ({ enabled: false }));
  await rm(directory, { recursive: true, force: true });
}
