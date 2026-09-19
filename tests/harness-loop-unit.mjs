import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { createTokenAccounting, estimateConversationTokens, recordProviderUsage, conciseToolEvidence,
  compactConversationForRequest, upsertRelevantContextMessage as coreRetrieval } from "../electron/agent-context-core.js";
import { mergeTokenUsage, upsertRelevantContextMessage } from "../electron/agent-context.js";
import { normalizeTokenUsage } from "../electron/runtime/token-usage.js";
import { compileModelRequest } from "../electron/runtime/request-compiler.js";
import { planToolBatches, executeToolBatch } from "../electron/runtime/tool-batch.js";
import { providerErrorCategory, providerRetryDelay, retryAfterMilliseconds } from "../electron/runtime/provider-errors.js";
import { CompletionPolicy, normalizeLoopPolicy } from "../electron/runtime/completion-policy.js";
import { ToolProgressGuard } from "../electron/runtime/tool-progress-guard.js";
import { LoopMetrics } from "../electron/runtime/loop-metrics.js";
import { taskRequest } from "../electron/runtime/task-conversation.js";

const results = [];
async function test(name, run) { await run(); results.push({ name, passed: true }); console.log("PASS", name); }
await test("calibration matches the same completed request without double overhead", () => {
  const messages = [{ role: "system", content: "rule" }, { role: "user", content: "x ".repeat(12000) }];
  const state = createTokenAccounting();
  const heuristic = estimateConversationTokens(messages);
  const observed = heuristic + 4000;
  recordProviderUsage(state, { prompt_tokens: observed }, messages);
  assert.equal(estimateConversationTokens(messages, state), observed);
  assert.equal(state.lastPromptTokens, observed);
  state.providerOverheadTokens += 1000;
  assert.equal(estimateConversationTokens(messages, state), observed + 1000);
  assert(estimateConversationTokens([...messages, { role: "assistant", content: "new " .repeat(300) }], state) > observed + 1000);
  results.push({ name: "calibration fixture", heuristic, providerPromptTokens: observed, estimatedAfterCalibration: observed, errorTokens: 0 });
});
await test("unchanged request calibration stays exact across multiple usage samples", () => {
  const state = createTokenAccounting(); state.providerOverheadTokens = 900;
  const messages = [taskRequest({ role: "user", content: "中文和 code test ".repeat(4000) })];
  const prompt = estimateConversationTokens(messages) + 1200;
  for (let i = 0; i < 5; i++) { recordProviderUsage(state, { prompt_tokens: prompt }, messages); assert.equal(estimateConversationTokens(messages, state), prompt); }
  const wire = messages.map(({ aporiaSource, aporiaPinned, ...message }) => message);
  assert.equal(estimateConversationTokens(wire, state), prompt, "local authority metadata is not token material");
  assert.equal(state.requests, 5);
});
await test("DeepSeek cache read and miss fields survive canonical aggregation", () => {
  const usage = { prompt_tokens: 10000, completion_tokens: 10, prompt_cache_hit_tokens: 8000, prompt_cache_miss_tokens: 2000 };
  const result = mergeTokenUsage(mergeTokenUsage(null, usage), usage);
  assert.equal(result.prompt_tokens, 20000); assert.equal(result.prompt_cache_hit_tokens, 16000); assert.equal(result.prompt_cache_miss_tokens, 4000);
});
await test("nested cached-token usage is a subset, not extra input", () => {
  const result = normalizeTokenUsage({ prompt_tokens: 10000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 8000 } });
  assert.equal(result.prompt_tokens, 10000); assert.equal(result.prompt_cache_hit_tokens, 8000); assert.equal(result.prompt_cache_miss_tokens, 2000);
});
await test("raw exclusive cache creation and cache read remain separate", () => {
  const result = normalizeTokenUsage({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000 });
  assert.equal(result.prompt_tokens, 10100); assert.equal(result.total_tokens, 10120);
  assert.equal(result.prompt_cache_miss_tokens, 100); assert.equal(result.cache_creation_input_tokens, 2000);
  assert.deepEqual(normalizeTokenUsage(result), result);
});
await test("unknown cache values are absent and mixed totals are labelled incomplete", () => {
  const unknown = mergeTokenUsage(null, { prompt_tokens: 10, completion_tokens: 1 });
  assert(!Object.hasOwn(unknown, "prompt_cache_hit_tokens"));
  const mixed = mergeTokenUsage(unknown, { prompt_tokens: 20, prompt_cache_hit_tokens: 8 });
  assert.equal(mixed.prompt_cache_hit_tokens, 8); assert.equal(mixed.cache_usage_incomplete, true);
  assert.equal(mixed.prompt_tokens, 30);
});
await test("core and public retrieval use the same stable-tail implementation", () => {
  assert.equal(coreRetrieval, upsertRelevantContextMessage);
  const messages = [{ role: "system", content: "stable rules" }, { role: "user", content: "ALPHA plan" }];
  const options = { memoryFacts: [{ content: "ALPHA plan uses local files" }] };
  upsertRelevantContextMessage(messages, options);
  assert.equal(messages[0].content, "stable rules"); assert.equal(messages.at(-1).aporiaSource, "retrieval");
  const first = JSON.stringify(messages); upsertRelevantContextMessage(messages, options); assert.equal(JSON.stringify(messages), first);
  upsertRelevantContextMessage(messages, { memoryFacts: [] }); assert.equal(messages.length, 2, "removed knowledge must not remain frozen in a prefix");
});
await test("compiler sorts tool schemas without rewriting request history", () => {
  const messages = [taskRequest({ role: "user", content: "do not upload" })];
  const tools = [{ function: { name: "z" } }, { function: { name: "a" } }];
  const request = { model: "fixture", messages, tools }, original = JSON.stringify(request);
  const compiled = compileModelRequest(request);
  assert.deepEqual(compiled.tools.map((tool) => tool.function.name), ["a", "z"]);
  assert.equal(compiled.messages[0].content, "do not upload"); assert(!("aporiaSource" in compiled.messages[0]));
  assert.equal(JSON.stringify(request), original);
});
await test("failure checkpoint preserves assertion, stack, hash and original-result reference", () => {
  const value = conciseToolEvidence({ tool_call_id: "failed-check", content: JSON.stringify({ command: "npm test", exitCode: 1,
    stdout: "AUTH_CHECK_FAILED expected expiry 60 got 0", stderr: "stack at auth.test.js:42", sha256: "hash",
    resultRef: { id: "ref", readTool: "mcp_read_result" } }) });
  assert.match(value.diagnostic.stdout, /expected expiry 60/); assert.match(value.diagnostic.stderr, /auth.test.js:42/);
  assert.equal(value.toolCallId, "failed-check"); assert.equal(value.resultRef.id, "ref"); assert.equal(value.sha256, "hash");
});
await test("oversized diagnostics retain both bounded head and tail", () => {
  const item = conciseToolEvidence({ content: JSON.stringify({ error: "failure", stdout: "FIRST" + "x".repeat(20000) + "LAST" }) });
  assert(item.diagnostic.stdout.length <= 2450); assert.match(item.diagnostic.stdout, /^FIRST/); assert.match(item.diagnostic.stdout, /LAST$/);
});
await test("archived old output prunes before dropping protocol or requirements", () => {
  const originalText = "中".repeat(22000);
  const history = [{ role: "system", content: "stable rules" }, taskRequest({ role: "user", content: "MUST NOT UPLOAD" }),
    { role: "assistant", content: null, tool_calls: [{ id: "large", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
    { role: "tool", tool_call_id: "large", content: JSON.stringify({ content: originalText, resultRef: { id: "reference", readTool: "mcp_read_result" } }) },
    ...Array.from({ length: 10 }, (_, i) => ({ role: "assistant", content: "recent-" + i })), taskRequest({ role: "user", content: "continue" })];
  const before = history[3].content;
  const checkpoint = compactConversationForRequest({ conversation: history, contextCheckpoints: [], contextWindowTokens: 32000, inputBudgetTokens: 15000 });
  assert.equal(checkpoint.prunedToolOutputs, 1); assert.equal(history[0].content, "stable rules");
  assert(history.some((message) => message.content === "MUST NOT UPLOAD"));
  assert(history[3].content.length < before.length / 10); assert.match(history[3].content, /reference/);
  assert.equal(history[2].tool_calls[0].id, history[3].tool_call_id);
});
await test("compaction cannot silently truncate an oversized pinned request", () => {
  const history = [{ role: "system", content: "rules" }, taskRequest({ role: "user", content: "中".repeat(40000) })];
  const before = JSON.stringify(history);
  assert.throws(() => compactConversationForRequest({ conversation: history, contextCheckpoints: [], contextWindowTokens: 32000 }), /CONTEXT_BUDGET_EXCEEDED/);
  assert.equal(JSON.stringify(history), before);
});
await test("read-read-write-read pools preserve barriers and declared order", async () => {
  const calls = ["r1", "r2", "r3", "r4", "w", "r5", "r6", "r7"];
  const batches = planToolBatches(calls, (call) => call.startsWith("r"));
  assert.deepEqual(batches.map((batch) => batch.calls.length), [4, 1, 3]);
  let active = 0, peak = 0, written = false; const output = [];
  for (const batch of batches) output.push(...await executeToolBatch(batch.calls, batch.parallel ? 4 : 1, async (call) => {
    if (call === "w") { assert.equal(active, 0); written = true; return call; }
    assert.equal(written, Number(call.slice(1)) >= 5);
    peak = Math.max(peak, ++active); await sleep(3); active--; return call;
  }));
  assert.deepEqual(output, calls); assert.equal(peak, 4);
  results.push({ name: "equal-duration scheduling model (not wall-clock benchmark)", serialUnits: 8, barrierUnits: 3, reductionPercent: 62.5 });
});
await test("first worker failure stops admission and joins other active workers", async () => {
  const started = [], settled = [];
  await assert.rejects(executeToolBatch([0, 1, 2, 3], 2, async (id) => {
    started.push(id); if (id === 0) { await sleep(2); throw new Error("fixture failure"); }
    await sleep(15); settled.push(id); return id;
  }), /fixture failure/);
  assert.deepEqual(started, [0, 1]); assert.deepEqual(settled, [1]);
});
await test("cancellation drains active workers without starting remaining calls", async () => {
  const controller = new AbortController(); const started = [], settled = [];
  await assert.rejects(executeToolBatch([0, 1, 2], 2, async (id) => {
    started.push(id); await sleep(id === 0 ? 2 : 10); if (id === 0) controller.abort(); settled.push(id); return id;
  }, { signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(started, [0, 1]); assert.equal(settled.length, 2);
});
await test("volatile result references do not hide repeated evidence", () => {
  const guard = new ToolProgressGuard(); let warnings = 0;
  for (let i = 0; i < 12; i++) if (guard.observe({ tool: "search_text", input: { query: "same" }, result: { matches: [], resultRef: { id: "unique-" + i } } })) warnings++;
  assert.equal(warnings, 4); assert.equal(guard.lastDecision.action, "replan"); guard.assertBudget();
});
await test("explicit progress budget blocks next inference and guidance resets it", () => {
  const guard = new ToolProgressGuard({ maxRepeatedEvidence: 4 });
  for (let i = 0; i < 4; i++) guard.observe({ tool: "read_file", input: { path: "a" }, result: { content: "same" } });
  assert.throws(() => guard.assertBudget(), /LOOP_NO_PROGRESS/); guard.reset(); guard.assertBudget();
});
await test("quiet process polling warns but is never hard-stopped as repeated evidence", () => {
  const guard = new ToolProgressGuard({ maxRepeatedEvidence: 3 }); let warnings = 0;
  for (let i = 0; i < 12; i++) if (guard.observe({ tool: "read_process", input: { process_id: "p", cursor: 1 }, result: { processId: "p", status: "running", cursor: 1, output: "" } })) warnings++;
  assert.equal(warnings, 2); guard.assertBudget();
  assert.equal(guard.observe({ tool: "read_process", input: { process_id: "p", cursor: 1 }, result: { processId: "p", cursor: 20, output: "new output" } }), null);
});
await test("server retry delay and HTTP date are respected with bounded jitter", () => {
  assert.equal(retryAfterMilliseconds(new Headers({ "retry-after": "2" })), 2000);
  assert.equal(retryAfterMilliseconds(new Headers({ "retry-after-ms": "30" })), 30);
  assert.equal(retryAfterMilliseconds(new Headers({ "retry-after": "Fri, 18 Sep 2026 12:00:02 GMT" }), Date.parse("2026-09-18T12:00:00Z")), 2000);
  assert.equal(providerRetryDelay(1, 2000, () => 0), 2000);
  assert.equal(providerRetryDelay(1, null, () => 1), 938);
  assert.equal(providerErrorCategory({ status: 429, code: "insufficient_quota" }), "quota");
  assert.equal(providerErrorCategory({ status: 400, code: "context_length_exceeded" }), "context");
});
await test("completion defaults do not force verification; explicit policy is bounded", () => {
  const input = { changes: [{ path: "a" }], assessment: { passed: false, status: "unverified" } };
  assert.equal(new CompletionPolicy().evaluate(input).action, "deliver");
  const policy = new CompletionPolicy({ requireVerifiedChanges: true, maxCompletionContinuations: 1 });
  assert.equal(policy.evaluate(input).action, "continue"); assert.equal(policy.evaluate(input).status, "partial");
  policy.reset(); assert.equal(policy.evaluate(input).action, "continue");
  assert.equal(policy.evaluate({ ...input, assessment: { waived: true } }).status, "completed");
  assert.equal(policy.evaluate({ ...input, status: "blocked" }).status, "blocked");
  assert.throws(() => normalizeLoopPolicy({ requireVerifiedChanges: "false" }), /boolean/);
});
await test("metrics hold counters and hashes internally, not prompt text", () => {
  const metrics = new LoopMetrics(); const body = { model: "fixture", messages: [{ role: "user", content: "private fixture content" }] };
  metrics.request(body); metrics.request({ ...body, messages: [...body.messages, { role: "assistant", content: "more" }] });
  metrics.observe({ type: "response.attempt.started" }); metrics.observe({ type: "response.attempt.completed", status: "completed", durationMs: 7, usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 8 } } });
  const result = metrics.snapshot(); assert.equal(result.unchangedLeadingMessages, 1); assert.equal(result.attempts, 1);
  assert.equal(result.usage.prompt_cache_hit_tokens, 8); assert(!JSON.stringify(result).includes("private fixture"));
});
await mkdir(".tmp/audit-results", { recursive: true });
await writeFile(".tmp/audit-results/harness-loop-unit.json", JSON.stringify({ node: process.version, cases: results.filter((item) => item.passed).length, results }, null, 2));
console.log(`Harness loop unit: ${results.filter((item) => item.passed).length} cases PASS`);
