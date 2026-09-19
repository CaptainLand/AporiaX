import assert from "node:assert/strict";
import { compileProviderWire } from "../electron/runtime/native-provider-codec.js";
import { callModelProvider } from "../electron/runtime/provider-stream.js";
import { normalizeProviderInput, publicProviderSummary, discoverProviderModels } from "../electron/provider-config.js";
import { conversationTokenMaterial } from "../electron/runtime/multimodal-budget.js";
import { suite, provider as base, call, sse, eventsResponse, anthropicEvents, responsesEvents, outputText } from "./goal-loop-fixtures.mjs";
const { test, finish } = suite("goal-native-provider");
const originalFetch = globalThis.fetch;
const tool = { type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } };
const body = { model: "fixture", messages: [{ role: "system", content: "system rules" }, { role: "user", content: "read a" }], tools: [tool] };
const anthro = { ...base, vendor: "anthropic", protocol: "anthropic-messages" };
const responses = { ...base, vendor: "openai", protocol: "responses" };
const deepseek = { ...base, protocol: "deepseek-chat" };
try {
  await test("old profiles stay compatible; explicit native choices survive normalization and public form", () => {
    const old = normalizeProviderInput({ baseUrl: "https://api.openai.com/v1", models: ["gpt-5"] });
    assert.equal(old.protocol, "chat-completions");
    const next = normalizeProviderInput({ ...old, protocol: "responses", maxOutputTokens: 4096 });
    assert.equal(publicProviderSummary(next).protocol, "responses"); assert.equal(publicProviderSummary(next).maxOutputTokens, 4096);
    const edited = normalizeProviderInput({ baseUrl: next.baseUrl, models: ["gpt-5"] }, next); assert.equal(edited.protocol, "responses");
    assert.throws(() => normalizeProviderInput({ ...old, protocol: "invented" }), /UNSUPPORTED/);
    assert.throws(() => normalizeProviderInput({ ...old, protocol: "anthropic-messages", anthropicThinking: "manual", thinkingBudget: 4096, maxOutputTokens: 4096 }), /budget/);
  });
  await test("Responses requests use native endpoint, flat functions, stateless encrypted continuation", () => {
    const wire = compileProviderWire(responses, body);
    assert.equal(wire.url, "https://fixture.invalid/v1/responses"); assert.equal(wire.headers.Authorization, "Bearer fixture-only");
    assert.equal(wire.body.store, false); assert.deepEqual(wire.body.include, ["reasoning.encrypted_content"]);
    assert.equal(wire.body.tools[0].name, "read_file"); assert.equal(wire.body.tools[0].strict, false);
    assert.equal(wire.body.messages, undefined); assert.equal(wire.body.input[0].role, "system");
    assert.equal(compileProviderWire({ ...responses, baseUrl: wire.url }, body).url, wire.url);
  });
  await test("Messages requests preserve tool pairing, mixed content and explicit adaptive/manual thinking", () => {
    const b = { ...body, reasoning_effort: "high", messages: [...body.messages,
      { role: "assistant", content: "checking", tool_calls: [call("one", "read_file", { path: "a" })] }, { role: "tool", tool_call_id: "one", content: '{"error":"missing"}' },
      { role: "system", content: "untrusted retrieval" }, { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] };
    const wire = compileProviderWire(anthro, b);
    assert.equal(wire.headers["x-api-key"], "fixture-only"); assert.equal(wire.headers.Authorization, undefined);
    assert.equal(wire.body.thinking.type, "adaptive"); assert.equal(wire.body.output_config.effort, "high");
    assert.equal(wire.body.system.length, 1); assert(!JSON.stringify(wire.body.system).includes("untrusted retrieval"));
    const last = wire.body.messages.at(-1); assert.equal(last.role, "user"); assert.equal(last.content[0].tool_use_id, "one"); assert.equal(last.content[0].is_error, true);
    assert.equal(last.content.at(-1).source.type, "base64");
    const manual = compileProviderWire({ ...anthro, anthropicThinking: "manual", thinkingBudget: 2048 }, b);
    assert.deepEqual(manual.body.thinking, { type: "enabled", budget_tokens: 2048 });
    assert.throws(() => compileProviderWire({ ...anthro, anthropicThinking: "manual", thinkingBudget: 8192 }, b), /BUDGET/);
  });
  await test("Anthropic stream round-trips signed blocks without displaying private state", async () => {
    const blocks = [{ type: "thinking", thinking: "synthetic-private-state", signature: "synthetic-signature" }, { type: "text", text: "Reading." }, { type: "tool_use", id: "one", name: "read_file", input: { path: "a" } }];
    const events = [];
    globalThis.fetch = async (url, init) => { assert.equal(String(url), "https://fixture.invalid/v1/messages"); assert.equal(init.headers["x-api-key"], "fixture-only"); return eventsResponse(anthropicEvents(blocks, "tool_use")); };
    const result = await callModelProvider({ provider: anthro, body, onEvent: (event) => events.push(event) });
    assert.equal(result.message.content, "Reading."); assert.equal(result.message.tool_calls[0].function.arguments, '{"path":"a"}');
    assert(!JSON.stringify(events).includes("synthetic-private-state")); assert(!JSON.stringify(events).includes("synthetic-signature"));
    assert.equal(result.usage.input_tokens, 10); assert.equal(result.usage.output_tokens, 8);
    const next = compileProviderWire(anthro, { ...body, messages: [...body.messages, { role: "assistant", ...result.message }, { role: "tool", tool_call_id: "one", content: "file text" }] });
    assert.deepEqual(next.body.messages.at(-2).content, blocks);
    assert.equal(next.body.messages.at(-1).content[0].tool_use_id, "one");
  });
  await test("Responses stream replays exact reasoning/function output and maps call_id, not item id", async () => {
    const output = [{ type: "reasoning", id: "rs", summary: [], encrypted_content: "private-encrypted-fixture" }, { type: "function_call", id: "fc_item", call_id: "call_one", name: "read_file", arguments: '{"path":"a"}', status: "completed" }];
    const events = [];
    globalThis.fetch = async () => eventsResponse(responsesEvents(output));
    const result = await callModelProvider({ provider: responses, body, onEvent: (event) => events.push(event) });
    assert.equal(result.message.tool_calls[0].id, "call_one"); assert(!JSON.stringify(events).includes("private-encrypted-fixture"));
    const next = compileProviderWire(responses, { ...body, messages: [...body.messages, { role: "assistant", ...result.message }, { role: "tool", tool_call_id: "call_one", content: '{"content":"a"}' }] });
    assert.deepEqual(next.body.input.slice(2, 4), output); assert.equal(next.body.input.at(-1).type, "function_call_output"); assert.equal(next.body.input.at(-1).call_id, "call_one");
  });
  await test("opaque native continuation cannot move to another provider, model or protocol", async () => {
    globalThis.fetch = async () => eventsResponse(responsesEvents([outputText("Answer")]));
    const { message } = await callModelProvider({ provider: responses, body });
    const request = { ...body, messages: [...body.messages, { role: "assistant", ...message }] };
    for (const other of [{ ...responses, baseUrl: "https://other.invalid/v1" }, { ...responses, id: "different" }, anthro, deepseek])
      assert.throws(() => compileProviderWire(other, request), /STATE_MISMATCH/);
    assert.throws(() => compileProviderWire(responses, { ...request, model: "other-model" }), /STATE_MISMATCH/);
    assert.throws(() => compileProviderWire(responses, { ...request, messages: [...body.messages, { role: "assistant", ...message, content: "edited" }] }), /STATE_MISMATCH/);
  });
  await test("private encoded state is not double-counted as public text or image bytes", () => {
    const message = { role: "assistant", content: "answer", aporiaNative: { items: [{ encrypted_content: "A".repeat(300000) }], outputTokens: 40 } };
    const small = conversationTokenMaterial([message]); message.aporiaNative.items[0].encrypted_content = "A".repeat(3000000);
    const big = conversationTokenMaterial([message]); assert.equal(small.serialized.length, big.serialized.length); assert.equal(big.imageTokens, 40);
    assert(!big.serialized.includes("encrypted_content"));
  });
  await test("native missing terminal and incomplete tool blocks never become valid tool calls", async () => {
    globalThis.fetch = async () => eventsResponse(anthropicEvents([{ type: "tool_use", id: "x", name: "read_file", input: { path: "a" } }], "tool_use").slice(0, -1));
    await assert.rejects(callModelProvider({ provider: anthro, body }), /INCOMPLETE/);
    globalThis.fetch = async () => eventsResponse([{ type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "x", name: "read_file", arguments: "{}" } }]);
    await assert.rejects(callModelProvider({ provider: responses, body }), /INCOMPLETE/);
  });
  await test("duplicate IDs, malformed arguments and truncated tools are rejected by common guard", async () => {
    for (const output of [
      [0, 1].map(() => ({ type: "function_call", call_id: "duplicate", name: "read_file", arguments: "{}" })),
      [{ type: "function_call", call_id: "x", name: "read_file", arguments: "not JSON" }],
    ]) { globalThis.fetch = async () => eventsResponse(responsesEvents(output)); await assert.rejects(callModelProvider({ provider: responses, body }), /TOOL_CALL_INCOMPLETE/); }
    globalThis.fetch = async () => eventsResponse(responsesEvents([{ type: "function_call", call_id: "x", name: "read_file", arguments: "{}" }], "response.incomplete"));
    await assert.rejects(callModelProvider({ provider: responses, body }), (error) => error.partialToolCalls && /LENGTH/.test(error.message));
  });
  await test("block sequence and unsupported native server actions fail closed", async () => {
    globalThis.fetch = async () => eventsResponse([{ type: "content_block_start", index: 0, content_block: { type: "text", text: "without message start" } }]);
    await assert.rejects(callModelProvider({ provider: anthro, body }), /SEQUENCE_INVALID/);
    globalThis.fetch = async () => eventsResponse(responsesEvents([{ type: "web_search_call", id: "server-action" }]));
    await assert.rejects(callModelProvider({ provider: responses, body }), /OUTPUT_UNSUPPORTED/);
  });
  await test("DeepSeek thinking content is kept for tool continuation, not leaked to generic chat", async () => {
    globalThis.fetch = async (_url, init) => { const sent = JSON.parse(init.body); assert.equal(sent.stream_options.include_usage, true);
      return sse({ reasoning_content: "synthetic-private-deepseek", tool_calls: [{ index: 0, ...call("deepseek-call", "read_file", { path: "a" }) }] }, "tool_calls"); };
    const result = await callModelProvider({ provider: deepseek, body });
    const b = { ...body, messages: [...body.messages, { role: "assistant", ...result.message }, { role: "tool", tool_call_id: "deepseek-call", content: "A" }] };
    assert.equal(compileProviderWire(deepseek, b).body.messages.at(-2).reasoning_content, "synthetic-private-deepseek");
    assert.equal(compileProviderWire({ ...base, vendor: "custom" }, b).body.messages.at(-2).reasoning_content, undefined);
  });
  await test("native authorization/quota errors use existing no-retry classification", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('{"error":{"type":"authentication_error","message":"invalid api key"}}', { status: 401 }); };
    await assert.rejects(callModelProvider({ provider: anthro, body }), (error) => error.category === "authorization"); assert.equal(calls, 1);
  });
  await test("native cancellation aborts the selected request without trying another provider", async () => {
    const controller = new AbortController(); let cancelled = false, count = 0;
    globalThis.fetch = async (_url, init) => {
      count++;
      return new Response(new ReadableStream({ start(stream) {
        init.signal.addEventListener("abort", () => { cancelled = true; stream.error(Object.assign(new Error("cancelled"), { name: "AbortError" })); }, { once: true });
        stream.enqueue(new TextEncoder().encode('data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n'));
        setTimeout(() => controller.abort(), 10);
      } }));
    };
    await assert.rejects(callModelProvider({ provider: anthro, body, signal: controller.signal }), { name: "AbortError" });
    assert.equal(cancelled, true); assert.equal(count, 1);
  });
  await test("Anthropic discovery uses the chosen auth protocol; cloud cannot change its managed protocol", async () => {
    globalThis.fetch = async (url, init) => { assert(String(url).endsWith("/models")); assert.equal(init.headers["x-api-key"], "fixture-only"); assert.equal(init.headers.Authorization, undefined); return new Response('{"data":[{"id":"claude-fixture"}]}', { headers: { "content-type": "application/json" } }); };
    const models = await discoverProviderModels({ baseUrl: "https://api.anthropic.com/v1", apiKey: "fixture-only", protocol: "anthropic-messages" });
    assert.equal(models.models[0].id, "claude-fixture");
    assert.throws(() => compileProviderWire({ ...anthro, kind: "aporia-cloud" }, body), /MANAGED/);
  });
  await test("native terminal completes and cancels a kept-alive stream without waiting for EOF", async () => {
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(responsesEvents([outputText("terminal")]).map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
    const result = await callModelProvider({ provider: responses, body, signal: AbortSignal.timeout(2000) });
    assert.equal(result.message.content, "terminal"); assert.equal(cancelled, true);
  });
} finally { globalThis.fetch = originalFetch; }
await finish();
