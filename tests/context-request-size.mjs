import assert from "node:assert/strict";
import { callModelProvider } from "../electron/runtime/provider-stream.js";
import { completeLoopRequest } from "../electron/runtime/loop-recovery.js";
import { createTokenAccounting, compactConversationForRequest, estimateConversationTokens } from "../electron/agent-context.js";
import { taskRequest } from "../electron/runtime/task-conversation.js";
import { providerErrorCategory } from "../electron/runtime/provider-errors.js";

const originalFetch = globalThis.fetch;
const provider = { id: "fixture", name: "DeepSeek", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only" };
const sse = () => new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
const history = () => [ { role: "system", content: "stable" }, taskRequest({ role: "user", content: "DO_NOT_UPLOAD" }),
  ...Array.from({ length: 30 }, (_, i) => ({ role: "assistant", content: `${i} ` + "中".repeat(1000) })),
  taskRequest({ role: "user", content: "continue" }) ];
const infer = (conversation, p = provider, extra = {}) => completeLoopRequest({ conversation,
  contextCheckpoints: [], accounting: createTokenAccounting(), contextWindowTokens: 1_000_000,
  getBody: messages => ({ model: "fixture", messages }),
  complete: body => callModelProvider({ provider: p, body }), ...extra });
let cases = 0;
async function test(name, run) { await run(); cases++; console.log("PASS", name); }
try {
  for (const payload of ["<html>Request entity too large</html>", "Payload too large", '{"error":{"message":"Request too large"}}']) {
    await test(`413 ${payload.slice(0, 15)} shrinks the actual UTF-8 wire before retry`, async () => {
      const sizes = [], events = [];
      globalThis.fetch = async (_url, init) => {
        sizes.push(Buffer.byteLength(init.body));
        assert(JSON.parse(init.body).messages.some(m => m.content === "DO_NOT_UPLOAD"));
        return sizes.length === 1 ? new Response(payload, { status: 413 }) : sse();
      };
      const result = await infer(history(), provider, { onEvent: e => events.push(e) });
      assert.equal(result.message.content, "done"); assert.equal(sizes.length, 2);
      assert(sizes[1] <= sizes[0] * .70);
      assert.equal(events.filter(e => e.type === "response.recovery").length, 1);
    });
  }
  await test("body-limit errors do not depend on token overflow", () => {
    const conversation = history(); const before = structuredClone(conversation);
    assert(estimateConversationTokens(conversation) < 1_000_000 * .86);
    const measure = messages => Buffer.byteLength(JSON.stringify({ messages, tools: [{ description: "中".repeat(1000) }] }));
    const budget = Math.floor(measure(conversation) * .6);
    assert(compactConversationForRequest({ conversation, contextCheckpoints: [], contextWindowTokens: 1_000_000,
      inputBudgetBytes: budget, measureRequestBytes: measure }));
    assert(measure(conversation) <= budget); assert.equal(before.at(-1).content, conversation.at(-1).content);
  });
  await test("headroom is soft: protected images that fit the real limit are still usable", () => {
    const conversation = [{ role: "assistant", content: "A".repeat(4 * 1024 * 1024) },
      taskRequest({ role: "user", content: [{ type: "text", text: "inspect" },
        { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(6 * 1024 * 1024) } }] })];
    const image = conversation.at(-1).content[1].image_url.url;
    compactConversationForRequest({ conversation, contextCheckpoints: [], contextWindowTokens: 1_000_000,
      inputBudgetBytes: 8 * 1024 * 1024, targetInputBytes: Math.floor(8 * 1024 * 1024 * .7) });
    assert(Buffer.byteLength(JSON.stringify(conversation)) < 8 * 1024 * 1024);
    assert.equal(conversation.at(-1).content[1].image_url.url, image);
  });
  await test("oversized current image is preserved with an actionable error and no duplicate POST", async () => {
    let count = 0;
    globalThis.fetch = async () => { count++; return new Response("too large", { status: 413 }); };
    const conversation = [taskRequest({ role: "user", content: [{ type: "text", text: "analyze" },
      { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(100_000) } }] })];
    const before = JSON.stringify(conversation);
    await assert.rejects(infer(conversation), e => e.code === "PROVIDER_REQUEST_TOO_LARGE" && /拆分/.test(e.message));
    assert.equal(count, 1); assert.equal(JSON.stringify(conversation), before);
  });
  await test("irreducible tool definitions cannot spin or silently disappear", async () => {
    let count = 0;
    globalThis.fetch = async () => { count++; return new Response("too large", { status: 413 }); };
    const tools = [{ type: "function", function: { name: "tool", description: "A".repeat(200_000), parameters: { type: "object" } } }];
    const conversation = [taskRequest({ role: "user", content: "keep" })];
    await assert.rejects(infer(conversation, provider, { getBody: messages => ({ model: "fixture", messages, tools }) }), /PROVIDER_REQUEST_TOO_LARGE/);
    assert.equal(count, 1); assert.equal(conversation[0].content, "keep");
  });
  await test("Cloud 413 without a released no-dispatch receipt never gets a new generation", async () => {
    let count = 0;
    const cloud = { ...provider, kind: "aporia-cloud", authenticatedFetch: async () => { count++; return new Response("too large", { status: 413 }); } };
    await assert.rejects(infer(history(), cloud), e => e.safeToRepair === false && e.status === 413);
    assert.equal(count, 1);
  });
  await test("Cloud SSE 413 uses wire byte repair only with a released matching receipt", async () => {
    const sizes = [], id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const cloud = { ...provider, kind: "aporia-cloud", authenticatedFetch: async (_path, init) => {
      sizes.push(Buffer.byteLength(init.body));
      if (sizes.length > 1) return sse();
      const payload = { status: 413, error: { message: "APORIA_REQUEST_TOO_LARGE" }, requestId: id,
        request: { requestId: id, usageState: "not-dispatched", billing: "released", chargedMicros: 0 } };
      return new Response(`event: aporia_error\ndata: ${JSON.stringify(payload)}\n\n`, { headers: { "x-aporia-request-id": id } });
    } };
    assert.equal((await infer(history(), cloud)).message.content, "done");
    assert.equal(sizes.length, 2); assert(sizes[1] <= sizes[0] * .7);
  });
  await test("Cloud known 8 MiB limit is checked without transmitting the image", async () => {
    let count = 0;
    const cloud = { ...provider, kind: "aporia-cloud", authenticatedFetch: async () => { count++; throw Error("must not dispatch"); } };
    const conversation = [taskRequest({ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(9 * 1024 * 1024) } }] })];
    await assert.rejects(infer(conversation, cloud), /PROVIDER_REQUEST_TOO_LARGE/);
    assert.equal(count, 0);
  });
  await test("repeated 413 repair is bounded", async () => {
    let count = 0;
    globalThis.fetch = async () => { count++; return new Response("large", { status: 413 }); };
    await assert.rejects(infer(history())); assert(count >= 1 && count <= 3);
  });
  await test("repeated long tool/history growth compacts without losing original local text", () => {
    const original = [taskRequest({ role: "user", content: "MUST_NOT_UPLOAD_FILES" })];
    let conversation = structuredClone(original);
    const checkpoints = [];
    let count = 0;
    for (let round = 0; round < 60; round++) {
      const message = { role: "assistant", content: `round-${round} ` + "长对话资料".repeat(1100) };
      original.push(message); conversation.push(message);
      if (compactConversationForRequest({ conversation, contextCheckpoints: checkpoints, contextWindowTokens: 32000 })) count++;
      assert(estimateConversationTokens(conversation) <= 32000 - 8192);
      assert(conversation.some(m => m.content === "MUST_NOT_UPLOAD_FILES"));
      if (round === 30) conversation = JSON.parse(JSON.stringify(conversation)); // Saved compact working context.
    }
    assert(count > 3); assert.equal(original.length, 61);
    assert(original[1].content.startsWith("round-0 "));
    assert.equal(original[1].content.includes("contextCompacted"), false);
  });
  assert.equal(providerErrorCategory({ status: 413 }), "request-size");
  assert.equal(providerErrorCategory({ providerCode: "request_entity_too_large" }), "request-size");
} finally { globalThis.fetch = originalFetch; }
console.log(`Context request size: ${cases} cases PASS (mock transport only)`);
