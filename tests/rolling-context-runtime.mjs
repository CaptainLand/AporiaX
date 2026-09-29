import assert from "node:assert/strict";
import { runHarness } from "../electron/agent-runtime.js";
import { withDurableRun } from "../electron/runtime/durable-run.js";
import { createRunControl } from "../electron/runtime/run-control.js";
import { createAporiaCloudProvider } from "../electron/provider-config.js";
import { createOpenAICompatibleProvider } from "../electron/runtime/provider-stream.js";
import { completeLoopRequest } from "../electron/runtime/loop-recovery.js";
import { RollingContext } from "../electron/runtime/rolling-context.js";

const originalFetch = globalThis.fetch;
const model = { id: "test", supportsTools: true, contextWindow: 32000 };
const config = { id: "fixture", name: "fixture", vendor: "openai", baseUrl: "https://test.invalid/v1", apiKey: "fixture", models: [model] };
const history = [{ role: "user", content: "Never publish code. Keep all files local." },
  ...Array.from({ length: 40 }, (_, index) => [
    { role: "user", content: `OLD_REQUEST_${index}: ` + "逐项分析模块的数据处理流程。".repeat(70) },
    { role: "assistant", content: `OLD_RESULT_${index}: ` + "仅检查了实现，没有执行测试。".repeat(70) },
  ]).flat(), { role: "user", content: "Explain the current state CURRENT_ONLY, no tools except history reading." }];
const sse = (delta, usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, headers) => new Response(
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }], usage })}\n\ndata: [DONE]\n\n`, { headers });
const finish = () => sse({ tool_calls: [{ index: 0, id: "finish", type: "function", function: {
  name: "finish_task", arguments: JSON.stringify({ status: "completed", summary: "Current state explained; no changes made." }) } }] });
const summary = body => {
  const data = JSON.parse(body.messages[1].content);
  return sse({ content: JSON.stringify({ revision: data.revision, covered_ids: data.sources.map(source => source.id), constraints: [],
    summary: "Historical modules were inspected, but no tests were executed. No files were published. The only active task is the latest user request." }) });
};
function durable() {
  const contexts = {}, checkpoints = {};
  return { contexts, checkpoints, requestTrace: { runId: "fixture-run", taskId: "fixture-task" },
    context: async (scope, value) => { contexts[scope] = JSON.parse(value); },
    checkpoint: async value => { checkpoints[value.scopeId] = structuredClone(value); } };
}
const run = (runId, messages, extra = {}) => runHarness({ runId, taskId: "same-task", provider: config, modelId: "test",
  permission: "read-only", language: "en", messages, ...extra });
let summaryCalls = 0, ordinaryCalls = 0, events = [];
try {
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, "test");
    assert(body.messages.every(message => !Object.keys(message).some(key => key.startsWith("aporia"))));
    if (body.messages[0].content.includes("compressing historical conversation")) {
      summaryCalls++; assert.equal(body.tools, undefined); return summary(body);
    }
    ordinaryCalls++;
    assert(body.messages.some(message => message.content?.includes?.("rolling historical summary")));
    assert(body.messages.some(message => message.content === history[0].content));
    assert(body.messages.some(message => message.content?.includes?.("CURRENT_ONLY")));
    assert(!body.messages.some(message => message.content === history[1].content));
    if (ordinaryCalls === 1) return sse({ tool_calls: [{ index: 0, id: "read-original", type: "function", function: {
      name: "read_conversation_history", arguments: '{"message_index":1,"limit":12000}' } }] });
    if (ordinaryCalls === 2) assert.equal(JSON.parse(body.messages.findLast(message => message.role === "tool").content).text, history[1].content);
    return finish();
  };
  const store = durable();
  const result = await withDurableRun(store, () => run("first", history, { onEvent: event => events.push(event) }));
  assert.equal(result.status, "completed", result.content);
  assert(summaryCalls > 0); assert.equal(ordinaryCalls, 2);
  assert.equal(result.usage.total_tokens, (summaryCalls + ordinaryCalls) * 120);
  assert(result.rollingContext.revision > 0);
  assert(store.contexts.first.rollingContext.revision > 0);
  assert.equal(store.contexts.first.inputHistory[1].content, history[1].content);
  assert(!events.some(event => event.type === "response.delta" && event.delta?.includes?.("covered_ids")));
  console.log("PASS main loop same-model compaction, exact original readback, usage and durable checkpoint");

  const beforeSummary = summaryCalls;
  const followup = await run("next", [...history, { role: "assistant", content: result.content, rollingContext: result.rollingContext },
    { role: "user", content: "CURRENT_ONLY follow-up: explain one detail." }]);
  assert.equal(followup.status, "completed", followup.content);
  assert.equal(summaryCalls, beforeSummary, "same UI history should not be summarized a second time");
  console.log("PASS ordinary next turn reuses summary without an extra paid summary");

  const reopened = JSON.parse(JSON.stringify(store.contexts));
  const resumed = await run("resume", [{ role: "user", content: "CURRENT_ONLY continue from checkpoint without repeating work." }],
    { recoveryContext: { runId: "first", contexts: reopened, checkpoint: {}, operations: [], unresolvedOperations: [] } });
  assert.equal(resumed.status, "completed", resumed.content);
  assert.equal(summaryCalls, beforeSummary);
  console.log("PASS restart restores bounded projection and raw history without extra summary");

  // The same provider-stream code as real Cloud requests, with a fake endpoint.
  const cloudHeaders = [], cloudState = durable();
  const cloudConfig = { ...createAporiaCloudProvider("https://fixture.invalid"), authenticatedFetch: async (path, init) => {
    if (init.method !== "POST") return new Response(JSON.stringify({ protocolVersion: 1, modelGateway: { idempotency: "reject-duplicate-no-replay" } }));
    cloudHeaders.push(new Headers(init.headers));
    const body = JSON.parse(init.body);
    return body.messages[0]?.content.includes("compressing historical conversation") ? summary(body) : sse({ content: "Done" });
  } };
  const cloudModel = { ...model, id: "aporia-cloud-default" };
  const provider = createOpenAICompatibleProvider({ config: cloudConfig, model: cloudModel });
  const originals = structuredClone(history), conversation = originals.map((message, index) => ({ ...message, aporiaHistoryIndex: index }));
  const rolling = new RollingContext({ ownerKey: "cloud-task", history: originals });
  await withDurableRun(cloudState, async () => {
    await rolling.compact({ conversation, provider, modelId: cloudModel.id, contextWindowTokens: 32000 });
    await completeLoopRequest({ conversation, contextCheckpoints: [], accounting: {}, contextWindowTokens: 32000,
      getBody: messages => ({ model: cloudModel.id, messages }), complete: body => provider.complete({ body }) });
  });
  assert(cloudHeaders.length > 1);
  assert.equal(new Set(cloudHeaders.map(headers => headers.get("idempotency-key"))).size, cloudHeaders.length);
  assert(Object.keys(cloudState.checkpoints).some(key => key.startsWith("cloud-request:rolling-summary:")));
  assert(cloudState.checkpoints["cloud-request:main"]);
  console.log("PASS Cloud summaries and normal generation have independent durable request identities");
} finally { globalThis.fetch = originalFetch; }
console.log("Rolling context runtime: PASS");
