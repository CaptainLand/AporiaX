import assert from "node:assert/strict";
import { automaticResumeHint } from "../electron/runtime/auto-resume.js";
import { loadTaskContinuation } from "../electron/runtime/retry-continuation.js";
import { autoRetryDelay, canResumeAutomatically, createAutoRetryQueue, normalizeAutoRetry } from "../src/state/automatic-retry.js";
import { executeTaskRetry } from "../src/state/run-retry-core.js";

const rateLimit = { status: 429, modelHttpRejection: true, retryAfterMs: 5000 };
const byok = error => automaticResumeHint({ error, providerKind: "openai-compatible", status: "failed" });
assert.deepEqual(byok(rateLimit), { reason: "rate-limit", retryAfterMs: 5000 });
assert.equal(byok({ ...rateLimit, modelHttpRejection: false }), null, "streaming 429 is ambiguous");
assert.equal(byok({ status: 502, retryable: true }), null);
assert.equal(byok({ ...rateLimit, usage: { output_tokens: 1 } }), null);
assert.equal(byok({ ...rateLimit, partialMessage: { content: "partial" } }), null);
assert.equal(byok({ ...rateLimit, retryAfterMs: 180000 }), null);
assert.equal(byok({ status: 401 }), null);
assert.equal(byok({ name: "AbortError", requestNeverConnected: true }), null);
assert.equal(byok({ requestNeverConnected: true }).reason, "connection");
assert.equal(automaticResumeHint({ status: "failed", providerKind: "chatgpt-personal", error: rateLimit }), null);
const cloud = (error, flags) => automaticResumeHint({ status: "partial", providerKind: "aporia-cloud",
  replyDelivered: true, replySource: "local-receipt", error, ...flags });
const released = { status: 503, retryWithNewCloudRequest: true, cloudRequestId: "known" };
assert.equal(cloud({ status: 503 }), null);
assert.equal(cloud({ ...released, status: 401 }), null);
assert.equal(cloud(released)?.reason, "server");
assert.equal(cloud(released, { persistenceFailed: true }), null);
assert.equal(cloud(released, { replySource: "model" }), null);

assert.deepEqual(normalizeAutoRetry(null), { enabled: false, attempts: 2 });
assert.equal(normalizeAutoRetry({ enabled: true, attempts: 9 }).attempts, 2);
const result = { status: "failed", autoResume: byok(rateLimit) };
assert.equal(autoRetryDelay({ enabled: false, attempts: 2 }, result, 0), null);
assert.equal(autoRetryDelay({ enabled: true, attempts: 2 }, result, 0), 5000);
assert.equal(autoRetryDelay({ enabled: true, attempts: 2 }, result, 2), null);
assert.equal(autoRetryDelay({ enabled: true, attempts: 2 }, { ...result, status: "interrupted" }, 0), null);

const request = { taskId: "t", recoveryRunId: "r", sourceUserId: "u", providerId: "p", modelId: "m", workspacePath: "", retryMode: "continue", automaticRetry: true };
const checkpoint = { runId: "r", taskId: "t", sourceUserId: "u", providerId: "p", modelId: "m",
  workspacePath: "", status: "failed", contexts: { r: { kind: "main", steps: ["worked"] } }, unresolvedOperations: [] };
assert.equal(await loadTaskContinuation(request, async () => checkpoint), checkpoint);
for (const patch of [{ status: "interrupted" }, { modelId: "other" }, { providerId: "other" }, { contexts: {} },
  { resumedByRunId: "new" }, { unresolvedOperations: [{ operationId: "unconfirmed" }] }]) {
  await assert.rejects(loadTaskContinuation(request, async () => ({ ...checkpoint, ...patch })), { code: "RETRY_CONTINUATION_UNAVAILABLE" });
}

const entry = { taskId: "t", runId: "r", sourceUserId: "u", assistantId: "a", providerId: "p", modelId: "m", workspacePath: "", attempt: 1, limit: 2 };
const task = { ...entry, id: "t", messages: [{ id: "u", role: "user" },
  { id: "a", role: "assistant", status: "failed", runId: "r", sourceUserId: "u" }] };
assert.equal(canResumeAutomatically(task, entry), true);
assert.equal(canResumeAutomatically({ ...task, modelId: "changed" }, entry), false);
assert.equal(canResumeAutomatically({ ...task, messages: [...task.messages, { role: "user", queued: true }] }, entry), false);

const callbacks = [];
const queue = createAutoRetryQueue({ schedule: callback => callbacks.push(callback) - 1, clear: () => {} });
let started = 0;
queue.enqueue(entry, 0, () => started++);
queue.cancel(entry.taskId);
await callbacks[0]();
assert.equal(started, 0);
queue.enqueue(entry, 0, () => started++);
await callbacks[1]();
assert.equal(started, 1);
let proceed = true;
const rendererRuns = new Map();
const aborted = await executeTaskRetry({ taskId: "t", rendererRuns,
  listActiveRuns: async () => { proceed = false; rendererRuns.set("new", { taskId: "t" }); return []; },
  canProceed: () => proceed, startRetry: () => { throw Error("must not start"); } });
assert.equal(aborted.reason, "cancelled");
assert.ok(rendererRuns.has("new"), "do not clear a just-started replacement run");
console.log("PASS automatic retry: safe fault classification, checkpoint ownership, cancellation races, limits and backoff.");
