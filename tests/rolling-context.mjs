import assert from "node:assert/strict";
import { RollingContext } from "../electron/runtime/rolling-context.js";
import { estimateConversationTokens, compactConversationForRequest } from "../electron/agent-context.js";
import { providerMessages } from "../electron/runtime/task-conversation.js";
import { readConversationHistory } from "../electron/runtime/conversation-history.js";
import { currentLoopRequestIdentity } from "../electron/runtime/cloud-request-identity.js";
import { withDurableRun } from "../electron/runtime/durable-run.js";
import { createRunControl } from "../electron/runtime/run-control.js";
import { compileProviderWire } from "../electron/runtime/native-provider-codec.js";

const historyFixture = () => [
  { role: "user", content: "Never publish code or upload private files. 所有结果只在本机保存。" },
  ...Array.from({ length: 50 }, (_, index) => [
    { role: "user", content: `历史请求${index}：` + "分析这个模块的数据和实现细节。".repeat(60) },
    { role: "assistant", content: `历史结果${index}：` + "已检查实现，测试尚未完成。".repeat(60) },
  ]).flat(),
  { role: "user", content: "现在继续处理当前问题 CURRENT_REQUEST" },
];
function setup(history = historyFixture(), state = {}) {
  const originals = structuredClone(history);
  const conversation = [{ role: "system", content: "Stable system rules" }, ...history.map((message, index) =>
    ({ ...message, aporiaHistoryIndex: index, ...(message.role === "user" ? { aporiaPinned: true } : {}) }))];
  const controller = new RollingContext({ ownerKey: "fixture-task", history, ...state });
  controller.project(conversation);
  return { controller, conversation, history, originals };
}
let calls = 0, usageCalls = 0;
const provider = { id: "same-provider", async complete({ body, signal, onStreamEvent }) {
  calls++;
  assert.equal(body.model, "same-model"); assert.equal(body.tools, undefined);
  assert(body.max_tokens <= 3072);
  assert.match(currentLoopRequestIdentity().scopeId, /^rolling-summary:/);
  const data = JSON.parse(body.messages[1].content);
  assert(!JSON.stringify(body).includes("HIDDEN_REASONING"));
  signal?.throwIfAborted();
  onStreamEvent?.({ type: "response.delta", delta: "INTERNAL_SUMMARY" });
  return { message: { content: JSON.stringify({ revision: data.revision,
    covered_ids: data.sources.map(source => source.id), constraints: [],
    summary: "Earlier implementation was inspected; tests remain unverified. Continue only the latest user request. No publication was authorized." }) },
    finishReason: "stop", usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } };
} };
const run = (fixture, extra = {}) => fixture.controller.compact({ ...fixture, provider, modelId: "same-model",
  contextWindowTokens: 32000, onUsage: async () => { usageCalls++; }, ...extra });
let cases = 0;
async function test(name, fn) { await fn(); cases++; console.log("PASS", name); }

await test("bounded same-model summaries preserve originals, explicit constraints and current request", async () => {
  const fixture = setup(), events = [], before = estimateConversationTokens(fixture.conversation);
  await run(fixture, { onEvent: event => events.push(event) });
  assert(fixture.controller.snapshot().revision > 1);
  assert(estimateConversationTokens(fixture.conversation) < before * .5);
  assert(fixture.conversation.some(message => message.content === fixture.originals[0].content));
  assert(fixture.conversation.some(message => message.content.includes?.("CURRENT_REQUEST")));
  assert.deepEqual(fixture.history, fixture.originals);
  assert.equal(readConversationHistory(fixture.history, { message_index: 1, limit: 12000 }).text, fixture.originals[1].content);
  assert(!events.some(event => event.delta === "INTERNAL_SUMMARY"));
  assert.equal(calls, usageCalls);
  assert(providerMessages(fixture.conversation).every(message => !Object.keys(message).some(key => key.startsWith("aporia"))));
  compactConversationForRequest({ conversation: fixture.conversation, contextCheckpoints: [], contextWindowTokens: 32000 });
  assert(fixture.conversation.some(message => message.aporiaRollingContext));
});

