import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { HarnessScheduler } from "../electron/harness/scheduler.js";
import { contentHash, recordVerification, refreshVerification, verificationVersion, readEvidenceCovers, NoProgressGuard } from "../electron/runtime/evidence-ledger.js";
import { callModelProvider } from "../electron/runtime/provider-stream.js";
import { executeDurableTool, saveRuntimeCheckpoint, withDurableRun } from "../electron/runtime/durable-run.js";
import { createHarnessTaskRuntime } from "../electron/harness/task-runtime.js";
import { beginRunJournal, closeRunJournalStore, getRunRecoveryContext, listRecoverableRuns, saveRunCheckpoint, saveRunOperation } from "../electron/run-store.js";

const change = { path: "a.js", beforeContent: "old\n", afterContent: "new\n" };
const changes = new Map([[change.path, change]]);
const state = { verificationCandidates: [{ command: "npm run test", cwd: "." }, { command: "npm run lint", cwd: "." }], verificationResults: [] };
state.verificationRequired = state.verificationCandidates;
recordVerification(state, changes, { command: "npm test", passed: true });
assert.equal(state.verificationPassed, false, "missing required check cannot pass");
recordVerification(state, changes, { command: "npm run lint", passed: true });
assert.equal(state.verificationPassed, true, "command aliases normalize");
recordVerification(state, changes, { command: "npm test", passed: false });
assert.equal(state.verificationPassed, false, "a later failure supersedes success");
recordVerification(state, changes, { command: "npm test", passed: true });
assert.equal(state.verificationPassed, true, "latest successful rerun supersedes failure");
const version = verificationVersion(changes);
change.afterContent = "newer\n";
refreshVerification(state, changes);
assert.equal(state.verificationPassed, false, "a new file version invalidates verification");
assert.equal(state.verificationAttempted, false);
recordVerification(state, changes, { command: "npm test", passed: true }, version);
assert.equal(state.verificationAttempted, false, "a delayed result is not current evidence");
change.afterContent = "";
const emptyVersion = verificationVersion(changes);
change.afterMissing = true;
assert.notEqual(emptyVersion, verificationVersion(changes), "deleted and empty files differ");

const created = { path: "large.js", beforeContent: "", afterContent: "line one\nline two\n" };
const read = (start, end, hash = contentHash(created.afterContent)) => ({ tool: "read_file", path: created.path, sha256: hash, readRange: { start, end } });
assert.equal(readEvidenceCovers(created, [read(0, 9)]), false);
assert.equal(readEvidenceCovers(created, [read(0, 9), read(9, created.afterContent.length)]), true);
assert.equal(readEvidenceCovers(created, [read(0, 100, "old")]), false);
assert.equal(readEvidenceCovers(created, [{ tool: "read_file", path: created.path }]), false);
const interior = { path: "mid.js", beforeContent: "untouched\nbefore\nold\nafter\nend\n", afterContent: "untouched\nbefore\nnew\nafter\nend\n" };
assert.equal(readEvidenceCovers(interior, [{ tool: "read_file", path: interior.path, sha256: contentHash(interior.afterContent), readRange: { start: 10, end: 27 } }]), true, "modified region and context suffice");
const guard = new NoProgressGuard();
guard.observe("same"); guard.observe("same");
assert.throws(() => guard.observe("same"), /VERIFICATION_BLOCKED/);
guard.observe("new-version");

