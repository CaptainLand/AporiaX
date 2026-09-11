import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { executeDurableTool, withDurableRun } from "../electron/runtime/durable-run.js";
import { createFullAutoApproval } from "../electron/runtime/full-auto-approval.js";
import { createHarnessTaskRuntime } from "../electron/harness/task-runtime.js";
import { beginRunJournal, saveRunOperation, getRunRecoveryContext, closeRunJournalStore, findConfirmedRunOperation } from "../electron/run-store.js";
const fingerprint = (tool, input) => createHash("sha256").update(JSON.stringify([tool, input])).digest("hex");
let clicks = 0;
const approve = async () => { clicks++; return { approved: true }; };
const automatic = createFullAutoApproval({ approvalMode: "full-auto", requestApproval: approve });
const writes = [];
await withDurableRun({ operation: async (op) => writes.push(op) }, async () => {
  for (let i = 0; i < 100; i++) {
    await executeDurableTool("browser_open", { url: "https://unused.invalid" }, async () => ({ error: "timeout" }), automatic);
    await automatic({ toolName: "run_command", command: "npm start" });
    await executeDurableTool("run_command", { command: "npm start" }, async () => ({ exitCode: 0 }), automatic);
    await executeDurableTool("write_file", { path: `test-${i}.html` }, async () => ({ ok: true }), automatic);
  }
});
assert.equal(clicks, 0, "100 browser errors + 200 subsequent operations must not cause approval spam");
assert.equal(writes.filter((op) => op.state === "uncertain").length, 0);

const stale = { operationId: "stale", tool: "mcp_publish", state: "uncertain", fingerprint: fingerprint("mcp_publish", {}) };
const state = { unresolved: [stale], operation: async (op) => writes.push(op) };
await withDurableRun(state, async () => {
  await Promise.all(Array.from({ length: 50 }, (_, i) => executeDurableTool("write_file", { path: `${i}.txt` }, async () => ({}), automatic)));
  assert.equal(clicks, 0, "unrelated parallel agent work is not gated");
  await executeDurableTool("mcp_publish", {}, async () => ({}), automatic);
  await executeDurableTool("mcp_publish", {}, async () => ({}), automatic);
});
assert.equal(clicks, 1, "one acknowledgement clears the matching old record");
assert.equal(state.unresolved.length, 0);
assert(writes.some((op) => op.operationId === "stale" && op.state === "reconciled"));

let denyClicks = 0;
await withDurableRun({ unresolved: [{ ...stale }], operation: async () => {} }, async () => {
  for (let i = 0; i < 10; i++) await assert.rejects(() => executeDurableTool("mcp_publish", {}, async () => { throw Error("must not execute"); }, async () => { denyClicks++; return { approved: false }; }), /RECOVERY_RECONCILIATION_REQUIRED/);
});
assert.equal(denyClicks, 1, "a denial is not followed by an endless identical prompt");

let unlockApproval, approvalStarted;
const awaiting = new Promise((resolve) => { approvalStarted = resolve; });
await withDurableRun({ unresolved: [{ ...stale }], operation: async () => {} }, async () => {
  const pending = executeDurableTool("mcp_publish", {}, async () => ({}), () => { approvalStarted(); return new Promise((resolve) => { unlockApproval = resolve; }); });
  await awaiting;
  let unrelatedDone = false;
  const unrelated = executeDurableTool("write_file", { path: "independent.txt" }, async () => { unrelatedDone = true; }, automatic);
  await Promise.race([unrelated, new Promise((_, reject) => setTimeout(() => reject(Error("unrelated work blocked by approval")), 1000))]);
  assert(unrelatedDone);
  unlockApproval({ approved: true });
  await pending;
});

let effects = 0;
await withDurableRun({ unresolved: [{ ...stale }], operation: async () => { throw Error("disk full"); } }, async () => {
  await assert.rejects(() => executeDurableTool("mcp_publish", {}, async () => { effects++; }, approve), /disk full/);
});
assert.equal(effects, 0, "acknowledgement must be durable before the effect");

let sharedPrompts = 0;
await withDurableRun({ unresolved: [{ ...stale }], operation: async () => {} }, async () => {
  await Promise.all(Array.from({ length: 10 }, () => executeDurableTool("mcp_publish", {}, async () => ({}), async () => {
    sharedPrompts++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { approved: true };
  })));
});
assert.equal(sharedPrompts, 1, "concurrent callers share a single historical acknowledgement");

const cancelled = [];
const controller = new AbortController();
await withDurableRun({ signal: controller.signal, operation: async (op) => { cancelled.push(op); if (op.state === "started") controller.abort(); } }, async () => {
  await assert.rejects(() => executeDurableTool("mcp_publish", {}, async () => { effects++; }, approve), { name: "AbortError" });
});
assert.equal(effects, 0);
assert.equal(cancelled.at(-1).state, "cancelled", "abort before execution is not an uncertain effect");

