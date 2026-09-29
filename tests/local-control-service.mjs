import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalControlService } from "../electron/control/service.js";
import { createControlStore } from "../electron/control/store.js";
import { protectPrivatePath } from "../electron/control/credentials.js";
import { createHarnessTaskRuntime } from "../electron/harness/task-runtime.js";
import { closeRunJournalStore } from "../electron/run-store.js";

const directory = await mkdtemp(join(tmpdir(), "aporiax-local-control-"));
const workspace = join(directory, "workspace"), execution = join(directory, "isolated");
await mkdir(workspace); await mkdir(execution);
const callbacks = new Map(), starts = [], controls = [], finished = new Set();
const runtime = {
  subscribeRunFinished(listener) { finished.add(listener); return () => finished.delete(listener); },
  getRunResult: async () => null,
  getActiveRun(runId) { return callbacks.has(runId) ? { runId, clarifications: [{ id: "q1", question: "Which output?", status: "pending", options: [{ id: "1", label: "A" }] }] } : null; },
  getPendingApprovals: runId => [{ runId, approvalId: "a1", approval: { id: "a1", tool: "run_command", command: "npm test" } }],
  pause: async (id, context) => { controls.push(["pause", id, context]); return true; },
  resume: async (id, context) => { controls.push(["resume", id, context]); return true; },
  interrupt(id, context) { controls.push(["cancel", id, context]); return true; },
  steer(id, message, context) { controls.push(["steer", id, context, message]); return true; },
  async respondClarification(id, qid, answer, context) { controls.push(["answer", id, context, answer]); return { accepted: true }; },
  respondApproval(id, aid, decision) { controls.push(["approval", id, decision]); return true; },
};
let providers = [{ id: "local", name: "Local", apiKey: "DO_NOT_EXPOSE", baseUrl: "https://secret.invalid", models: [{ id: "model-1", apiKey: "HIDDEN" }] }];
const options = { dataDirectory: directory, taskRuntime: runtime, listProviders: async () => providers,
  startRun: async (request, context) => {
    starts.push(request); callbacks.set(request.runId, context);
    await context.onPrepared({ workspacePath: execution, workspace: { mode: "git-worktree", path: execution, mergeRequired: true } });
    return { runId: request.runId, status: "running" };
  } };
