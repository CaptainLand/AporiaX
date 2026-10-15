import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { callModelProvider } from "../electron/runtime/provider-stream.js";
import { completeLoopRequest } from "../electron/runtime/loop-recovery.js";
import { createTokenAccounting } from "../electron/agent-context.js";
import { taskRequest } from "../electron/runtime/task-conversation.js";

const originalFetch = globalThis.fetch;
const provider = { id: "fixture", name: "Fixture", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only" };
const results = [];
async function test(name, run) { await run(); results.push({ name, passed: true }); console.log("PASS", name); }
function sse(delta, finish = "stop", usage = { prompt_tokens: 20, completion_tokens: 3 }) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
const body = { model: "fixture", messages: [{ role: "user", content: "fixture" }] };
function loop(conversation, options = {}) {
  return completeLoopRequest({ conversation, contextCheckpoints: [], accounting: createTokenAccounting(), contextWindowTokens: 64000,
    getBody: (messages) => ({ model: "fixture", messages }), complete: (request) => callModelProvider({ provider, body: request }), ...options });
}
try {
  await test("rate-limit waits at least Retry-After before its bounded retry", async () => {
    const attempts = [], events = [];
    globalThis.fetch = async () => {
      attempts.push(performance.now());
      if (attempts.length === 1) return new Response(JSON.stringify({ error: { code: "rate_limit", message: "rate limit" } }), { status: 429, headers: { "retry-after": "1" } });
      return sse({ content: "done" });
    };
    const result = await callModelProvider({ provider, body, onEvent: (event) => events.push(event) });
    assert.equal(attempts.length, 2); assert(attempts[1] - attempts[0] >= 980);
    assert.equal(result.message.content, "done"); assert.equal(events.filter((event) => event.type === "response.retry").length, 1);
  });
  await test("excessive server delay is deferred rather than ignored", async () => {
    let requests = 0;
    globalThis.fetch = async () => { requests++; return new Response('{"error":{"message":"busy"}}', { status: 429, headers: { "retry-after": "3600" } }); };
    await assert.rejects(callModelProvider({ provider, body }), (error) => error.retryDeferred === true);
    assert.equal(requests, 1);
  });
  await test("quota and authorization never retry even if HTTP status says 429", async () => {
    let requests = 0;
    globalThis.fetch = async () => { requests++; return new Response('{"error":{"code":"insufficient_quota","message":"no balance"}}', { status: 429 }); };
    await assert.rejects(callModelProvider({ provider, body }), (error) => error.category === "quota"); assert.equal(requests, 1);
  });
  await test("cancelling a Retry-After wait prevents the next fetch", async () => {
    let requests = 0; const controller = new AbortController();
    globalThis.fetch = async () => { requests++; return new Response('{"error":{"message":"busy"}}', { status: 429, headers: { "retry-after": "60" } }); };
    await assert.rejects(callModelProvider({ provider, body, signal: controller.signal,
      onEvent: (event) => { if (event.type === "response.retry") controller.abort(); } }), { name: "AbortError" });
    assert.equal(requests, 1);
  });
  await test("context overflow retries only after a smaller request preserving pinned requirements", async () => {
    const conversation = [{ role: "system", content: "stable rules" }, taskRequest({ role: "user", content: "MUST_NOT_UPLOAD" }),
      ...Array.from({ length: 30 }, (_, index) => ({ role: "assistant", content: `old-${index} ` + "中".repeat(1000) })), taskRequest({ role: "user", content: "continue" })];
    const sizes = []; let saved = 0;
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(init.body); sizes.push(JSON.stringify(request.messages).length);
      assert(request.messages.some((message) => message.content === "MUST_NOT_UPLOAD"));
      if (sizes.length === 1) return new Response('{"error":{"code":"context_length_exceeded","message":"maximum context length exceeded"}}', { status: 400 });
      return sse({ content: "done" });
    };
    const result = await loop(conversation, { persist: async () => { saved++; } });
    assert.equal(result.message.content, "done"); assert.equal(sizes.length, 2); assert(sizes[1] < sizes[0]); assert.equal(saved, 1);
  });
  await test("unchangeable oversized user input does not cause repeated compaction requests", async () => {
    let requests = 0; const conversation = [taskRequest({ role: "user", content: "中".repeat(20000) })];
    const original = JSON.stringify(conversation);
    globalThis.fetch = async () => { requests++; return new Response('{"error":{"code":"context_length_exceeded"}}', { status: 400 }); };
    await assert.rejects(loop(conversation), /CONTEXT_BUDGET_EXCEEDED/);
    assert.equal(requests, 1); assert.equal(JSON.stringify(conversation), original);
  });
  await test("text-only output limit continues once and returns both parts", async () => {
    let requests = 0; const failures = [];
    globalThis.fetch = async (_url, init) => {
      requests++;
      if (requests === 1) return sse({ content: "FIRST_PART" }, "length", { prompt_tokens: 10, completion_tokens: 5 });
      const request = JSON.parse(init.body); assert(request.messages.some((message) => message.content === "FIRST_PART"));
      return sse({ content: "SECOND_PART" });
    };
    const result = await loop([taskRequest({ role: "user", content: "answer" })], { onFailedUsage: (usage) => failures.push(usage) });
    assert.equal(result.message.content, "FIRST_PART\nSECOND_PART"); assert.equal(requests, 2); assert.equal(failures[0].prompt_tokens, 10);
  });
  await test("truncated tool calls are discarded and inference repair is bounded once", async () => {
    let requests = 0;
    globalThis.fetch = async () => { requests++; return sse({ tool_calls: [{ index: 0, id: "partial", function: { name: "write_file", arguments: '{"path":"a",' } }] }, "length"); };
    await assert.rejects(loop([taskRequest({ role: "user", content: "write" })]), /PROVIDER_FINISH_LENGTH/); assert.equal(requests, 2);
  });
  await test("fully terminated invalid tool arguments get one inference repair with no execution", async () => {
    let requests = 0;
    globalThis.fetch = async (_url, init) => {
      requests++;
      if (requests === 1) return sse({ tool_calls: [{ index: 0, id: "invalid", function: { name: "read_file", arguments: "[]" } }] }, "tool_calls");
      const request = JSON.parse(init.body); assert(!request.messages.some((message) => message.tool_calls?.length));
      assert(request.messages.some((message) => String(message.content).includes("NONE of its tool calls were executed")));
      return sse({ content: "blocked without execution" });
    };
    const result = await loop([taskRequest({ role: "user", content: "inspect" })]);
    assert.equal(requests, 2); assert.equal(result.message.content, "blocked without execution");
  });
  await test("duplicate call IDs are invalid and repair cannot loop forever", async () => {
    let requests = 0;
    globalThis.fetch = async () => { requests++; return sse({ tool_calls: [0, 1].map((index) => ({ index, id: "duplicate", function: { name: "read_file", arguments: '{}' } })) }, "tool_calls"); };
    await assert.rejects(loop([taskRequest({ role: "user", content: "inspect" })]), /PROVIDER_TOOL_CALL_INCOMPLETE/); assert.equal(requests, 2);
  });
  await test("steering at a recovery boundary yields before a second model request", async () => {
    let requests = 0, steering = false;
    globalThis.fetch = async () => { requests++; return sse({ content: "PARTIAL" }, "length"); };
    const result = await loop([taskRequest({ role: "user", content: "answer" })], { persist: async () => { steering = true; }, shouldYield: () => steering });
    assert.equal(result.interrupted, true); assert.equal(requests, 1);
  });
} finally { globalThis.fetch = originalFetch; }
await mkdir(".tmp/audit-results", { recursive: true });
await writeFile(".tmp/audit-results/harness-loop-provider.json", JSON.stringify({ node: process.version, cases: results.length, results }, null, 2));
console.log(`Harness loop provider: ${results.length} cases PASS`);
