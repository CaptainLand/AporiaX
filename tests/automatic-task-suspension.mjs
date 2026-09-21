import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunControl, activeTimeout, isTemporaryNetworkError } from "../electron/runtime/run-control.js";
import { monitorTaskEnvironment } from "../electron/runtime/environment-monitor.js";
import { withDurableRun, executeDurableTool } from "../electron/runtime/durable-run.js";
import { completeLoopRequest } from "../electron/runtime/loop-recovery.js";
import { callModelProvider } from "../electron/runtime/provider-stream.js";
import { createTokenAccounting } from "../electron/agent-context.js";
import { createHarnessTaskRuntime } from "../electron/harness/task-runtime.js";
import { closeRunJournalStore } from "../electron/run-store.js";
import { createWitnessMonitor } from "../electron/witness-monitor.js";
import { withAgentBudgetAdmission, planAgentBudget, runWithAgentBudget } from "../electron/harness/agent-budget.js";
import { taskSuspensionLabel } from "../src/state/task-suspension.js";
const delay = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test) { for (let i = 0; i < 200; i++) { if (test()) return; await delay(5); } assert.fail("Condition did not settle"); }
let count = 0;
async function test(name, fn) { await fn(); console.log("PASS", ++count, name); }
const signal = () => new AbortController();
const provider = { id: "fixture", name: "Fixture", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only" };
const conversation = () => [{ role: "system", content: "Do not publish" }, { role: "user", content: "Original request" }];
function loop(control, options = {}) {
  return completeLoopRequest({ conversation: conversation(), contextCheckpoints: [], accounting: createTokenAccounting(),
    contextWindowTokens: 64000, getBody: messages => ({ model: "fixture", messages }),
    complete: (body, signal) => callModelProvider({ provider, body, signal }), ...options });
}
const sse = content => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n');
const originalFetch = globalThis.fetch;
try {
  await test("user/network/sleep reasons compose; duplicate wake cannot clear user pause", async () => {
    const c = createRunControl(); c.pause(); c.setOnline(false); c.suspend();
    let continued = false; const waiting = c.waitIfPaused().then(() => continued = true);
    c.wake(true); c.wake(true); await delay(); assert.equal(continued, false);
    assert.deepEqual(c.snapshot().pauseReasons, ["user"]);
    c.resume(); await waiting; assert.equal(continued, true); c.abort();
  });
  await test("stop cancels gates and reconnect timers permanently", async () => {
    const c = createRunControl({ networkRetryMs: 10 }); c.waitForNetwork();
    const waiting = c.waitIfPaused(); c.abort(); c.wake(true); c.retryNetwork();
    await assert.rejects(waiting, { name: "AbortError" });
    await assert.rejects(c.runRequest(() => assert.fail("resurrected")), { name: "AbortError" });
  });
  await test("OS offline avoids polling inference; wake/online are hints only", async () => {
    const power = new EventEmitter(), states = []; let online = false;
    const dispose = monitorTaskEnvironment({ powerMonitor: power, net: { isOnline: () => online }, runtime: { setEnvironment: state => states.push(state) }, intervalMs: 5 });
    power.emit("lock-screen"); assert.equal(states.length, 1);
    power.emit("suspend"); online = true; power.emit("resume");
    assert.deepEqual(states.at(-1), { sleeping: false, online: true });
    dispose(); assert.equal(power.listenerCount("suspend"), 0);
  });
  await test("active-time deadline and Witness do not treat suspension as a stall", async () => {
    let now = 1000;
    const c = createRunControl({ now: () => now });
    const witness = createWitnessMonitor({ control: c, now: () => now, heartbeatMs: 0 });
    witness.observe({ type: "turn.started" }); witness.observe({ type: "response.reset" });
    let fired = false; const cancel = activeTimeout(() => fired = true, 50, c);
    now += 10; c.suspend(); now += 600_000; witness.heartbeat();
    assert.equal(fired, false); assert.equal(witness.snapshot().alerts.length, 0);
    c.wake(); witness.heartbeat(); assert.equal(witness.snapshot().alerts.length, 0);
    assert.equal(c.activeNow(), 1010); now += 50; c.pause(); c.resume();
    assert.equal(fired, true); cancel(); witness.dispose(); c.abort();
  });
  await test("only genuine temporary transport failures are eligible", async () => {
    for (const error of [new Error("bad API key"), Object.assign(new Error(), { status: 429, retryable: true }),
      Object.assign(new Error(), { status: 503 }), new TypeError("Cannot read property"), Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } })]) {
      assert.equal(isTemporaryNetworkError(error), false);
    }
    assert.equal(isTemporaryNetworkError(new TypeError("fetch failed")), true);
    assert.equal(isTemporaryNetworkError(Object.assign(new Error(), { code: "ECONNRESET" })), true);
  });
  await test("pre-response disconnect retains history; retries only inference", async () => {
    const c = createRunControl({ networkRetryMs: 5 }), checkpoints = [], operations = [];
    let requests = 0, mutations = 0; const sent = [];
    globalThis.fetch = async (_url, init) => { sent.push(JSON.parse(init.body).messages); if (++requests === 1) throw new TypeError("fetch failed"); return sse("done"); };
    await withDurableRun({ control: c, checkpoint: cp => checkpoints.push(cp), operation: op => operations.push(op) }, async () => {
      await executeDurableTool("write_file", { path: "done.txt" }, async () => { mutations++; return { path: "done.txt" }; });
      assert.equal((await loop(c)).message.content, "done");
    });
    assert.equal(mutations, 1); assert.equal(requests, 2); assert.deepEqual(sent[0], sent[1]);
    assert.equal(operations.at(-1).state, "confirmed"); assert.equal(checkpoints.at(-1).incomplete, true); c.abort();
  });
  await test("mid-stream disconnect saves text but never executes partial tool JSON", async () => {
    const c = createRunControl({ networkRetryMs: 5 }), checkpoints = [], failures = [];
    let requests = 0;
    globalThis.fetch = async () => {
      if (++requests > 1) return sse("recovered");
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: "partial", tool_calls: [{ index: 0, id: "partial-call", function: { name: "write_file", arguments: '{"path":' } }] } }], usage: { prompt_tokens: 7, completion_tokens: 1 } }) + '\n\n');
    };
    const result = await withDurableRun({ control: c, checkpoint: cp => checkpoints.push(cp) }, () => loop(c, { onFailedUsage: usage => failures.push(usage) }));
    assert.equal(result.message.content, "recovered"); assert.equal(result.message.tool_calls, undefined);
    assert.equal(checkpoints[0].content, "partial"); assert.equal(checkpoints[0].toolCallsExecuted, false);
    assert.equal(failures[0].prompt_tokens, 7); c.abort();
  });
  await test("sleep cancels only inference, resumes same request after wake", async () => {
    const c = createRunControl(), checkpoints = []; let requests = 0;
    globalThis.fetch = async (_url, init) => {
      if (++requests > 1) return sse("awake");
      return await new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true }));
    };
    const pending = withDurableRun({ control: c, checkpoint: cp => checkpoints.push(cp) }, () => loop(c));
    await until(() => requests === 1); c.suspend(); await until(() => checkpoints.length);
    await delay(); assert.equal(requests, 1); c.wake(true);
    assert.equal((await pending).message.content, "awake"); assert.equal(requests, 2); c.abort();
  });
  await test("guidance queued while offline yields before stale retry", async () => {
    const c = createRunControl(); let requests = 0; const checkpoints = [];
    globalThis.fetch = async () => { requests++; throw new TypeError("fetch failed"); };
    const pending = withDurableRun({ control: c, checkpoint: cp => checkpoints.push(cp) }, () => loop(c, { shouldYield: () => c.hasSteering() }));
    await until(() => c.paused); c.enqueueSteering({ id: "new", content: "Do not change files" }); c.retryNetwork();
    assert.equal((await pending).interrupted, true); assert.equal(requests, 1); assert.equal(c.consumeSteering()[0].id, "new"); c.abort();
  });
  await test("queued Builders and native reads/writes share parent pause gate", async () => {
    const c = createRunControl(); c.pause(); let tools = 0, workers = 0, active = 0, peak = 0;
    const plan = planAgentBudget({ workspacePath: process.cwd(), permission: "workspace-write", builderLimit: 1, prompt: "Implement project", executionMode: "direct" });
    const work = withDurableRun({ control: c, operation: () => {} }, () => runWithAgentBudget(plan, {}, async () => {
      const jobs = Array.from({ length: 4 }, () => withAgentBudgetAdmission({ role: "builder" }, async () => { workers++; peak = Math.max(peak, ++active); await delay(); active--; }));
      jobs.push(executeDurableTool("read_file", {}, () => { tools++; }));
      jobs.push(executeDurableTool("write_file", {}, () => { tools++; }));
      await Promise.all(jobs);
    }));
    await delay(); assert.equal(workers, 0); assert.equal(tools, 0); c.resume(); await work;
    assert.equal(workers, 4); assert.equal(tools, 2); assert.equal(peak, 1); c.abort();
  });
  await test("unknown side effects remain uncertain, never automatically repeated", async () => {
    const c = createRunControl(), operations = []; let calls = 0;
    await withDurableRun({ control: c, operation: op => operations.push(op) }, async () => {
      await assert.rejects(executeDurableTool("run_command", { command: "publish" }, async () => { calls++; throw new TypeError("fetch failed"); }));
    });
    assert.equal(calls, 1); assert.equal(operations.at(-1).state, "uncertain"); c.abort();
  });
  await test("stop after saved intent but before execution records cancellation, not uncertainty", async () => {
    const c = createRunControl(), abort = signal(), operations = []; let invoked = false;
    const pending = withDurableRun({ control: c, signal: abort.signal, operation: op => {
      operations.push(op); if (op.state === "started") c.pause();
    } }, () => executeDurableTool("write_file", { path: "not-written.txt" }, () => { invoked = true; }));
    await until(() => c.paused); abort.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(invoked, false); assert.equal(operations.at(-1).state, "cancelled"); c.abort();
  });
  await test("four in-flight agents suspend together and resume without duplicate starts", async () => {
    const c = createRunControl(), checkpoints = []; let attempts = 0, completed = 0;
    const work = withDurableRun({ control: c, checkpoint: cp => checkpoints.push(cp) }, () => Promise.all(
      Array.from({ length: 4 }, (_, index) => {
        let localAttempts = 0;
        return loop(c, { scopeId: "worker-" + index, complete: async (_body, requestSignal) => {
          attempts++; localAttempts++;
          if (localAttempts === 1) return new Promise((_, reject) => requestSignal.addEventListener("abort",
            () => reject(Object.assign(new Error("interrupted model"), { name: "AbortError" })), { once: true }));
          completed++; return { message: { content: "done-" + index } };
        } });
      })));
    await until(() => attempts === 4); c.suspend(); await until(() => checkpoints.length === 4);
    assert.equal(completed, 0); c.wake(true);
    assert.equal((await work).length, 4); assert.equal(attempts, 8); assert.equal(completed, 4); c.abort();
  });
  await test("run-control reasons/guidance are durable and stop survives later wake", async () => {
    const root = await mkdtemp(join(tmpdir(), "aporia-suspension-"));
    const runtime = createHarnessTaskRuntime({ dataDirectory: root }); let entered = false;
    try {
      const pending = runtime.start({ runId: "wait-test", metadata: { prompt: "Original" }, execute: async ({ control, signal }) => {
        entered = true; while (!signal.aborted) { await control.waitIfPaused(signal); await delay(); } return { status: "interrupted" };
      } });
      const caught = pending.catch(error => error);
      await until(() => entered); runtime.setEnvironment({ online: false });
      await runtime.pause("wait-test"); runtime.steer("wait-test", { id: "guide", content: "Keep my files" });
      await delay(50);
      const saved = await runtime.recoveryContext("wait-test");
      assert.deepEqual(saved.checkpoint.agents["run-control"].pauseReasons, ["network", "user"]);
      assert.equal(saved.checkpoint.agents["run-control"].pendingSteering[0].content, "Keep my files");
      runtime.setEnvironment({ online: true }); assert.equal(runtime.getActiveRun("wait-test").paused, true);
      runtime.interrupt("wait-test"); await caught; runtime.setEnvironment({ sleeping: false });
      assert.equal(runtime.hasActiveRuns(), false);
    } finally { await closeRunJournalStore(root); await rm(root, { recursive: true, force: true }); }
  });
  await test("failed persistence blocks request; UI names distinguish pause reasons", async () => {
    const c = createRunControl(); c.onChange(() => Promise.reject(new Error("disk failed"))); c.pause(); c.resume();
    await assert.rejects(c.runRequest(() => assert.fail("unsafe request")), /disk failed/);
    assert.match(taskSuspensionLabel(["network"]), /等待网络/);
    assert.match(taskSuspensionLabel(["network", "user"]), /手动暂停/); c.abort();
  });
} finally { globalThis.fetch = originalFetch; }
console.log("Automatic task suspension:", count, "scenarios PASS");