const originalFetch = globalThis.fetch;
const provider = { id: "test", name: "test", vendor: "openai", baseUrl: "https://unused.invalid/v1" };
const event = (choice) => "data: " + JSON.stringify({ choices: [choice] }) + "\n\n";
try {
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response(event({ delta: { content: "partial" } })); };
  await assert.rejects(() => callModelProvider({ provider, body: {} }), /PROVIDER_STREAM_INCOMPLETE/);
  assert.equal(requests, 1, "do not silently retry a paid partial response");
  globalThis.fetch = async () => new Response(event({ delta: { content: "truncated" }, finish_reason: "length" }) + "data: [DONE]\n");
  await assert.rejects(() => callModelProvider({ provider, body: {} }), /PROVIDER_FINISH_LENGTH/);
  globalThis.fetch = async () => new Response(event({ delta: { tool_calls: [{ index: 0, id: "t", function: { name: "run_command", arguments: '{"command":' } }] }, finish_reason: "tool_calls" }));
  await assert.rejects(() => callModelProvider({ provider, body: {} }), /PROVIDER_TOOL_CALL_INCOMPLETE/);
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}');
  const complete = await callModelProvider({ provider, body: {} });
  assert.equal(complete.message.content, "ok");
  assert.equal(complete.streamComplete, true, "final event without trailing newline is parsed");
} finally { globalThis.fetch = originalFetch; }

let executed = 0;
await assert.rejects(() => withDurableRun({ operation: async () => { throw new Error("disk full"); } }, () =>
  executeDurableTool("run_command", {}, async () => { executed++; })), /disk full/);
assert.equal(executed, 0, "no effect before durable intent");
const states = [];
await assert.rejects(() => withDurableRun({ operation: async (op) => { states.push(op.state); } }, () =>
  executeDurableTool("mcp_publish", {}, async () => { throw new Error("connection lost after send"); })), /connection lost/);
assert.deepEqual(states, ["started", "uncertain"]);
await assert.rejects(() => withDurableRun({ unresolved: [{ tool: "mcp_publish" }] }, () =>
  executeDurableTool("mcp_publish", {}, async () => { executed++; }, async () => ({ approved: false }))), /RECOVERY_RECONCILIATION_REQUIRED/);
assert.equal(executed, 0);

