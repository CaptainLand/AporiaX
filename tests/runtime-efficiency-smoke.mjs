import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compactConversationForRequest, estimateConversationTokens } from "../electron/agent-context-core.js";
import { captureWorkspaceState } from "../electron/agent-runtime-core.js";
import { normalizeBuilderOrchestrationPlan } from "../electron/agent-runtime.js";
import { createSelfCheckCoordinator } from "../electron/runtime/self-check-coordinator.js";
import { contentHash, recordVerification } from "../electron/runtime/evidence-ledger.js";
import { ToolProgressGuard } from "../electron/runtime/tool-progress-guard.js";
import { HarnessScheduler } from "../electron/harness/scheduler.js";
import { normalizeSubagentInput } from "../electron/runtime/subagent-model.js";
import { createHarnessTaskRuntime } from "../electron/harness/task-runtime.js";
import { saveRuntimeCheckpoint, executeDurableTool } from "../electron/runtime/durable-run.js";
import { getRunRecoveryContext, closeRunJournalStore, appendRunJournalEvents } from "../electron/run-store.js";

const conversation = [{ role: "system", content: "Do not delete user files." }];
const contextCheckpoints = [];
for (let pass = 0; pass < 12; pass++) {
  for (let i = 0; i < 24; i++) conversation.push({ role: i % 2 ? "assistant" : "user", content: `${pass}-${i} ` + "中".repeat(3000) });
  const latest = conversation.findLast((message) => message.role === "user").content;
  compactConversationForRequest({ conversation, contextCheckpoints, contextWindowTokens: 32000 });
  assert.ok(estimateConversationTokens(conversation) <= 20000, "compaction must satisfy its budget");
  assert.equal(conversation.filter((m) => m.content?.startsWith("AporiaX durable context checkpoint:")).length, 1);
  assert.equal(conversation.findLast((m) => m.role === "user").content, latest);
  assert.equal(conversation[0].content, "Do not delete user files.");
}
assert.ok(contextCheckpoints.length <= 8);
const paired = [{ role: "system", content: "instructions" }, { role: "user", content: "keep this exact request" }];
for (let i = 0; i < 30; i++) paired.push(
  { role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: '{"path":"large.js"}' } }] },
  { role: "tool", tool_call_id: `c${i}`, content: JSON.stringify({ path: "large.js", content: "中".repeat(6000) }) },
);
compactConversationForRequest({ conversation: paired, contextCheckpoints: [], contextWindowTokens: 32000 });
const callIds = paired.flatMap((m) => (m.tool_calls || []).map((c) => c.id));
assert.deepEqual(paired.filter((m) => m.role === "tool").map((m) => m.tool_call_id), callIds);
assert.ok(paired.some((m) => m.content === "keep this exact request"));
assert.ok(estimateConversationTokens(paired) <= 20000);
const huge = [{ role: "system", content: "instructions" }, { role: "user", content: "中".repeat(50000) }];
const beforeHuge = JSON.stringify(huge);
assert.throws(() => compactConversationForRequest({ conversation: huge, contextCheckpoints: [], contextWindowTokens: 32000 }), /CONTEXT_BUDGET_EXCEEDED/);
assert.equal(JSON.stringify(huge), beforeHuge, "never partially corrupt a request on compaction failure");

const guard = new ToolProgressGuard();
const observation = { tool: "search_text", input: { query: "same" }, result: { matches: [] }, version: "v1" };
for (let i = 1; i <= 5; i++) assert.equal(Boolean(guard.observe(observation)), i === 3);
assert.match(guard.observe(observation), /Change strategy/);
assert.equal(guard.observe({ ...observation, version: "v2" }), null);
guard.reset();
for (let i = 0; i < 100; i++) assert.equal(guard.observe({ ...observation, tool: "read_process" }), null, "legitimate managed process polling is not repeated evidence work");
assert.equal(normalizeSubagentInput({ role: "explore", task: "optional", background: true, required_for_completion: false }).requiredForCompletion, false);
assert.equal(normalizeSubagentInput({ role: "verify", task: "required", background: true, required_for_completion: false }).requiredForCompletion, true);

const selectedCheck = [{ command: "npm test", cwd: "." }];
const changes = new Map([["a.js", { path: "a.js", beforeContent: "one", afterContent: "two", beforeMissing: false, afterMissing: false, binary: false }]]);
const state = { reviewedVersions: new Map(), segments: [], segmentCounter: 0, verificationCandidates: [...selectedCheck, { command: "npm run build", cwd: "." }], verificationRequired: selectedCheck, verificationResults: [] };
let commands = 0;
let reviews = 0;
let fail = false;
let changeDuringVerification = false;
const coordinator = createSelfCheckCoordinator({ selfCheck: state, changeMap: changes, commandToolAvailable: true,
  discoverVerificationCommands: async () => state.verificationCandidates,
  executeVerification: async () => { commands++; if (changeDuringVerification) changes.get("a.js").afterContent += " changed"; return { exitCode: fail ? 1 : 0, error: fail ? "test failed" : null }; },
  startSubagent: async (input) => {
    assert.equal(input.role, "review", "Verify must never invoke a model"); reviews++;
    const text = changes.get("a.js").afterContent;
    return { status: "completed", summary: JSON.stringify({ verdict: "pass", findings: [], checks: [], remaining_risks: [] }),
      evidence: [{ tool: "read_file", path: "a.js", sha256: contentHash(text), readRange: { start: 0, end: text.length } }] };
  },
});
assert.equal((await coordinator.runSegment({ reason: "first", runVerification: true })).verdict, "pass");
assert.equal(commands, 1, "discovered checks are suggestions, not a request to run every script");
assert.equal(await coordinator.runSegment({ reason: "unchanged", runVerification: true }), null);
assert.equal(commands, 1); assert.equal(reviews, 1);
recordVerification(state, changes, { command: "npm test", cwd: ".", passed: false, exitCode: 1 });
fail = true;
assert.equal((await coordinator.runSegment({ reason: "latest-failure", runVerification: true })).verdict, "needs_changes");
assert.equal(await coordinator.seal(), null);
fail = false;
changes.get("a.js").afterContent = "three";
assert.equal((await coordinator.runSegment({ reason: "new-version", runVerification: true })).verdict, "pass");
changes.get("a.js").afterContent = "four";
changeDuringVerification = true;
assert.equal((await coordinator.runSegment({ reason: "racing-write", runVerification: true })).verdict, "uncertain");
assert.equal(await coordinator.seal(), null);