await test("ordinary next turn reuses verified projection, edits and different tasks invalidate it", async () => {
  const fixture = setup(); await run(fixture);
  const handoff = JSON.parse(JSON.stringify(fixture.controller.handoff(fixture.originals)));
  const history = [...fixture.originals, { role: "assistant", content: "Last run finished." }, { role: "user", content: "A new follow-up." }];
  const next = setup(history, { handoff });
  assert.equal(next.controller.snapshot().revision, handoff.revision);
  assert(next.conversation.length < history.length / 2);
  const edited = structuredClone(history); edited[1].content += "USER_EDIT";
  assert.equal(setup(edited, { handoff }).controller.snapshot().revision, 0);
  assert.equal(setup(history, { handoff: { ...handoff, ownerKey: "other-task" } }).controller.snapshot().revision, 0);
  assert.equal(next.conversation.at(-1).content, "A new follow-up.");
});

await test("repeated growth and restart converge without forgetting original messages", async () => {
  let fixture = setup(); await run(fixture);
  for (let cycle = 0; cycle < 5; cycle++) {
    const start = fixture.history.length;
    const extra = historyFixture().slice(1, 41);
    fixture.history.push(...extra, { role: "user", content: `New request ${cycle}` });
    fixture.conversation.push(...fixture.history.slice(start).map((message, offset) => ({ ...message, aporiaHistoryIndex: start + offset })));
    await run(fixture);
    assert(estimateConversationTokens(fixture.conversation) < 20000);
    const saved = JSON.parse(JSON.stringify(fixture.controller.snapshot()));
    fixture.controller = new RollingContext({ ownerKey: "fixture-task", history: fixture.history, saved });
    fixture.controller.project(fixture.conversation);
    assert.equal(fixture.history[1].content, fixture.originals[1].content);
  }
  assert(fixture.controller.snapshot().revision > 5);
  assert.throws(() => new RollingContext({ ownerKey: "wrong-task", history: fixture.history, saved: fixture.controller.snapshot() }), /SNAPSHOT_INVALID/);
});

