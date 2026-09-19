import assert from "node:assert/strict";
import { createPersistentProcessManager } from "../electron/runtime/process-runtime.js";
import { StrategyHistory } from "../electron/runtime/strategy-history.js";
import { suite } from "./goal-loop-fixtures.mjs";
const { test, finish } = suite("goal-process-strategy");
const command = (script) => `"${process.execPath}" -e "${script}"`;
const manager = createPersistentProcessManager();
const start = (script) => manager.start({ command: command(script), cwd: process.cwd() });
try {
  await test("wait until exit returns final output without model polling", async () => {
    const p = start("setTimeout(()=>console.log('FINISHED'),120)");
    const result = await manager.wait({ processId: p.processId, until: "exit", timeoutMs: 10000 });
    assert.equal(result.waitReason, "exit"); assert.equal(result.exitCode, 0); assert(result.output.includes("FINISHED"));
    const immediate = await manager.wait({ processId: p.processId, until: "exit", timeoutMs: 10000 }); assert.equal(immediate.waitReason, "exit");
  });
  await test("output wakeup and cursor continue without losing bytes", async () => {
    const p = start("console.log('FIRST');setTimeout(()=>console.log('SECOND'),300)");
    const first = await manager.wait({ processId: p.processId, timeoutMs: 10000 });
    assert(first.output.includes("FIRST"));
    const rest = await manager.wait({ processId: p.processId, cursor: first.cursor, until: "exit", timeoutMs: 10000 });
    assert.equal(rest.exitCode, 0); assert((first.output + rest.output).includes("SECOND"));
  });
  await test("timeout is not an exit/failure and does not kill the process", async () => {
    const p = start("setTimeout(()=>console.log('LATER'),250)");
    const early = await manager.wait({ processId: p.processId, until: "exit", timeoutMs: 0 });
    assert.equal(early.waitReason, "timeout"); assert.equal(early.status, "running");
    assert.equal((await manager.wait({ processId: p.processId, until: "exit", timeoutMs: 10000 })).exitCode, 0);
  });
  await test("cancelled wait unsubscribes but does not secretly replay or kill a tool", async () => {
    const p = start("setTimeout(()=>console.log('LIVE'),300)"); const controller = new AbortController();
    const wait = manager.wait({ processId: p.processId, until: "exit", timeoutMs: 10000, signal: controller.signal });
    controller.abort(); await assert.rejects(wait, { name: "AbortError" });
    const ended = await manager.wait({ processId: p.processId, until: "exit", timeoutMs: 10000 }); assert.equal(ended.exitCode, 0);
  });
  await test("synchronous guidance callback releases listener and returns control", async () => {
    const p = start("setTimeout(()=>{},200)"); let unsubscribed = 0;
    const result = await manager.wait({ processId: p.processId, until: "exit", timeoutMs: 10000,
      onSteering(callback) { callback(); return () => unsubscribed++; } });
    assert.equal(result.waitReason, "guidance"); assert.equal(result.skipped, true); assert.equal(unsubscribed, 1);
    await manager.kill(p.processId);
  });
  await test("bounded parameters and closeAll release outstanding waiters", async () => {
    const p = start("setTimeout(()=>{},5000)");
    await assert.rejects(manager.wait({ processId: p.processId, timeoutMs: 120001 }), /invalid/i);
    await assert.rejects(manager.wait({ processId: p.processId, cursor: -1 }), /invalid/i);
    const waiting = manager.wait({ processId: p.processId, until: "exit", timeoutMs: 10000 });
    await manager.closeAll(); assert.equal((await waiting).waitReason, "stopping");
  });
} finally { await manager.closeAll(); }
const failure = (history, i) => history.observe({ callId: `fail-${i}`, tool: "run_command", input: { command: "npm test" }, result: { exitCode: 1, stderr: "AssertionError expected true, got false", timestamp: i } });
await test("same diagnostic across edits requires fresh evidence before another mutation", () => {
  const history = new StrategyHistory();
  for (let i = 0; i < 3; i++) { failure(history, i); history.observe({ callId: `write-${i}`, tool: "write_file", changes: [{ path: "a", afterContent: `v${i}` }], result: {} }); }
  assert(history.briefing().pending); assert.throws(() => history.before("write_file"), /REPLAN_REQUIRED/); history.before("read_file");
  assert.throws(() => history.replan({ hypothesis: "A different implementation may work now", evidence_call_ids: ["fake"] }), /FRESH_EVIDENCE/);
  history.observe({ callId: "diagnosis", tool: "read_file", input: { path: "b" }, result: { content: "Wrong default in configuration" } });
  const result = history.replan({ hypothesis: "Correct the configuration default rather than rewriting the consumer", evidence_call_ids: ["diagnosis"] });
  assert.equal(result.accepted, true); history.before("write_file");
});
await test("changing only an output reference is not new diagnostic evidence", () => {
  const history = new StrategyHistory();
  history.observe({ callId: "old", tool: "read_file", input: { path: "a" }, result: { content: "same", resultRef: "old" } });
  for (let i = 0; i < 3; i++) failure(history, i);
  history.observe({ callId: "repeated", tool: "read_file", input: { path: "a" }, result: { content: "same", resultRef: "new" } });
  assert.throws(() => history.replan({ hypothesis: "Try another strategy with this evidence", evidence_call_ids: ["repeated"] }), /FRESH_EVIDENCE/);
});
await test("alternating file contents trigger strategy check despite version changes", () => {
  const history = new StrategyHistory();
  for (const [index, content] of ["A", "B", "A", "B"].entries()) history.observe({ callId: `c-${index}`, tool: "apply_patch", changes: [{ path: "a", afterContent: content }], result: {} });
  assert.equal(history.briefing().pending.reason, "File oscillates between the same two versions");
  assert.throws(() => history.before("apply_patch"), /REPLAN_REQUIRED/);
});
await test("failed strategy history persists, while an explicit new direction resets it", () => {
  const first = new StrategyHistory(null, { maxInterventions: 1 });
  for (let i = 0; i < 3; i++) failure(first, i);
  first.observe({ callId: "new", tool: "search_text", input: { query: "missing" }, result: { matches: ["config"] } });
  first.replan({ hypothesis: "Inspect configuration instead of the original execution path", evidence_call_ids: ["new"] });
  const resumed = new StrategyHistory(first.snapshot(), { maxInterventions: 1 });
  for (let i = 0; i < 3; i++) failure(resumed, i);
  assert.throws(() => resumed.assertBudget(), /STRATEGY_EXHAUSTED/);
  resumed.reset(); resumed.assertBudget(); resumed.before("write_file");
});
await finish();
