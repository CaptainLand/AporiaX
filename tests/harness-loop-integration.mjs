import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHarness } from "../electron/agent-runtime.js";
import { runSubagentTask } from "../electron/runtime/subagent-loop.js";
import { createOpenAICompatibleProvider } from "../electron/runtime/provider-stream.js";
import { ToolRegistry } from "../electron/agent-core.js";
import { createHarnessTaskRuntime } from "../electron/harness/task-runtime.js";
import { closeRunJournalStore, readRunEvidence } from "../electron/run-store.js";

const originalFetch = globalThis.fetch;
const root = await mkdtemp(join(tmpdir(), "aporia-loop-integration-"));
const dataDirectory = join(root, "data");
const provider = { id: "fixture", name: "Fixture", vendor: "deepseek", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only",
  models: [{ id: "fixture", supportsTools: true, contextWindow: 64000 }] };
const results = [];
let scenarioId = 0;
function sse(delta, finish = "stop", usage = { prompt_tokens: 200, completion_tokens: 5 }) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
const call = (id, name, input) => ({ id, type: "function", function: { name, arguments: JSON.stringify(input) } });
const toolResponse = (calls) => sse({ tool_calls: calls.map((item, index) => ({ ...item, index })) }, "tool_calls");
async function test(name, run) { const measurements = await run(); results.push({ name, passed: true, ...(measurements ? { measurements } : {}) }); console.log("PASS", name); }
async function fixture(handler, options = {}) {
  const workspace = join(root, "workspace-" + (++scenarioId)); await mkdir(workspace);
  await writeFile(join(workspace, "a.txt"), "OLD");
  const events = []; let requests = 0;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000);
  globalThis.fetch = async (_url, init) => {
    assert(++requests <= 20, "unexpected unbounded inference loop");
    return handler(JSON.parse(init.body), requests, workspace);
  };
  try {
    const result = await runHarness({ runId: "loop-" + scenarioId, taskId: "task-" + scenarioId,
      workspacePath: workspace, provider, modelId: "fixture", permission: "workspace-write", approvalMode: "manual",
      language: "en", requestApproval: async () => ({ approved: true }), signal: controller.signal,
      sandboxStatusResolver: async () => ({ available: false, localAvailable: true }),
      messages: [{ role: "user", content: "Follow this fixture task; preserve local work." }], ...options,
      onEvent: (event) => events.push(event) });
    return { result, events, requests, workspace };
  } finally { clearTimeout(timer); }
}
try {
  await test("real main loop runs mixed read/write/read pools in protocol order", async () => {
    const names = ["r1", "r2", "r3", "r4", "w", "r5", "r6", "r7"];
    const { result, events, requests, workspace } = await fixture((body, request) => {
      if (request === 1) return toolResponse(names.map((id) => call(id, id === "w" ? "write_file" : "read_file", id === "w" ? { path: "a.txt", content: "NEW" } : { path: "a.txt" })));
      const receipts = body.messages.filter((message) => message.role === "tool");
      assert.deepEqual(receipts.map((message) => message.tool_call_id), names);
      for (const message of receipts) {
        if (message.tool_call_id === "w") continue;
        assert.equal(JSON.parse(message.content).content, Number(message.tool_call_id.slice(1)) >= 5 ? "NEW" : "OLD");
      }
      return sse({ content: "Delivered without claiming verification." });
    });
    assert.equal(result.status, "completed", result.content); assert.equal(requests, 2);
    assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "NEW");
    assert.deepEqual(events.filter((event) => event.type === "parallel_batch.started").map((event) => event.count), [4, 3]);
    assert.equal(result.loopMetrics.toolCalls, 8); assert.equal(result.loopMetrics.attempts, 2);
  });
  await test("new scheduler does not bypass read-only write denial", async () => {
    const { result, workspace } = await fixture((body, request) => {
      if (request === 1) return toolResponse([call("r1", "read_file", { path: "a.txt" }), call("w", "write_file", { path: "a.txt", content: "FORBIDDEN" }), call("r2", "read_file", { path: "a.txt" })]);
      const receipt = body.messages.find((message) => message.tool_call_id === "w"); assert(JSON.parse(receipt.content).error);
      return sse({ content: "Write denied." });
    }, { permission: "read-only" });
    assert.equal(result.status, "completed", result.content); assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "OLD");
  });
  await test("real main loop stops at an explicit repeated-evidence budget", async () => {
    const { result, requests, events } = await fixture((_body, request) => toolResponse([call("read-" + request, "read_file", { path: "a.txt" })]), { loopPolicy: { maxRepeatedEvidence: 6 } });
    assert.equal(result.status, "blocked", result.content); assert.match(result.content, /LOOP_NO_PROGRESS/);
    assert.equal(requests, 6); assert.equal(events.filter((event) => event.type === "tool.completed").length, 6);
  });
  await test("default progress policy remains advisory rather than cancelling work", async () => {
    const { result, requests } = await fixture((_body, request) => request <= 12 ? toolResponse([call("read-" + request, "read_file", { path: "a.txt" })]) : sse({ content: "No new evidence; report blocker." }));
    assert.equal(result.status, "completed", result.content); assert.equal(requests, 13); assert.equal(result.loopMetrics.noProgressWarnings, 4);
  });
  await test("real main loop preserves both parts of a bounded output continuation", async () => {
    const { result, requests } = await fixture((_body, request) => request === 1 ? sse({ content: "FIRST_PART" }, "length") : sse({ content: "SECOND_PART" }));
    assert.equal(result.status, "completed", result.content); assert.match(result.content, /FIRST_PART\nSECOND_PART/); assert.equal(requests, 2);
    assert.equal(result.loopMetrics.recoveries, 1); assert.equal(result.usage.prompt_tokens, 400);
  });
  await test("truncated side-effecting calls never reach the native executor", async () => {
    const { result, workspace, requests } = await fixture(() => sse({ tool_calls: [{ index: 0, id: "partial", function: { name: "write_file", arguments: '{"path":"a.txt","content":' } }] }, "length"));
    assert.equal(result.status, "failed"); assert.equal(requests, 1);
    assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "OLD"); assert.equal(result.steps.length, 0);
  });
  await test("invalid terminated call is corrected once before normal tool execution", async () => {
    const { result, requests, workspace } = await fixture((body, request) => {
      if (request === 1) return sse({ tool_calls: [{ index: 0, id: "invalid", function: { name: "write_file", arguments: "[]" } }] }, "tool_calls");
      if (request === 2) { assert(!body.messages.some((message) => message.tool_calls?.some((item) => item.id === "invalid"))); return toolResponse([call("valid", "write_file", { path: "a.txt", content: "VALID" })]); }
      return sse({ content: "Delivered." });
    });
    assert.equal(result.status, "completed", result.content); assert.equal(requests, 3); assert.equal(result.steps.length, 1);
    assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "VALID");
  });
  await test("real context recovery shrinks old history without removing user constraints", async () => {
    const sizes = [];
    const messages = [{ role: "user", content: "MUST_NOT_UPLOAD", aporiaSource: "human", aporiaPinned: true }, ...Array.from({ length: 30 }, (_, i) => ({ role: "assistant", content: "old-" + i + "中".repeat(900) })), { role: "user", content: "continue" }];
    const { result, requests } = await fixture((body, request) => {
      sizes.push(JSON.stringify(body.messages).length);
      assert(body.messages.some((message) => message.content === "MUST_NOT_UPLOAD"));
      if (request === 1) return new Response('{"error":{"code":"context_length_exceeded","message":"maximum context length exceeded"}}', { status: 400 });
      return sse({ content: "Finished with original constraints." });
    }, { messages });
    assert.equal(result.status, "completed", result.content); assert.equal(requests, 2); assert(sizes[1] < sizes[0]);
    assert.equal(result.loopMetrics.recoveries, 1);
    return { mockProvider: true, requestCharactersBefore: sizes[0], requestCharactersAfter: sizes[1], requests };
  });
  await test("opt-in verification continuation is bounded and ends as partial", async () => {
    const { result, events, requests } = await fixture((_body, request) => request === 1 ? toolResponse([call("w", "write_file", { path: "a.txt", content: "NEW" })]) : sse({ content: "Implemented, not tested." }),
      { loopPolicy: { requireVerifiedChanges: true, maxCompletionContinuations: 1 } });
    assert.equal(result.status, "partial", result.content); assert.equal(requests, 3);
    assert.equal(events.filter((event) => event.type === "completion.continue").length, 1);
    assert.equal(result.changes.length, 1);
  });
  await test("explicit user test waiver still overrides optional completion continuation", async () => {
    const { result, requests } = await fixture((_body, request) => request === 1 ? toolResponse([call("w", "write_file", { path: "a.txt", content: "NEW" })]) : sse({ content: "Delivered without tests as requested." }),
      { loopPolicy: { requireVerifiedChanges: true }, messages: [{ role: "user", content: "Skip tests and deliver the requested a.txt update." }] });
    assert.equal(result.status, "completed", result.content); assert.equal(requests, 2);
  });
  await test("actual child loop shares bounded output recovery", async () => {
    let requests = 0;
    globalThis.fetch = async () => ++requests === 1 ? sse({ content: "CHILD_FIRST" }, "length") : sse({ content: "CHILD_SECOND" });
    const childProvider = createOpenAICompatibleProvider({ config: provider, model: provider.models[0] });
    const registry = new ToolRegistry([]);
    const result = await runSubagentTask({ __kernelRouted: true, agentId: "loop-child", input: { role: "explore", task: "Inspect fixture", scope: ["."], maxRounds: 3 },
      provider: childProvider, modelId: "fixture", modelConfig: provider.models[0], workspaceRoot: root, parentPermissionPolicy: { "*": "allow" },
      approvalMode: "manual", requestApproval: async () => ({ approved: false }), signal: new AbortController().signal, language: "en", memoryFacts: [], emit() {},
      toolRegistry: registry, parseToolArguments: (item) => JSON.parse(item.function.arguments), executeAuthorizedTool: async () => { throw new Error("No tool should execute"); } });
    assert.equal(result.status, "completed", result.summary); assert.match(result.summary, /CHILD_FIRST\nCHILD_SECOND/); assert.equal(requests, 2);
    assert.equal(result.loopMetrics.recoveries, 1);
  });
  await test("large native output is archived and paged from the real task-owned SQLite store", async () => {
    const workspace = join(root, "archive-workspace"); await mkdir(workspace);
    const text = "ARCHIVED_ORIGINAL\n" + "中文".repeat(12000); await writeFile(join(workspace, "large.txt"), text);
    const runtime = createHarnessTaskRuntime({ dataDirectory }); let requests = 0, reference;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body); requests++;
      if (requests === 1) return toolResponse([call("large", "read_file", { path: "large.txt" })]);
      if (requests === 2) {
        const value = JSON.parse(body.messages.find((message) => message.tool_call_id === "large").content);
        reference = value.resultRef; assert(reference?.id); assert.equal(reference.readTool, "mcp_read_result");
        assert(body.tools.some((tool) => tool.function.name === reference.readTool));
        return toolResponse([call("page", "mcp_read_result", { result_id: reference.id, limit: 256 })]);
      }
      const page = JSON.parse(body.messages.find((message) => message.tool_call_id === "page").content);
      assert.match(page.text, /ARCHIVED_ORIGINAL/); return sse({ content: "Read archived original without repeating the source tool." });
    };
    const result = await runtime.start({ runId: "archive-run", taskId: "archive-task", metadata: { workspacePath: workspace },
      execute: ({ signal, control, emit, requestApproval }) => runHarness({ runId: "archive-run", taskId: "archive-task", provider, modelId: "fixture",
        workspacePath: workspace, permission: "read-only", approvalMode: "manual", signal, control, onEvent: emit, requestApproval,
        sandboxStatusResolver: async () => ({ available: false, localAvailable: true }), messages: [{ role: "user", content: "Read and preserve evidence." }] }) });
    assert.equal(result.status, "completed", result.content); assert.equal(requests, 3);
    const page = await readRunEvidence(dataDirectory, "archive-run", { result_id: reference.id, limit: 256 });
    assert.match(page.text, /ARCHIVED_ORIGINAL/);
    await assert.rejects(readRunEvidence(dataDirectory, "unrelated-run", { result_id: reference.id }), /unknown|scope|not found|unavailable|evidence/i);
  });
} finally {
  globalThis.fetch = originalFetch;
  await closeRunJournalStore(dataDirectory).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
await mkdir(".tmp/audit-results", { recursive: true });
await writeFile(".tmp/audit-results/harness-loop-integration.json", JSON.stringify({ node: process.version, cases: results.length, results }, null, 2));
console.log(`Harness loop integration: ${results.length} cases PASS`);