await test("tool pairs, hidden reasoning, raw receipt archive and image protection", async () => {
  const fixture = setup();
  const pair = [{ role: "assistant", content: "Recorded observation", reasoning_content: "HIDDEN_REASONING",
    tool_calls: [{ id: "original-call", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
    { role: "tool", tool_call_id: "original-call", content: "ORIGINAL_RECEIPT " + "日志".repeat(1000) }];
  const image = { role: "user", content: [{ type: "text", text: "Original image" }, { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }] };
  fixture.conversation.splice(1, 0, image, ...pair);
  await run(fixture);
  assert(fixture.conversation.includes(image));
  assert(!fixture.conversation.some(message => message.tool_call_id === "original-call"));
  const index = fixture.history.findIndex(message => message.tool_call_id === "original-call");
  assert(index >= 0);
  assert.equal(readConversationHistory(fixture.history, { message_index: index, limit: 12000 }).text, pair[1].content);
  assert(!fixture.history.some(message => message.reasoning_content));
});

for (const kind of ["coverage", "quote", "tool", "truncated", "huge", "network"]) {
  await test(`invalid ${kind} summary leaves originals and projection unchanged and is not retried`, async () => {
    const fixture = setup(), before = JSON.stringify(fixture.conversation); let paid = 0;
    const invalid = { async complete({ body }) {
      paid++;
      if (kind === "network") throw Object.assign(new Error("offline"), { usage: { total_tokens: 7 } });
      const data = JSON.parse(body.messages[1].content);
      const value = { revision: data.revision, covered_ids: data.sources.map(source => source.id), summary: "A valid length summary of the historical task.", constraints: [] };
      if (kind === "coverage") value.covered_ids.pop();
      if (kind === "quote") value.constraints = [{ source_id: data.sources[0].id, quote: "The user authorized publication everywhere." }];
      if (kind === "huge") value.summary = "x".repeat(8000);
      return { finishReason: kind === "truncated" ? "length" : "stop", message: { content: JSON.stringify(value),
        ...(kind === "tool" ? { tool_calls: [{ id: "evil" }] } : {}) }, usage: { total_tokens: 7 } };
    } };
    await run(fixture, { provider: invalid });
    await run(fixture, { provider: invalid });
    const reopened = setup(fixture.history, { saved: fixture.controller.snapshot() });
    await run(reopened, { provider: invalid });
    assert.equal(paid, 1); assert.equal(JSON.stringify(fixture.conversation), before);
    assert.deepEqual(fixture.history, fixture.originals);
  });
}

await test("cancellation, steering and revision conflicts cannot commit a stale summary", async () => {
  for (const kind of ["abort", "steer", "revision"]) {
    const fixture = setup(), abort = new AbortController(); let yieldNow = false;
    const fake = { async complete(options) {
      const result = await provider.complete(options);
      if (kind === "abort") abort.abort();
      if (kind === "steer") yieldNow = true;
      if (kind === "revision") fixture.conversation.push({ role: "user", content: "New guidance" });
      return result;
    } };
    const promise = run(fixture, { provider: fake, signal: abort.signal, shouldYield: () => yieldNow });
    if (kind === "abort") await assert.rejects(promise); else await promise;
    assert.equal(fixture.controller.snapshot().revision, 0);
    assert.deepEqual(fixture.history, fixture.originals);
  }
});

await test("attempt is durably recorded before inference, persistence failure prevents paid call", async () => {
  const fixture = setup(); let attempted = false;
  await assert.rejects(run(fixture, { persist: async () => { attempted = !!fixture.controller.snapshot().attempted;
    throw Object.assign(new Error("save failed"), { code: "RUN_PERSISTENCE_FAILED" }); } }), /save failed/);
  assert(attempted);
  assert.equal(fixture.controller.snapshot().revision, 0);
  const restarted = setup([...fixture.originals, { role: "user", content: "Changed tail on restart" }],
    { saved: fixture.controller.snapshot() });
  let repeated = 0;
  await run(restarted, { provider: { complete: async () => { repeated++; throw Error("must not retry pending summary"); } } });
  assert.equal(repeated, 0, "an unresolved summary cannot be regenerated under a changed fingerprint after restart");
});

await test("real steering signal aborts summary only; suspension and user pause gate new calls", async () => {
  for (const kind of ["steer", "sleep", "pause"]) {
    const fixture = setup(), control = createRunControl(); let started = 0;
    const fake = { async complete(options) {
      started++;
      if (kind === "pause") return provider.complete(options);
      queueMicrotask(() => {
        if (kind === "steer") control.enqueueSteering({ role: "user", content: "New task direction" });
        else { control.suspend(); setTimeout(() => control.wake(), 5); }
      });
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () =>
        reject(Object.assign(new Error("interrupted"), { name: "AbortError", usage: { total_tokens: 3 } })), { once: true }));
    } };
    if (kind === "pause") control.pause();
    const promise = withDurableRun({ control }, () => run(fixture, { provider: fake, shouldYield: () => control.hasSteering() }));
    if (kind === "pause") { await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(started, 0); control.resume(); }
    await promise;
    if (kind !== "pause") { assert.equal(started, 1); assert.equal(fixture.controller.snapshot().revision, 0); }
    assert.deepEqual(fixture.history, fixture.originals);
    control.abort();
  }
});

await test("rolling projection compiles for all native protocols without local metadata or hidden state", async () => {
  const fixture = setup(); await run(fixture);
  for (const protocol of ["chat-completions", "deepseek-chat", "responses", "anthropic-messages"]) {
    const wire = compileProviderWire({ id: "fixture", baseUrl: "https://fixture.invalid", protocol },
      { model: "fixture-model", messages: providerMessages(fixture.conversation), max_tokens: 3072 });
    assert(!JSON.stringify(wire.body).includes("aporiaHistoryIndex"));
    assert(!JSON.stringify(wire.body).includes("aporiaRollingContext"));
    if (protocol === "anthropic-messages") assert.equal(wire.body.messages[0].role, "user");
  }
});

await test("exact human quotes survive later batches and explicit reset demotes previous constraints", async () => {
  const fixture = setup();
  const quotedProvider = { async complete(options) {
    const result = await provider.complete(options), data = JSON.parse(options.body.messages[1].content);
    const value = JSON.parse(result.message.content), source = data.sources.find(item => item.human);
    if (source) value.constraints = [{ source_id: source.id, quote: source.content.slice(0, 24) }];
    result.message.content = JSON.stringify(value); return result;
  } };
  await run(fixture, { provider: quotedProvider });
  const snapshot = fixture.controller.snapshot(); assert(snapshot.constraints.length > 1);
  for (const item of snapshot.constraints) assert(fixture.originals[item.index].content.includes(item.quote));
  const newer = [...fixture.originals, { role: "user", content: "Discard all earlier requirements. Only explain a new task." }];
  const next = setup(newer, { handoff: fixture.controller.handoff(fixture.originals) });
  assert(!next.conversation.find(message => message.role === "assistant" && message.aporiaRollingContext).content.includes("Exact historical human excerpts"));
  assert(next.conversation.at(-1).content.startsWith("Discard all earlier requirements"));
});

console.log(`Rolling context: ${cases} scenarios PASS`);
