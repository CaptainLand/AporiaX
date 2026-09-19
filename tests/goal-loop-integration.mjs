import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSubagentTask } from "../electron/runtime/subagent-loop.js";
import { createOpenAICompatibleProvider } from "../electron/runtime/provider-stream.js";
import { TOOL_REGISTRY } from "../electron/runtime/native-tool-catalog.js";
import { runHarness } from "../electron/agent-runtime.js";
import { createHarnessTaskRuntime } from "../electron/harness/task-runtime.js";
import { getRunRecoveryContext, closeRunJournalStore } from "../electron/run-store.js";
import { suite, provider, tools, call, sse, eventsResponse, anthropicEvents, responsesEvents, outputText } from "./goal-loop-fixtures.mjs";
const { test, finish } = suite("goal-loop-integration");
const root = await mkdtemp(join(tmpdir(), "aporia-goal-integration-")), data = join(root, "data");
const originalFetch = globalThis.fetch; let sequence = 0;
const taskId = "goal-task";
const contract = (checks) => ({ version: 1, enforce: true, requirements: [{ id: "goal", text: "Expected behavior", checks }] });
async function fixture(handler, options = {}) {
  const id = "goal-" + (++sequence), workspace = options.workspacePath || join(root, id); await mkdir(workspace, { recursive: true });
  if (!options.workspacePath) { await writeFile(join(workspace, "a.txt"), "ORIGINAL"); await writeFile(join(workspace, "a.js"), "const x = 1;\n"); }
  const events = []; let requests = 0; const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  globalThis.fetch = async (url, init) => { assert(++requests <= 24, "unbounded goal loop"); return handler(JSON.parse(init.body), requests, workspace, String(url)); };
  const settings = { runId: id, taskId, workspacePath: workspace, provider, modelId: "fixture", permission: "workspace-write", approvalMode: "manual", language: "en",
    signal: controller.signal, requestApproval: async () => ({ approved: true }), sandboxStatusResolver: async () => ({ available: false, localAvailable: true }),
    messages: [{ role: "user", content: "Implement this task while preserving original work. Record concise decisions and inspect actual evidence." }],
    loopPolicy: { maxBriefSummaries: 0 }, ...options, onEvent: (event) => events.push(event) };
  try {
    let result;
    if (options.durable) {
      const runtime = createHarnessTaskRuntime({ dataDirectory: data });
      result = await runtime.start({ runId: id, taskId, metadata: { workspacePath: workspace },
        execute: ({ signal, control, emit }) => runHarness({ ...settings, signal, control, onEvent: (event) => { events.push(event); emit(event); } }) });
    } else result = await runHarness(settings);
    return { result, events, requests, workspace, runId: id };
  } finally { clearTimeout(timer); }
}
const toolResult = (body, id) => JSON.parse(body.messages.find((message) => message.tool_call_id === id).content);
try {
  await test("real loop records source-backed decisions and recovers them from SQLite", async () => {
    const first = await fixture((body, n) => {
      if (n === 1) return tools(call("read-source", "read_file", { path: "a.txt" }));
      if (n === 2) return tools(call("decision", "task_brief", { action: "record", expected_revision: 0, kind: "rejected", summary: "Never erase the original migration input", rationale: "The input is the recoverable original and must remain intact.", evidence_call_ids: ["read-source"] }));
      assert.equal(toolResult(body, "decision").revision, 1);
      return sse({ content: "Recorded the decision with its source." });
    }, { durable: true });
    assert.equal(first.result.status, "completed", first.result.content); assert.equal(first.result.taskBrief.revision, 1);
    await closeRunJournalStore(data);
    const recovery = await getRunRecoveryContext(data, first.runId);
    assert.equal(recovery.contexts[first.runId].taskBrief.entries[0].kind, "rejected");
    const resumed = await fixture((body) => {
      assert(body.messages.some((message) => message.content?.includes("Never erase the original migration input")));
      return sse({ content: "Continued with preserved decision; historical proof is not a new pass." });
    }, { workspacePath: first.workspace, recoveryContext: recovery });
    assert.equal(resumed.result.status, "completed", resumed.result.content);
    assert.equal(resumed.result.taskBrief.entries[0].evidence[0].historical, true);
    // A fresh user turn can inherit the same task/workspace assertion projection.
    const fresh = await fixture((body) => { assert(body.messages.some((message) => message.content?.includes("Never erase"))); return sse({ content: "Same task continued." }); },
      { workspacePath: first.workspace, messages: [{ role: "assistant", content: first.result.content, taskBrief: first.result.taskBrief }, { role: "user", content: "Continue the same task." }] });
    assert.equal(fresh.result.taskBrief.revision, 1);
  });
  await test("missing acceptance evidence yields a bounded continuation, then honest partial with no auto-execution", async () => {
    let commands = 0;
    const run = await fixture(() => sse({ content: "Claimed complete." }), {
      taskContract: contract([{ type: "command_exit", command: "npm test", inputs: ["a.txt"] }]),
      sandboxExecutor: async () => { commands++; throw new Error("must not run implicitly"); },
    });
    assert.equal(run.requests, 2); assert.equal(run.result.status, "partial"); assert.equal(commands, 0);
    assert.equal(run.result.acceptance.passed, false); assert.equal(run.result.acceptance.requirements[0].checks[0].status, "not-run");
  });
  await test("actual mutation and exact command receipts satisfy configured requirements without model-written pass", async () => {
    let commands = 0;
    const run = await fixture((body, n) => {
      if (n === 1) return tools(call("write", "write_file", { path: "a.txt", content: "DONE" }));
      if (n === 2) return tools(call("check", "run_command", { command: "fixture verify", cwd: "." }));
      return sse({ content: "Checked configured requirements." });
    }, {
      taskContract: contract([{ type: "file_contains", path: "a.txt", text: "DONE" }, { type: "command_exit", command: "fixture verify", inputs: ["a.txt"] }]),
      sandboxExecutor: async ({ command, workspaceRoot }) => { commands++; assert.equal(command, "fixture verify"); assert.equal(await readFile(join(workspaceRoot, "a.txt"), "utf8"), "DONE"); return { exitCode: 0, stdout: "fixture verified", stderr: "" }; },
    });
    assert.equal(run.result.status, "completed", run.result.content); assert.equal(run.result.acceptance.passed, true); assert.equal(commands, 1); assert.equal(run.requests, 3);
  });
  await test("modifying inputs after a passing command invalidates requirement evidence", async () => {
    const run = await fixture((_body, n) => {
      if (n === 1) return tools(call("check", "run_command", { command: "fixture verify" }));
      if (n === 2) return tools(call("mutate", "write_file", { path: "a.txt", content: "changed after check" }));
      return sse({ content: "Done." });
    }, { taskContract: contract([{ type: "command_exit", command: "fixture verify", inputs: ["a.txt"] }]), sandboxExecutor: async () => ({ exitCode: 0, stdout: "checked old state" }) });
    assert.equal(run.result.status, "partial"); assert.equal(run.result.acceptance.passed, false);
  });
  await test("permission denial remains a denial even when an acceptance check wants the file", async () => {
    const run = await fixture((_body, n) => n === 1 ? tools(call("denied", "write_file", { path: "a.txt", content: "DONE" })) : sse({ content: "Cannot change this file." }),
      { permission: "read-only", taskContract: contract([{ type: "file_contains", path: "a.txt", text: "DONE" }]) });
    assert.equal(run.result.status, "partial"); assert.equal(await readFile(join(run.workspace, "a.txt"), "utf8"), "ORIGINAL");
    assert(run.result.steps.some((step) => step.success === false));
  });
  await test("process exit waits through real OS events with exactly three model requests", async () => {
    const command = `"${process.execPath}" -e "setTimeout(()=>console.log('EVENT_DONE'),180)"`;
    const run = await fixture((body, n) => {
      if (n === 1) return tools(call("start", "start_process", { command, cwd: "." }));
      if (n === 2) { const process = toolResult(body, "start"); assert(process.processId, JSON.stringify(process)); return tools(call("wait", "wait_process", { process_id: process.processId, until: "exit", timeout_ms: 10000 })); }
      const result = toolResult(body, "wait"); assert.equal(result.exitCode, 0); assert.match(result.output, /EVENT_DONE/);
      return sse({ content: "The process ended with observed output." });
    });
    assert.equal(run.result.status, "completed", run.result.content); assert.equal(run.requests, 3);
    assert.equal(run.result.steps.filter((step) => step.name === "read_process").length, 0);
    return { modelRequests: run.requests, pollingCalls: 0 };
  });
  await test("repeated failures block mutation until fresh evidence and different strategy, then recover", async () => {
    let commands = 0;
    const run = await fixture((body, n) => {
      if (n <= 3) return tools(call(`failure-${n}`, "run_command", { command: "fixture failing" }));
      if (n === 4) return tools(call("blocked-write", "write_file", { path: "a.txt", content: "MUST_NOT_APPLY" }));
      if (n === 5) { assert.match(toolResult(body, "blocked-write").error, /STRATEGY_REPLAN_REQUIRED/); return tools(call("diagnosis", "read_file", { path: "a.js" })); }
      if (n === 6) return tools(call("replan", "replan_strategy", { hypothesis: "Change the configuration source instead of retrying the same command blindly", evidence_call_ids: ["diagnosis"] }));
      if (n === 7) { assert.equal(toolResult(body, "replan").accepted, true); return tools(call("fixed", "write_file", { path: "a.txt", content: "REPAIRED" })); }
      return sse({ content: "Changed strategy after new evidence; verification remains unclaimed." });
    }, { sandboxExecutor: async () => { commands++; return { exitCode: 1, stdout: "", stderr: "same deterministic fixture failure" }; } });
    assert.equal(run.result.status, "completed", run.result.content); assert.equal(commands, 3); assert.equal(await readFile(join(run.workspace, "a.txt"), "utf8"), "REPAIRED");
    assert(run.events.some((event) => event.type === "strategy.replan_required")); assert.equal(run.result.strategy.previousHypotheses.length, 1);
  });
  for (const protocol of ["responses", "anthropic-messages"]) await test(`real main loop executes a native ${protocol} tool round-trip and preserves private continuation`, async () => {
    const run = await fixture((body, n, _workspace, url) => {
      assert(url.endsWith(protocol === "responses" ? "/responses" : "/messages"));
      if (n === 1) return eventsResponse(protocol === "responses" ? responsesEvents([
        { type: "reasoning", id: "rs", encrypted_content: "SYNTHETIC_PRIVATE", summary: [] }, { type: "function_call", call_id: "read", id: "fc", name: "read_file", arguments: '{"path":"a.txt"}' },
      ]) : anthropicEvents([{ type: "thinking", thinking: "SYNTHETIC_PRIVATE", signature: "FIXTURE_SIGNATURE" }, { type: "tool_use", id: "read", name: "read_file", input: { path: "a.txt" } }], "tool_use"));
      if (protocol === "responses") {
        assert(body.input.some((item) => item.encrypted_content === "SYNTHETIC_PRIVATE"));
        assert(body.input.some((item) => item.type === "function_call_output" && item.output.includes("ORIGINAL")));
      } else {
        assert(body.messages.some((m) => m.role === "assistant" && m.content.some((b) => b.signature === "FIXTURE_SIGNATURE")));
        assert(body.messages.some((m) => m.role === "user" && m.content.some((b) => b.type === "tool_result" && b.content.includes("ORIGINAL"))));
      }
      return eventsResponse(protocol === "responses" ? responsesEvents([outputText("Read actual file.")]) : anthropicEvents([{ type: "text", text: "Read actual file." }]));
    }, { provider: { ...provider, vendor: protocol === "responses" ? "openai" : "anthropic", protocol } });
    assert.equal(run.result.status, "completed", run.result.content); assert.equal(run.requests, 2);
    assert(!JSON.stringify(run.events).includes("SYNTHETIC_PRIVATE")); assert(!JSON.stringify(run.result).includes("FIXTURE_SIGNATURE"));
  });
  await test("automatic public-decision summary runs once before pressure compaction and keeps original user constraints", async () => {
    let summaryCalls = 0;
    const history = [{ role: "user", content: "Do not delete the original file; preserve KEEP_USER_CONSTRAINT." }, ...Array.from({ length: 45 }, (_, i) => ({ role: "assistant", content: i === 0 ? "We rejected deletion because the old file is the only recovery source." : `old-${i} ` + "中".repeat(1400) }))];
    const run = await fixture((body) => {
      if (body.messages[0].content.startsWith("Summarize only explicit decisions")) {
        summaryCalls++; const request = JSON.parse(body.messages[1].content);
        return sse({ content: JSON.stringify({ expected_revision: request.expected_revision, entries: [{ kind: "rejected", summary: "Keep old recovery source", source_id: request.sources[0].id, quote: "the old file is the only recovery source" }] }) });
      }
      assert(body.messages.some((message) => message.content === "Do not delete the original file; preserve KEEP_USER_CONSTRAINT."));
      assert(body.messages.some((message) => message.content?.includes("Keep old recovery source")));
      return sse({ content: "Continued with a source-backed summary." });
    }, { messages: [...history, { role: "user", content: "Continue" }], provider: { ...provider, models: [{ ...provider.models[0], contextWindow: 32000 }] }, loopPolicy: { maxBriefSummaries: 1 } });
    assert.equal(run.result.status, "completed", run.result.content); assert.equal(summaryCalls, 1); assert.equal(run.result.taskBrief.entries[0].origin, "bounded-public-summary");
  });
  await test("actual child loop records scoped evidence and continues the same durable decision session", async () => {
    const session = {}, events = []; let n = 0;
    const workspace = join(root, "child-goal"); await mkdir(workspace); await writeFile(join(workspace, "a.txt"), "CHILD_SOURCE");
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body); n++;
      if (n === 1) return tools(call("child-read", "read_file", { path: "a.txt" }));
      if (n === 2) return tools(call("child-record", "task_brief", { action: "record", expected_revision: 0, kind: "decision", summary: "Keep child source intact", rationale: "The observed source is required by the parent.", evidence_call_ids: ["child-read"] }));
      assert(body.messages.some((message) => message.content?.includes("Keep child source intact")));
      return sse({ content: "Inspected child source, without claiming parent acceptance." });
    };
    const options = { __kernelRouted: true, agentId: "goal-child", session, input: { role: "explore", task: "Inspect the source and record a decision", scope: ["."], maxRounds: 6 },
      provider: createOpenAICompatibleProvider({ config: provider, model: provider.models[0] }), modelId: "fixture", modelConfig: provider.models[0], workspaceRoot: workspace,
      parentPermissionPolicy: { "*": "allow" }, approvalMode: "manual", requestApproval: async () => ({ approved: false }), signal: AbortSignal.timeout(12000),
      language: "en", memoryFacts: [], emit: (event) => events.push(event), toolRegistry: TOOL_REGISTRY, parseToolArguments: (item) => JSON.parse(item.function.arguments),
      executeAuthorizedTool: async ({ input, toolCall }) => { assert.equal(toolCall.function.name, "read_file"); return { modelResult: { path: input.path, content: await readFile(join(workspace, input.path), "utf8") } }; } };
    const first = await runSubagentTask(options); assert.equal(first.status, "completed", first.summary); assert.equal(first.taskBrief.entries[0].summary, "Keep child source intact");
    const second = await runSubagentTask(options); assert.equal(second.status, "completed", second.summary); assert.equal(session.taskBrief.entries.length, 1); assert.equal(n, 4);
  });
} finally { globalThis.fetch = originalFetch; await closeRunJournalStore(data).catch(() => {}); await rm(root, { recursive: true, force: true }); }
await finish();