const root = await mkdtemp(join(tmpdir(), "aporiax-recovery-regression-"));
try {
  await beginRunJournal(root, { runId: "old-browser-error" });
  await saveRunOperation(root, "old-browser-error", { operationId: "old-browser", tool: "browser_open", state: "uncertain", error: "timeout", fingerprint: fingerprint("browser_open", {}) });
  const oldBrowser = await getRunRecoveryContext(root, "old-browser-error");
  assert.equal(oldBrowser.unresolvedOperations.length, 0, "old-version navigation errors must not contaminate recovery instructions");
  assert.equal(oldBrowser.operations[0].state, "uncertain", "keep the original audit outcome");
  assert.equal(oldBrowser.operations[0].replaySafe, true);
  let oldBrowserPrompts = 0;
  const legacyRuntime = createHarnessTaskRuntime({ dataDirectory: root });
  await legacyRuntime.start({ runId: "old-browser-recovered", recoveryContext: oldBrowser,
    onEvent: (event) => { if (event.type === "approval.required") { oldBrowserPrompts++; legacyRuntime.respondApproval("old-browser-recovered", event.approval.id, { approved: true }); } },
    execute: async ({ requestApproval }) => {
      await executeDurableTool("write_file", { path: "page.html" }, async () => ({}), requestApproval);
      await executeDurableTool("browser_open", {}, async () => ({}), requestApproval);
      return { status: "completed" };
    },
  });
  assert.equal(oldBrowserPrompts, 0);
  await beginRunJournal(root, { runId: "origin" });
  await saveRunOperation(root, "origin", { ...stale, state: "confirmed" });
  // Ensure the confirmed operation is older than the 80-operation context cap.
  for (let i = 0; i < 85; i++) await saveRunOperation(root, "origin", { operationId: `noise-${i}`, tool: "write_file", state: "confirmed", fingerprint: `noise-${i}` });
  const recovery = await getRunRecoveryContext(root, "origin");
  const runtime = createHarnessTaskRuntime({ dataDirectory: root });
  let prompts = 0;
  const result = await runtime.start({ runId: "recovered", recoveryContext: recovery,
    onEvent: (event) => { if (event.type === "approval.required") { prompts++; runtime.respondApproval("recovered", event.approval.id, { approved: true }); } },
    execute: async ({ requestApproval }) => {
      await executeDurableTool("mcp_publish", {}, async () => ({}), requestApproval);
      for (let i = 0; i < 20; i++) await executeDurableTool("mcp_publish", {}, async () => ({}), requestApproval);
      return { status: "completed", changes: [] };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(prompts, 1, "active-run successes are not historical replays");
  assert.equal(await findConfirmedRunOperation(root, "recovered", stale.fingerprint), null);
  // Ancestor audit record is preserved even when recovered lazily beyond 80 rows.
  const original = await getRunRecoveryContext(root, "origin");
  assert.equal(original.unresolvedOperations.length, 0);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(root, "aporiax-runs.sqlite3"));
  assert.equal(db.prepare("SELECT run_id FROM run_operations WHERE operation_id='stale'").get().run_id, "origin");
  db.close();

  await beginRunJournal(root, { runId: "uncertain-origin" });
  await saveRunOperation(root, "uncertain-origin", { ...stale, operationId: "uncertain-original" });
  let ackPrompts = 0;
  await runtime.start({ runId: "ack-only", recoveryContext: await getRunRecoveryContext(root, "uncertain-origin"),
    onEvent: (event) => { if (event.type === "approval.required") { ackPrompts++; runtime.respondApproval("ack-only", event.approval.id, { approved: true }); } },
    execute: async ({ requestApproval }) => { await executeDurableTool("mcp_publish", {}, async () => ({}), requestApproval); return { status: "completed" }; },
  });
  await closeRunJournalStore(root);
  const saved = await getRunRecoveryContext(root, "ack-only");
  assert.equal(ackPrompts, 1);
  assert.equal(saved.unresolvedOperations.length, 0, "acknowledgements survive SQLite reopen");
  assert(saved.operations.some((op) => op.state === "reconciled"));
  assert.equal((await getRunRecoveryContext(root, "uncertain-origin")).unresolvedOperations.length, 1, "historical source is immutable");
} finally {
  await closeRunJournalStore(root);
  const rel = relative(tmpdir(), root); assert(rel.startsWith("aporiax-recovery-regression-") && !rel.includes(".."));
  await rm(root, { recursive: true, force: true });
}
console.log("Recovery approvals: 300 operations without spam, scoped acknowledgement, denial suppression, parallel agents, durable restart, >80-history and immutable ancestor audit: PASS");