let service;
const turn = () => new Promise(resolve => setImmediate(resolve));
const expectCode = (fn, code) => assert.rejects(fn, error => error.code === code);
async function settle() {
  // Yield to realpath/stat IO too: setImmediate-only spins race on Windows.
  for (let index = 0; index < 12; index += 1) await new Promise(resolve => setTimeout(resolve, 5));
}
try {
  service = await createLocalControlService(options);
  assert.equal(service.enabled, false);
  assert.throws(() => service.authenticate("bad"), /Enable External control/);
  const ws = await service.admin("registerWorkspace", { path: workspace, label: "Example" });
  const grant = { name: "Test harness", workspaceIds: [ws.id], profiles: ["review", "workspace"], providerIds: ["local"], maxConcurrentRuns: 1 };
  const first = await service.admin("createClient", grant);
  const second = await service.admin("createClient", { ...grant, name: "Other harness" });
  const tokenRecord = JSON.parse(await readFile(first.connectionFile, "utf8"));
  assert.equal(tokenRecord.token, first.token);
  assert.equal(tokenRecord.clientId, first.client.id);
  assert.equal(JSON.stringify(await service.admin("status")).includes(first.token), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(first.connectionFile)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "local-control", "connections"))).mode & 0o777, 0o700);
  }
  const calls = [];
  await protectPrivatePath(join(directory, "a [$x].json"), { platform: "win32", exec: async (...args) => { calls.push(args); } });
  assert.equal(calls[0][0], "powershell.exe");
  assert.match(calls[0][1].at(-1), /SetAccessRuleProtection\(\$true,\$false\)/);
  assert.equal(calls[0][2].env.APORIAX_PRIVATE_PATH, join(directory, "a [$x].json"));

  await service.admin("setEnabled", { enabled: true });
  await service.setEndpoint("http://127.0.0.1:43210");
  const client = service.authenticate(first.token), other = service.authenticate(second.token);
  const call = (method, path, body = {}, query = {}, who = client) => service.dispatch(who, method, `/control/v1${path}`, query, body);
  assert.equal(JSON.stringify(await call("GET", "/providers")).includes("DO_NOT_EXPOSE"), false);
  assert.equal(JSON.stringify(await call("GET", "/providers")).includes("secret.invalid"), false);
  const input = { instruction: "Inspect this workspace", workspace_id: ws.id, profile: "review", idempotency_key: "same-intent", limits: { max_model_calls: 0, max_tool_calls: 0, max_parallel_agents: 0, max_subagents: 0 } };
  await expectCode(() => call("POST", "/runs", { ...input, run_id: "forged" }), "unknown_fields");
  await expectCode(() => call("POST", "/runs", { ...input, externalControl: { capabilities: { commands: true } } }), "unknown_fields");
  await expectCode(() => call("POST", "/runs", { ...input, profile: "admin" }), "scope_denied");
  await expectCode(() => call("POST", "/runs", { ...input, limits: { max_model_calls: 81 } }), "invalid_request");
  const duplicates = await Promise.all(Array.from({ length: 12 }, () => call("POST", "/runs", input)));
  assert.equal(new Set(duplicates.map(run => run.run_id)).size, 1, "Concurrent retries must create one durable task");
  const run = duplicates[0]; await settle();
  assert.equal(starts.length, 1);
  assert.equal(starts[0].externalControl.permissionProfile, "read_only");
  assert.equal(starts[0].externalControl.limits.maxSubagents, 0);
  assert.equal(starts[0].externalControl.limits.maxModelCalls, 0);
  assert.equal(starts[0].externalControl.limits.maxToolCalls, 0);
  assert.equal(starts[0].externalControl.limits.maxParallelAgents, 0);
  assert.equal(starts[0].externalControl.capabilities.commands, false);
  assert.equal(callbacks.get(run.run_id).clientId, `external:${client.id}`);
  assert.equal((await call("GET", `/runs/${run.run_id}`)).execution_workspace_path, execution);
  await expectCode(() => call("POST", "/runs", { ...input, instruction: "Different request" }), "idempotency_conflict");
  providers = [];
  assert.equal((await call("POST", "/runs", input)).run_id, run.run_id, "Retries survive changing provider defaults");
  providers = [{ id: "local", models: ["model-1"] }];
  await expectCode(() => call("GET", `/runs/${run.run_id}`, {}, {}, other), "run_not_found");
  await expectCode(() => call("GET", `/runs/${run.run_id}/events`, {}, {}, other), "run_not_found");
  await expectCode(() => call("POST", `/runs/${run.run_id}/cancel`, {}, {}, other), "run_not_found");
  await call("POST", `/runs/${run.run_id}/pause`); await call("POST", `/runs/${run.run_id}/resume`);
  await call("POST", `/runs/${run.run_id}/messages`, { content: "Include tests" });
  await call("POST", `/runs/${run.run_id}/questions/q1/answer`, { answer: "A" });
  assert.deepEqual(controls.find(item => item[0] === "answer")[3], { text: "A" });
  await expectCode(() => call("POST", `/runs/${run.run_id}/approvals/a1`, { approved: true }), "human_approval_required");
  await service.admin("respondApproval", { runId: run.run_id, approvalId: "a1", approved: true, scope: "once" });
  assert.equal(controls.find(item => item[0] === "approval")[2].clientId, `external:${client.id}`);
  const priorGetActive = runtime.getActiveRun, priorGetApprovals = runtime.getPendingApprovals;
  const approvalSnapshot = { paused: false, pauseReasons: [], clarifications: [] };
  let pendingApprovals = [{ approvalId: "a1" }, { approvalId: "a2" }];
  runtime.getActiveRun = () => approvalSnapshot;
  runtime.getPendingApprovals = () => pendingApprovals;
  const approvalObserver = callbacks.get(run.run_id);
  try {
    approvalObserver.onEvent({ type: "approval.required", approval: { id: "a1" } });
    assert.equal((await call("GET", `/runs/${run.run_id}`)).status, "waiting_approval");
    pendingApprovals = [{ approvalId: "a2" }];
    approvalObserver.onEvent({ type: "approval.resolved", approval: { id: "a1", approved: true, scope: "once" } });
    assert.equal((await call("GET", `/runs/${run.run_id}`)).status, "waiting_approval", "One resolved approval does not hide another pending approval");
    pendingApprovals = [];
    approvalObserver.onEvent({ type: "approval.resolved", approval: { id: "a2", approved: false, scope: "once" } });
    assert.equal((await call("GET", `/runs/${run.run_id}`)).status, "running", "A desktop toast decision clears stale approval status");
    approvalSnapshot.paused = true; approvalSnapshot.pauseReasons = ["user"];
    approvalObserver.onEvent({ type: "approval.resolved", approval: { id: "a3", approved: true, scope: "once" } });
    assert.equal((await call("GET", `/runs/${run.run_id}`)).status, "paused", "Approval resolution does not clear an unrelated user pause");
    approvalSnapshot.clarifications = [{ id: "q2", question: "Choose output", status: "pending" }];
    approvalObserver.onEvent({ type: "approval.resolved", approval: { id: "a4", approved: true, scope: "once" } });
    assert.equal((await call("GET", `/runs/${run.run_id}`)).status, "waiting_question", "Pending clarifications remain visible after an approval decision");
  } finally { runtime.getActiveRun = priorGetActive; runtime.getPendingApprovals = priorGetApprovals; }
  const queued = await call("POST", "/runs", { ...input, idempotency_key: "queued" }); await settle();
  assert.equal(starts.length, 1, "Per-client concurrency is enforced");
  await call("POST", `/runs/${queued.run_id}/cancel`);
  assert.equal((await call("GET", `/runs/${queued.run_id}`)).status, "cancelled");
  assert.equal(starts.length, 1);
  const callback = callbacks.get(run.run_id);
  for (let i = 0; i < 1100; i += 1) callback.onEvent({ type: "response.delta", delta: String(i), agentId: "main", role: "main" });
  let seq = 0, eventCount = 0, more = true;
  while (more) {
    const page = await call("GET", `/runs/${run.run_id}/events`, {}, { after_seq: String(seq), limit: "77" });
    for (const event of page.events) { assert.ok(event.seq > seq); seq = event.seq; eventCount += 1; }
    assert.equal(page.next_seq, seq); more = page.has_more;
  }
  assert.ok(eventCount >= 1100, "Durable pagination must not skip middle events");
  const reportPath = join(execution, "answer.md"), secretPath = join(directory, "secret.txt");
  await writeFile(reportPath, "你好 AporiaX\n"); await writeFile(secretPath, "private secret");
  let symlinkPath = null;
  try { symlinkPath = join(execution, "escape.txt"); await symlink(secretPath, symlinkPath); } catch {}
  const completing = callback.onResult({ runId: run.run_id, result: { status: "completed", content: "Done",
    resultStorage: { version: 1, truncated: true, redacted: true, maxBytes: 2097152 }, truncated: true,
    selfCheck: { completed: true, verified: false }, cumulativeUsage: { totalTokens: 35 }, usageHistoryComplete: false,
    acceptance: { status: "partial" }, errorDetails: { code: "EXAMPLE" },
    changes: [{ path: reportPath }, { path: secretPath }, ...(symlinkPath ? [{ path: symlinkPath }] : [])] } });
  assert.notEqual((await call("GET", `/runs/${run.run_id}`)).status, "completed", "Async artifact checks must finish before publishing the terminal status");
  assert.equal((await call("GET", `/runs/${run.run_id}/result`)).result, null);
  let observedTerminal = false;
  for (let i = 0; i < 200; i += 1) {
    if ((await call("GET", `/runs/${run.run_id}`)).status === "completed") {
      const delivered = await call("GET", `/runs/${run.run_id}/result`);
      assert.equal(delivered.artifacts.length, 3, "The first observable completed state must already contain the file artifacts");
      assert.equal((await call("GET", `/runs/${run.run_id}/artifacts`)).artifacts.length, 3);
      observedTerminal = true; break;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(observedTerminal, true);
  await completing;
  const result = await call("GET", `/runs/${run.run_id}/result`);
  assert.equal(result.result.content, "Done"); assert.equal(result.status, "completed");
  assert.deepEqual(result.result.result_storage, { version: 1, truncated: true, redacted: true, max_bytes: 2097152 });
  assert.equal(result.result.truncated, true, "API clients must be told when persisted delivery content was truncated or redacted");
  assert.deepEqual(result.result.self_check, { completed: true, verified: false });
  assert.deepEqual(result.result.cumulative_usage, { total_tokens: 35 });
  assert.equal(result.result.usage_history_complete, false);
  assert.deepEqual(result.result.acceptance, { status: "partial" });
  assert.deepEqual(result.result.error_details, { code: "EXAMPLE" });
  assert.equal(result.artifacts.length, 3, "Only virtual outputs and declared in-root files are readable");
  const file = result.artifacts.find(artifact => artifact.name === "answer.md");
  const page = await call("GET", `/runs/${run.run_id}/artifacts/${file.id}`, {}, { offset: "0", limit: "3" });
  assert.equal(Buffer.from(page.content, "base64").toString(), "你");
  assert.equal(page.next_offset, 3); assert.equal(page.has_more, true);
  await expectCode(() => call("GET", `/runs/${run.run_id}/artifacts/${file.id}`, {}, {}, other), "run_not_found");
  await writeFile(reportPath, "changed file");
  await expectCode(() => call("GET", `/runs/${run.run_id}/artifacts/${file.id}`), "artifact_changed");
  const cancellingRun = await call("POST", "/runs", { ...input, idempotency_key: "cancel-during-delivery" }); await settle();
  const finishingCancelled = callbacks.get(cancellingRun.run_id).onResult({ runId: cancellingRun.run_id,
    result: { status: "completed", content: "Preserved result", artifacts: [{ path: reportPath }] } });
  await call("POST", `/runs/${cancellingRun.run_id}/cancel`);
  await finishingCancelled;
  const cancelledDelivery = await call("GET", `/runs/${cancellingRun.run_id}/result`);
  assert.equal(cancelledDelivery.status, "cancelled", "Cancellation during artifact collection must not be overwritten by completion");
  assert.equal(cancelledDelivery.result.status, "cancelled");
  const cancelledJson = await call("GET", `/runs/${cancellingRun.run_id}/artifacts/${cancellingRun.run_id}_result`);
  assert.equal(JSON.parse(Buffer.from(cancelledJson.content, "base64").toString()).status, "cancelled", "The virtual result and durable final result must commit the same status");
  const revokedRun = await call("POST", "/runs", { ...input, idempotency_key: "revoked-active" }); await settle();
  await service.admin("revokeClient", { clientId: first.client.id });
  assert.throws(() => service.authenticate(first.token), /invalid or revoked/);
  assert.equal(controls.some(item => item[0] === "cancel" && item[1] === revokedRun.run_id), true);
  await assert.rejects(readFile(first.connectionFile), /ENOENT/);
  await service.shutdown(); service = null;

  // Simulate an unclean exit with a committed queued task. Startup must not auto-replay it.
  const store = await createControlStore(join(directory, "local-control"));
  const crashRun = { runId: "run_crash_pending", taskId: "task_crash", clientId: second.client.id, clientName: "Other harness", workspaceId: ws.id,
    workspacePath: workspace, executionWorkspacePath: workspace, profile: "review", instruction: "Do not replay",
    status: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), limits: (await Promise.resolve(second.client)).limits };
  store.insertRun(crashRun, "crash", "hash"); store.close();
  const beforeRestart = starts.length;
  service = await createLocalControlService(options); await settle();
  assert.equal(starts.length, beforeRestart);
  assert.equal((await service.admin("getRun", { runId: crashRun.runId })).status, "interrupted");
  assert.equal((await service.admin("getResult", { runId: run.run_id })).result.content, "Done");
  await service.shutdown(); service = null;

  // Real detached Runtime callbacks may arrive after the desktop control store has closed.
  const delayedDirectory = join(directory, "delayed-runtime");
  const delayedRuntime = createHarnessTaskRuntime({ dataDirectory: delayedDirectory });
  let releaseExecution, markExecuting;
  const release = new Promise(resolve => { releaseExecution = resolve; });
  const executing = new Promise(resolve => { markExecuting = resolve; });
  const unhandled = [];
  const captureUnhandled = error => unhandled.push(error);
  process.on("unhandledRejection", captureUnhandled);
  try {
    service = await createLocalControlService({ dataDirectory: delayedDirectory, taskRuntime: delayedRuntime,
      listProviders: () => [{ id: "local", models: ["model-1"] }],
      startRun: (request, context) => delayedRuntime.start({ runId: request.runId, taskId: request.taskId, clientId: context.clientId,
        metadata: { workspacePath: workspace }, onEvent: context.onEvent, onResult: context.onResult, detached: true,
        execute: async ({ emit }) => { markExecuting(); await release; emit({ type: "response.delta", delta: "late event" }); return { status: "completed", content: "late result" }; },
      }),
    });
    const lateWorkspace = await service.admin("registerWorkspace", { path: workspace });
    const lateClient = await service.admin("createClient", { ...grant, workspaceIds: [lateWorkspace.id] });
    await service.admin("setEnabled", { enabled: true });
    await service.dispatch(service.authenticate(lateClient.token), "POST", "/control/v1/runs", {}, { ...input, workspace_id: lateWorkspace.id, idempotency_key: "late-finish" });
    await executing;
    await service.shutdown(); service = null;
    releaseExecution();
    for (let i = 0; i < 200 && delayedRuntime.hasActiveRuns(); i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    await settle();
    assert.equal(delayedRuntime.hasActiveRuns(), false);
    assert.deepEqual(unhandled, [], "Late callbacks after shutdown must not reject or access a closed control database");
  } finally {
    releaseExecution(); process.removeListener("unhandledRejection", captureUnhandled); await closeRunJournalStore(delayedDirectory);
  }
  console.log("PASS local control service: grants, concurrency, durable retries/events/results, human approval, artifacts, revocation, restart");
} catch (error) {
  // Preserve the primary failure even if Windows cannot remove an open DB.
  console.error(error);
  throw error;
} finally {
  await service?.shutdown();
  await rm(directory, { recursive: true, force: true });
}
