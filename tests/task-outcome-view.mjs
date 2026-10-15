import assert from "node:assert/strict";
import { latestVisibleAssistant, isHistoricalFailure, savedOutcomeFiles, hasTaskReply } from "../src/state/task-outcome-view.js";
import { resultSummaryStop } from '../electron/runtime/result-summary.js';
import { replaceAssistantForRetry } from "../src/state/task-store-core.js";

const old = { id: "failed", role: "assistant", status: "failed", witness: { status: "failed" }, changes: [{ path: "report.docx" }] };
for (const status of ["running", "completed", "failed", "needs_input"]) {
  const retried = replaceAssistantForRetry({ messages: [old] }, old.id, { id: "new", role: "assistant", status, witness: null });
  assert.equal(latestVisibleAssistant(retried.messages).id, "new");
  assert.equal(latestVisibleAssistant(retried.messages).witness, null, "no fallback to superseded Witness");
}
const continued = [old, { id: "next-user", role: "user", content: "continue" }, { id: "next", role: "assistant", status: "completed", witness: null }];
assert(isHistoricalFailure(old, latestVisibleAssistant(continued)));
assert(!isHistoricalFailure(old, old));
assert.equal(latestVisibleAssistant([]), undefined);
assert.deepEqual(savedOutcomeFiles({ changes: [
  { path: "report.docx" }, { path: "report.docx" }, { path: "gone.txt", deleted: true },
  { path: "missing.txt", afterMissing: true }, { path: "restored.txt", reverted: true }, {},
] }), ["report.docx"]);
assert.deepEqual(savedOutcomeFiles({ ...old, anchorRestoredAt: "now" }), []);
for (const status of ['completed', 'partial', 'blocked', 'needs_input']) {
  const message = { id: status, role: 'assistant', status, content: '已有结果；原因和剩余工作在这里说明。', selfCheck: { delivery: { status: 'failed' } } };
  assert(hasTaskReply(message));
  assert.equal(message.selfCheck.delivery.status, 'failed');
  assert(!isHistoricalFailure(message, { id: 'new' }));
  assert(!hasTaskReply({ ...message, replyDelivered: false }));
  assert(!hasTaskReply({ ...message, error: true }));
  assert(!hasTaskReply({ ...message, content: '  ' }));
}
for (const status of ['running', 'paused', 'waiting', 'failed', 'interrupted']) assert(!hasTaskReply({ status, content: 'Not a final result' }));
for (const code of ['AbortError', 'TASK_SUSPENDED', 'CONTEXT_BUDGET_EXCEEDED', 'PERSISTENCE_FAILED', 'CLOUD_QUOTA_EXHAUSTED', 'HTTP_401', undefined]) assert.equal(resultSummaryStop({ code }), null);
assert(resultSummaryStop({ code: 'LOOP_NO_PROGRESS' }));
assert(resultSummaryStop({ code: 'LOOP_STRATEGY_EXHAUSTED' }));
console.log("Task outcome view: retry/follow-up/new task, latest Witness, preserved non-deleted files: PASS");