const root = await mkdtemp(join(tmpdir(), "aporiax-p1-"));
try {
  await beginRunJournal(root, { runId: "crashed", taskId: "task", prompt: "resume me" });
  await saveRunCheckpoint(root, "crashed", { scopeId: "crashed", plan: { steps: [{ id: "one", status: "completed" }] } });
  await saveRunCheckpoint(root, "crashed", { scopeId: "builder", status: "running" });
  await saveRunOperation(root, "crashed", { operationId: "uncertain-call", tool: "mcp_publish", state: "started", fingerprint: "hash" });
  await closeRunJournalStore(root); // reopen as a fresh process would
  const recovered = await getRunRecoveryContext(root, "crashed");
  assert.equal(recovered.checkpoint.main.plan.steps[0].status, "completed");
  assert.equal(recovered.checkpoint.agents.builder.status, "running");
  assert.equal(recovered.unresolvedOperations[0].operationId, "uncertain-call");
  assert((await listRecoverableRuns(root)).some((run) => run.runId === "crashed"));

  const runtime = createHarnessTaskRuntime({ dataDirectory: root });
  const observed = [];
  const storageFailure = await runtime.start({
    runId: "disk-failure", onEvent: (e) => observed.push(e),
    execute: async () => {
      const db = new DatabaseSync(join(root, "aporiax-runs.sqlite3"));
      db.exec("CREATE TRIGGER fail_operation BEFORE INSERT ON run_operations BEGIN SELECT RAISE(FAIL, 'simulated full disk'); END;");
      db.close();
      return executeDurableTool("write_file", {}, async () => { executed++; });
    },
  });
  assert.equal(storageFailure.status, "blocked");
  assert.match(storageFailure.content, /RUN_PERSISTENCE_FAILED/);
  assert.equal(storageFailure.persistence.failed, true);
  assert.equal(executed, 0);
  assert(observed.some((e) => e.type === "run.persistence_failed"));
  const db = new DatabaseSync(join(root, "aporiax-runs.sqlite3"));
  db.exec("DROP TRIGGER fail_operation"); db.close();
  const result = await runtime.start({
    runId: "new-run", execute: async () => {
      await saveRuntimeCheckpoint({ scopeId: "new-run", phase: "work" });
      await executeDurableTool("write_file", { path: "a.js" }, async () => ({ modelResult: { path: "a.js" } }));
      return { status: "completed", changes: [] };
    },
  });
  assert.equal(result.status, "completed");
  const confirmedContext = await getRunRecoveryContext(root, "new-run");
  assert.equal(confirmedContext.unresolvedOperations.length, 0);
  assert.equal(confirmedContext.operations[0].state, "confirmed");
  let recoveryApprovals = 0;
  await assert.rejects(() => runtime.start({
    runId: "replay", recoveryContext: confirmedContext,
    onEvent: (e) => {
      if (e.type === "approval.required") {
        recoveryApprovals++;
        assert.equal(e.approval.canRememberForRun, false);
        runtime.respondApproval("replay", e.approval.id, { approved: false });
      }
    },
    execute: ({ requestApproval }) => executeDurableTool("write_file", { path: "a.js" }, async () => { executed++; }, requestApproval),
  }), /RECOVERY_RECONCILIATION_REQUIRED/);
  assert.equal(recoveryApprovals, 1, "confirmed duplicate requires explicit approval");
  assert.equal(executed, 0);
  const replay = await getRunRecoveryContext(root, "replay");
  assert.equal(replay.checkpoint.main.phase, "work", "recovery copies the last main checkpoint before proceeding");
  assert(Object.values(replay.checkpoint.agents).some((item) => item.phase === "approval-resolved" && item.approved === false));

  const scheduler = new HarnessScheduler({ concurrency: 1 });
  let release;
  const gate = new Promise((done) => { release = done; });
  const scopes = [];
  const queuedA = withDurableRun({ checkpoint: async () => scopes.push("A") }, () => scheduler.enqueue({
    run: async () => { await gate; await saveRuntimeCheckpoint({}); },
  }));
  const queuedB = withDurableRun({ checkpoint: async () => scopes.push("B") }, () => scheduler.enqueue({
    run: () => saveRuntimeCheckpoint({}),
  }));
  release();
  await Promise.all([queuedA.promise, queuedB.promise]);
  assert.deepEqual(scopes, ["A", "B"], "queued jobs retain their own persistence context");

  await closeRunJournalStore(root);
  const storeUrl = new URL("../electron/run-store.js", import.meta.url).href;
  const crashCode = [
    "import { beginRunJournal, saveRunCheckpoint, saveRunOperation } from " + JSON.stringify(storeUrl) + ";",
    "const root = " + JSON.stringify(root) + ";",
    "await beginRunJournal(root, { runId: 'abrupt', taskId: 'crash-test' });",
    "await saveRunCheckpoint(root, 'abrupt', { scopeId: 'abrupt', phase: 'tools', plan: { done: ['step-one'] } });",
    "await saveRunOperation(root, 'abrupt', { operationId: 'abrupt-op', tool: 'mcp_publish', state: 'started' });",
    "process.kill(process.pid, 'SIGKILL');",
  ].join("\n");
  const crashed = spawnSync(process.execPath, ["--experimental-sqlite", "--input-type=module", "-e", crashCode], { windowsHide: true, timeout: 15000, encoding: "utf8" });
  assert.ifError(crashed.error);
  assert.notEqual(crashed.status, 0);
  const afterCrash = await getRunRecoveryContext(root, "abrupt");
  assert.deepEqual(afterCrash.checkpoint.main.plan.done, ["step-one"]);
  assert.equal(afterCrash.unresolvedOperations[0].operationId, "abrupt-op");
} finally {
  await closeRunJournalStore(root);
  const rel = relative(resolve(tmpdir()), resolve(root));
  assert(rel && !rel.startsWith("..") && rel.startsWith("aporiax-p1-"));
  await rm(root, { recursive: true, force: true });
}
console.log("priority one runtime smoke: PASS");
