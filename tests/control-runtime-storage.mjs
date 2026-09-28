import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessTaskRuntime } from "../electron/harness/task-runtime.js";
import {
  appendRunJournalEvents, beginRunJournal, closeRunJournalStore, finishRunJournal,
  getRunRecoveryContext, listRunRecords, readRunEvents, readRunResult,
  RUN_RESULT_MAX_BYTES, sanitizeRunResult,
} from "../electron/run-store.js";

const directory = await mkdtemp(join(tmpdir(), "aporiax-control-storage-"));
const eventually = async (predicate) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for task lifecycle.");
};

try {
  const runtime = createHarnessTaskRuntime({ dataDirectory: directory });
  const finished = [];
  const unsubscribe = runtime.subscribeRunFinished(notification => finished.push(notification));
  let callback = null;
  const result = {
    status: "completed", content: "完整结果：检查已完成。", changes: [{ path: "src/main.js", additions: 2 }],
    steps: [{ name: "verify", success: true }], usage: { inputTokens: 42, outputTokens: 18 },
    artifacts: [{ id: "report", path: "reports/result.md", mediaType: "text/markdown" }],
    selfCheck: { status: "passed" }, error: false,
  };
  await runtime.start({ runId: "completed", taskId: "task-completed", clientId: "external:fixture", metadata: { workspacePath: "/fixture" },
    onResult: notification => { callback = notification; }, execute: async () => result });
  assert.equal(callback.clientId, "external:fixture");
  assert.equal(finished.length, 1);
  assert.deepEqual(callback.result, result);
  unsubscribe();
  await closeRunJournalStore(directory);
  assert.deepEqual(await readRunResult(directory, "completed"), result);
  assert.deepEqual(await runtime.getRunResult("completed"), result);
  assert.equal((await getRunRecoveryContext(directory, "completed")).status, "completed");
  assert.equal(await readRunResult(directory, "missing"), null);
  await finishRunJournal(directory, "completed", { status: "failed", content: "late duplicate" });
  assert.deepEqual(await readRunResult(directory, "completed"), result, "a duplicate finish cannot replace the accepted result");
  assert.equal((await readRunEvents(directory, "completed")).events.filter(event => event.type === "run.finished").length, 1);

  let getterCalled = false;
  const cyclic = { safe: "preserved", credentials: { apiKey: "DO_NOT_STORE" }, api_key: "DO_NOT_STORE", token: "DO_NOT_STORE",
    headers: { Authorization: "Bearer do-not-store-this-token", Cookie: "session=do-not-store" } };
  cyclic.self = cyclic;
  Object.defineProperty(cyclic, "dangerous", { enumerable: true, get() { getterCalled = true; throw new Error("getter ran"); } });
  await beginRunJournal(directory, { runId: "bounded", taskId: "big", workspacePath: "/fixture" });
  await finishRunJournal(directory, "bounded", { status: "partial", usage: { totalTokens: 7 }, artifacts: [{ id: "a", path: "output.md" }],
    content: "中\u0000😀".repeat(700_000), safe: cyclic, changes: Array.from({ length: 12_000 }, (_, index) => ({ path: `src/${index}.js`, detail: "change".repeat(80) })) });
  const bounded = await readRunResult(directory, "bounded");
  assert(Buffer.byteLength(JSON.stringify(bounded)) <= RUN_RESULT_MAX_BYTES);
  assert.equal(bounded.status, "partial");
  assert.equal(bounded.usage.totalTokens, 7);
  assert.equal(bounded.artifacts[0].id, "a");
  assert.equal(bounded.resultStorage.truncated, true);
  const safe = sanitizeRunResult({ status: "failed", usage: { input_tokens: 7 }, detail: cyclic,
    content: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz and api_key=private_value" });
  assert.equal(getterCalled, false);
  assert.equal(safe.detail.safe, "preserved");
  assert.equal(safe.detail.self, "[Circular]");
  assert.equal(safe.detail.api_key, "[REDACTED]");
  assert.equal(safe.usage.input_tokens, 7);
  assert.equal(safe.resultStorage.redacted, true);
  assert(!JSON.stringify(safe).includes("DO_NOT_STORE"));
  assert(!JSON.stringify(safe).includes("private_value"));
  assert(!JSON.stringify(safe).includes("abcdefghijklmnopqrstuvwxyz"));

  await beginRunJournal(directory, { runId: "events-a", taskId: "events" });
  await beginRunJournal(directory, { runId: "events-b", taskId: "other" });
  for (let group = 0; group < 25; group += 1) {
    await appendRunJournalEvents(directory, "events-a", Array.from({ length: 100 }, (_, index) => ({
      type: "response.delta", index: group * 100 + index, delta: "event", runId: "spoofed", sequence: -1,
    })));
    await appendRunJournalEvents(directory, "events-b", [{ type: "other.event", index: group }]);
  }
  await closeRunJournalStore(directory);
  const collected = [];
  let afterSequence = 0;
  while (true) {
    const page = await runtime.readEvents("events-a", { afterSequence, limit: 73 });
    assert(page.events.length <= 73);
    for (const event of page.events) {
      assert.equal(event.runId, "events-a", "payloads cannot spoof the authoritative run id");
      assert(event.sequence > afterSequence);
      afterSequence = event.sequence;
      collected.push(event);
    }
    assert.equal(page.nextSequence, afterSequence);
    if (!page.hasMore) break;
  }
  assert.equal(collected.length, 2501, "all events survive the former 2000-event memory window");
  assert.deepEqual(collected.slice(1).map(event => event.index), Array.from({ length: 2500 }, (_, index) => index));
  const offsetPage = await readRunEvents(directory, "events-a", { limit: 4, offset: 7 });
  assert.deepEqual(offsetPage.events.map(event => event.sequence), collected.slice(7, 11).map(event => event.sequence));
  const capped = await readRunEvents(directory, "events-a", { limit: 50_000 });
  assert.equal(capped.events.length, 1000);
  assert.equal(capped.hasMore, true);
  assert.deepEqual((await readRunEvents(directory, "missing")).events, []);
  await assert.rejects(readRunEvents(directory, "events-a", { afterSequence: -1 }), /pagination/);
  await assert.rejects(readRunEvents(directory, "events-a", { limit: NaN }), /pagination/);
  assert.deepEqual((await listRunRecords(directory, { taskId: "events" })).map(run => run.runId), ["events-a"]);
  assert.equal((await runtime.listRuns({ workspacePath: "/fixture", status: ["completed", "partial"] })).length, 2);
  assert.deepEqual(await runtime.listRuns({ runIds: [] }), []);

  let ranCancelled = false;
  const unsubscribeStarting = runtime.subscribeActiveRuns(runs => {
    if (runs.some(run => run.runId === "cancel-starting" && run.phase === "preparing")) {
      assert.equal(runtime.interrupt("cancel-starting", { clientId: "external:stranger" }), false);
      assert.equal(runtime.interrupt("cancel-starting", { clientId: "external:owner" }), true);
      assert.equal(runtime.interrupt("cancel-starting", { clientId: "external:owner" }), true);
    }
  });
  await assert.rejects(runtime.start({ runId: "cancel-starting", clientId: "external:owner",
    execute: async () => { ranCancelled = true; return { status: "completed" }; } }), { name: "AbortError" });
  unsubscribeStarting();
  assert.equal(ranCancelled, false);
  assert.equal((await runtime.getRunResult("cancel-starting")).status, "interrupted");

  let ranPaused = false, steering = null;
  const unsubscribePaused = runtime.subscribeActiveRuns(runs => {
    if (runs.some(run => run.runId === "pause-starting" && run.phase === "preparing")) {
      void runtime.pause("pause-starting", { clientId: "external:owner" });
      runtime.steer("pause-starting", { content: "A queued constraint." }, { clientId: "external:owner" });
    }
  });
  await runtime.start({ runId: "pause-starting", clientId: "external:owner", detached: true,
    execute: async ({ control }) => { ranPaused = true; steering = control.consumeSteering(); return { status: "completed", content: "resumed" }; } });
  unsubscribePaused();
  assert.equal(runtime.getActiveRun("pause-starting").paused, true);
  assert.equal(ranPaused, false);
  assert.equal(await runtime.pause("pause-starting", { clientId: "external:stranger" }), false);
  assert.equal(await runtime.resume("pause-starting", { clientId: "external:owner" }), true);
  await eventually(() => !runtime.getActiveRun("pause-starting"));
  assert.equal(ranPaused, true);
  assert.equal(steering[0].content, "A queued constraint.");
  assert((await runtime.readEvents("pause-starting")).events.some(event => event.type === "control.paused"));
  assert.equal((await runtime.getRunResult("pause-starting")).content, "resumed");

  await assert.rejects(runtime.start({ runId: "exception", execute: async () => {
    throw Object.assign(new Error("Transport failed: Bearer abcdefghijklmnopqrstuvwxyz"), { code: "FIXTURE_FAILURE" });
  } }), /Transport failed/);
  const failed = await runtime.getRunResult("exception");
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorDetails.code, "FIXTURE_FAILURE");
  assert(failed.content.includes("[REDACTED]"));
  assert.equal(runtime.hasActiveRuns(), false);

  const approvalEvents = [];
  let firstApproval, secondApproval;
  const approvalRun = runtime.start({ runId: "approval-events", clientId: "external:owner", onEvent: event => {
    approvalEvents.push(event);
    if (event.type === "approval.required") {
      if (!firstApproval) firstApproval = event.approval.id; else secondApproval = event.approval.id;
    }
  }, execute: async ({ requestApproval }) => {
    const decisions = await Promise.all([requestApproval({ tool: "fixture-one" }), requestApproval({ tool: "fixture-two" })]);
    return { status: "completed", decisions };
  } });
  await eventually(() => Boolean(firstApproval && secondApproval));
  assert.equal(runtime.respondApproval("approval-events", firstApproval, { approved: true, scope: "once", clientId: "other" }), false);
  assert.equal(runtime.respondApproval("approval-events", firstApproval, { approved: true, scope: "once", clientId: "external:owner" }), true);
  assert.equal(runtime.respondApproval("approval-events", firstApproval, { approved: true, scope: "once", clientId: "external:owner" }), false);
  await eventually(() => approvalEvents.some(event => event.type === "approval.resolved"));
  assert.equal(runtime.getPendingApprovals("approval-events").length, 1);
  const approvedEvent = approvalEvents.find(event => event.type === "approval.resolved");
  assert.deepEqual(approvedEvent.approval, { id: firstApproval, approved: true, scope: "once" });
  assert.equal(runtime.respondApproval("approval-events", secondApproval, { approved: false, scope: "once", clientId: "external:owner" }), true);
  const decisions = (await approvalRun).decisions;
  assert.deepEqual(decisions.map(decision => decision.approved), [true, false]);
  const resolved = (await runtime.readEvents("approval-events")).events.filter(event => event.type === "approval.resolved");
  assert.equal(resolved.length, 2, "each accepted approval emits exactly one durable resolution event");
  assert.deepEqual(resolved.map(event => [event.approval.id, event.approved, event.scope]), [[firstApproval, true, "once"], [secondApproval, false, "once"]]);

  console.log("Control runtime storage: PASS (durable results, bounded redaction, 2500-event replay, owner isolation, preparing controls, approval resolution events)");
} finally {
  await closeRunJournalStore(directory).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
