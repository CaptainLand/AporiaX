import assert from "node:assert/strict";
import {
  executeTaskRetry,
  prepareTaskRetry,
} from "../src/state/run-retry-core.js";

const staleRendererRuns = new Map([
  ["stale-run", { taskId: "task-1", assistantId: "assistant-1" }],
]);
const staleResult = await prepareTaskRetry({
  taskId: "task-1",
  rendererRuns: staleRendererRuns,
  listActiveRuns: async () => [],
  interruptRun: async () => false,
});
assert.equal(staleResult.ready, true);
assert.equal(staleResult.reason, "main-confirmed-idle");
assert.deepEqual(staleResult.removedRunIds, ["stale-run"]);
assert.equal(staleRendererRuns.size, 0, "stale renderer state no longer blocks retry");

const liveRendererRuns = new Map([
  ["live-run", { taskId: "task-2", assistantId: "assistant-2" }],
]);
let mainRuns = [{ runId: "live-run", taskId: "task-2" }];
const interrupted = [];
const liveResult = await prepareTaskRetry({
  taskId: "task-2",
  rendererRuns: liveRendererRuns,
  listActiveRuns: async () => mainRuns,
  interruptRun: async (runId) => {
    interrupted.push(runId);
    mainRuns = [];
    return true;
  },
  interruptActive: true,
  sleep: async () => undefined,
  timeoutMs: 100,
  pollMs: 1,
});
assert.equal(liveResult.ready, true);
assert.deepEqual(interrupted, ["live-run"]);
assert.equal(liveRendererRuns.size, 0);

const newerRun = new Map([["newer-run", { taskId: "task-5" }]]);
const protectedResult = await prepareTaskRetry({
  taskId: "task-5",
  rendererRuns: newerRun,
  listActiveRuns: async () => [{ runId: "newer-run", taskId: "task-5" }],
  interruptRun: async () => {
    throw new Error("a newer active run must not be interrupted");
  },
});
assert.equal(protectedResult.ready, false);
assert.equal(protectedResult.reason, "task-still-active");
assert.equal(newerRun.has("newer-run"), true);

const scopedRuns = new Map([
  ["old-run", { taskId: "task-3" }],
  ["other-task-run", { taskId: "task-4" }],
]);
const scopedResult = await prepareTaskRetry({
  taskId: "task-3",
  rendererRuns: scopedRuns,
  listActiveRuns: async () => [],
});
assert.equal(scopedResult.ready, true);
assert.equal(scopedRuns.has("old-run"), false);
assert.equal(scopedRuns.has("other-task-run"), true);

let replacementStarts = 0;
const transactionRuns = new Map([
  ["stale-run", { taskId: "task-retry" }],
]);
const transactionResult = await executeTaskRetry({
  taskId: "task-retry",
  rendererRuns: transactionRuns,
  listActiveRuns: async () => [],
  onReady: () => {
    assert.equal(transactionRuns.has("stale-run"), false);
  },
  startRetry: async () => {
    replacementStarts += 1;
    return true;
  },
});
assert.equal(transactionResult.started, true);
assert.equal(transactionResult.reason, "started");
assert.equal(replacementStarts, 1);

const rejectedResult = await executeTaskRetry({
  taskId: "task-retry",
  rendererRuns: new Map(),
  listActiveRuns: async () => [],
  startRetry: async () => false,
});
assert.equal(rejectedResult.started, false);
assert.equal(rejectedResult.reason, "start-rejected");

const failedResult = await executeTaskRetry({
  taskId: "task-retry",
  rendererRuns: new Map(),
  listActiveRuns: async () => [],
  startRetry: async () => {
    throw new Error("renderer start failed");
  },
});
assert.equal(failedResult.started, false);
assert.equal(failedResult.reason, "retry-error");
assert.match(failedResult.error.message, /renderer start failed/);

console.log("run retry core smoke: PASS");
