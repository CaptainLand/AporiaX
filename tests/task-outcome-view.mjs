import assert from "node:assert/strict";
import { latestVisibleAssistant, isHistoricalFailure, savedOutcomeFiles } from "../src/state/task-outcome-view.js";
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
console.log("Task outcome view: retry/follow-up/new task, latest Witness, preserved non-deleted files: PASS");
