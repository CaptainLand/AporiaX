import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { validateApprovalResponse } from "../electron/harness/approval-response.js";
import { createHarnessCoreServer } from "../electron/harness/core-server.js";
import { createHarnessTaskRuntime } from "../electron/harness/task-runtime.js";
import { closeRunJournalStore } from "../electron/run-store.js";

const root = await mkdtemp(join(tmpdir(), "aporiax-approval-types-"));
const runtime = createHarnessTaskRuntime({ dataDirectory: root, approvalGrantKey: () => "fixture-grant" });
const server = createHarnessCoreServer({ kernel: { taskRuntime: runtime, events: { emit() {} } } });
const invalidValues = ["false", "true", 0, 1, null, [], {}, undefined];
const invalidScopes = ["all", "", null, 0, true, [], {}];
let cases = 0;
const active = [];
try {
  await server.listen();
  for (const decision of [false, true]) {
    const runId = decision ? "approve" : "reject";
    let notify;
    const ready = new Promise(resolve => { notify = resolve; });
    let result;
    const completion = runtime.start({ runId, clientId: "owner", onEvent(event) {
      if (event.type === "approval.required") notify(event.approval.id);
    }, execute: async ({ requestApproval }) => {
      result = await requestApproval({ tool: "fixture", command: "no command executes" });
      if (decision) assert.equal((await requestApproval({ tool: "fixture" })).remembered, true);
      return { status: "completed" };
    } });
    active.push(completion);
    const approvalId = await ready;
    const endpoint = `${server.url}/v1/tasks/${runId}/approvals/${approvalId}`;
    const post = (body, authenticated = true, url = endpoint) => fetch(url, { method: "POST",
      headers: { "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${server.token}` } : {}) },
      body: JSON.stringify(body) });
    assert.equal((await post({ approved: true }, false)).status, 401); cases++;
    for (const approved of invalidValues) {
      assert.equal((await post({ approved })).status, 400);
      assert.throws(() => runtime.respondApproval(runId, approvalId, { approved }), /invalid_approval/);
      assert.equal((await runtime.snapshot()).pendingApprovals.length, 1);
      cases++;
    }
    for (const scope of invalidScopes) {
      assert.equal((await post({ approved: true, scope })).status, 400);
      assert.throws(() => runtime.respondApproval(runId, approvalId, { approved: true, scope }), /invalid_approval/);
      assert.equal((await runtime.snapshot()).pendingApprovals.length, 1);
      cases++;
    }
    assert.throws(() => runtime.respondApproval(runId, approvalId, null), /invalid_approval/);
    assert.equal(runtime.respondApproval(runId, approvalId, { approved: true, clientId: "other" }), false);
    assert.equal(runtime.respondApproval("other-run", approvalId, { approved: true }), false);
    assert.equal((await post({ approved: true }, true, endpoint.replace(runId, "other-run"))).status, 404);
    assert.equal((await runtime.snapshot()).pendingApprovals.length, 1); cases += 4;
    assert.equal((await post({ approved: decision, ...(decision ? { scope: "run" } : {}) })).status, 200);
    await completion;
    assert.equal(result.approved, decision);
    assert.equal((await post({ approved: !decision })).status, 404);
    assert.equal(runtime.respondApproval(runId, approvalId, { approved: true }), false); cases += 4;
  }
  for (const id of [null, 1, [], "", " ", "x".repeat(101), "a\0b"]) {
    assert.throws(() => validateApprovalResponse(id, "id", { approved: true }), /invalid_approval/);
    assert.throws(() => validateApprovalResponse("run", id, { approved: true }), /invalid_approval/); cases++;
  }
  let notifyExpired;
  const expiredReady = new Promise(resolve => { notifyExpired = resolve; });
  let interruptedDecision;
  const interruptedRun = runtime.start({ runId: "expired", onEvent(event) {
    if (event.type === "approval.required") notifyExpired(event.approval.id);
  }, execute: async ({ requestApproval }) => {
    interruptedDecision = await requestApproval({ tool: "fixture" });
    return { status: "interrupted" };
  } });
  active.push(interruptedRun);
  const expiredId = await expiredReady;
  runtime.interrupt("expired");
  await interruptedRun;
  assert.equal(interruptedDecision.approved, false);
  assert.equal(runtime.respondApproval("expired", expiredId, { approved: true }), false); cases += 2;
  // Preload must not turn a caller's malformed input into a valid true value.
  let exposed;
  const sent = [];
  vm.runInNewContext(await readFile(new URL("../electron/approval-toast-preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
      ipcRenderer: { send: (...args) => sent.push(args), on() {} } }),
  });
  for (const value of invalidValues) { assert.throws(() => exposed.decide(value)); cases++; }
  assert.equal(sent.length, 0);
  exposed.decide(false); exposed.decide(true);
  assert.deepEqual(sent.map(row => row[1]), [false, true]); cases++;
  console.log(`Approval response regression: ${cases} cases PASS (HTTP, runtime, ownership, replay, preload).`);
} finally {
  for (const run of runtime.listActiveRuns()) runtime.interrupt(run.runId);
  await Promise.allSettled(active);
  await server.close();
  await closeRunJournalStore(root);
  await rm(root, { recursive: true, force: true });
}