const mainPlan = { parallelize: true, contract: { invariants: [{ key: "v", value: "2" }], sharedFiles: ["shared.js"] },
  tasks: [{ id: "a", task: "implement a", writeScopes: ["a"], approvedPlan: { approach: "small change" } }],
  mainTask: { task: "implement shared contract independently", writeScopes: ["shared.js"] } };
assert.equal(normalizeBuilderOrchestrationPlan(mainPlan).tasks.at(-1).executionRole, "main");
assert.equal(normalizeBuilderOrchestrationPlan({ ...mainPlan, mainTask: { ...mainPlan.mainTask, writeScopes: ["."] } }).tasks.length, 1);
assert.equal(normalizeBuilderOrchestrationPlan({ ...mainPlan, mainTask: { ...mainPlan.mainTask, writeScopes: ["a"] } }).tasks.length, 1);
const scheduler = new HarnessScheduler({ concurrency: 1 });
let release;
const first = scheduler.enqueue({ run: () => new Promise((resolve) => { release = resolve; }) });
await Promise.resolve();
const controller = new AbortController();
let ran = false;
const second = scheduler.enqueue({ signal: controller.signal, run: () => { ran = true; } });
const rejected = assert.rejects(second.promise, { name: "AbortError" });
controller.abort(); await rejected; release(); await first.promise;
assert.equal(ran, false); assert.equal(scheduler.snapshot().queued.length, 0);

const root = await mkdtemp(join(tmpdir(), "aporia-efficiency-"));
const directory = join(root, "journal");
try {
  await writeFile(join(root, "a.txt"), "before");
  await writeFile(join(root, "b.txt"), "stable");
  const baseline = await captureWorkspaceState(root);
  const cached = await captureWorkspaceState(root, { previousSnapshot: baseline });
  assert.equal(cached.filesRead, 0); assert.equal(cached.reusedFiles, 2);
  await writeFile(join(root, "a.txt"), "after changed");
  const changed = await captureWorkspaceState(root, { previousSnapshot: cached });
  assert.equal(changed.filesRead, 1); assert.equal(changed.reusedFiles, 1);
  assert.equal(baseline.files.get("a.txt").content, "before", "cache must not mutate the rollback baseline");
  assert.equal((await captureWorkspaceState(root, { previousSnapshot: changed, forceRead: true })).filesRead, 2);
  const runtime = createHarnessTaskRuntime({ dataDirectory: directory });
  const visible = [];
  await runtime.start({ runId: "batch-test", onEvent: (event) => visible.push(event), execute: async ({ emit }) => {
    for (let i = 0; i < 40; i++) emit({ type: "response.delta", delta: String(i) });
    assert.equal(visible.length, 40, "UI events must not wait for batching");
    await saveRuntimeCheckpoint({ scopeId: "batch-test", phase: "before-model" });
    const recovery = await getRunRecoveryContext(directory, "batch-test");
    assert.equal(recovery.events.filter((event) => event.type === "response.delta").length, 40, "checkpoint flushes all earlier output");
    emit({ type: "response.delta", delta: "last" });
    await executeDurableTool("write_file", { path: "x.txt" }, async () => {
      const current = await getRunRecoveryContext(directory, "batch-test");
      // Recovery exposes a compact event index, not raw streaming text. Inspect
      // the durable payload itself to verify the flush before an actual effect.
      const reader = new DatabaseSync(join(directory, "aporiax-runs.sqlite3"), { readOnly: true });
      try {
        const row = reader.prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'response.delta' ORDER BY sequence DESC LIMIT 1").get("batch-test");
        assert.equal(JSON.parse(row.payload_json).delta, "last", "effect intent flushes earlier stream text");
      } finally { reader.close(); }
      assert.ok(current.unresolvedOperations.some((item) => item.tool === "write_file"), "intent precedes the effect");
      return { modelResult: { path: "x.txt" } };
    });
    return { status: "completed", content: "done", changes: [] };
  } });
  const circular = { type: "bad" }; circular.self = circular;
  await assert.rejects(appendRunJournalEvents(directory, "batch-test", [{ type: "must-rollback" }, circular]));
  const final = await getRunRecoveryContext(directory, "batch-test");
  assert.equal(final.events.some((event) => event.type === "must-rollback"), false, "a failed batch is atomic");
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "after changed");
} finally {
  await closeRunJournalStore(directory);
  await rm(root, { recursive: true, force: true });
}
console.log("Runtime efficiency: bounded context, deterministic/reused Verify, no-progress, scoped Main, queue cancellation, snapshot cache, durable journal batches: PASS");
