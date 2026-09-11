import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHarness } from "../electron/agent-runtime-core.js";
import { createHarnessTaskRuntime } from "../electron/harness/task-runtime.js";
import { closeRunJournalStore, getRunRecoveryContext } from "../electron/run-store.js";

const root = await mkdtemp(join(tmpdir(), "aporia-steer-integration-"));
const originalFetch = globalThis.fetch;
const provider = { id: "test", name: "Test", vendor: "openai", baseUrl: "https://test.invalid/v1", apiKey: "test-only", models: [{ id: "test", supportsTools: true, supportsThinking: false }] };
const sse = (delta) => new Response('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
const runtime = createHarnessTaskRuntime({ dataDirectory: join(root, "journal") });
try {
  for (const mode of ["model", "tools"]) {
    const runId = "steer-" + mode;
    let calls = 0;
    let canceled = false;
    let didSteer = false;
    let toolFinished = false;
    const events = [];
    const guidance = "Only say new reply; do not write any files.";
    await writeFile(join(root, "sample.txt"), "original");
    globalThis.fetch = async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      if (calls > 3) throw new Error("Unexpected request loop");
      if (calls === 1 && mode === "model") {
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: "partial progress" } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }) + '\n\n'));
          options.signal.addEventListener("abort", () => { canceled = true; controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
          setTimeout(() => { didSteer = runtime.steer(runId, { id: "s", content: guidance }); }, 20);
        } }));
      }
      if (calls === 1) return sse({ tool_calls: [
        { index: 0, id: "read", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "sample.txt" }) } },
        { index: 1, id: "write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "sample.txt", content: "wrong" }) } },
      ] });
      assert.ok(body.messages.some((message) => message.role === "user" && message.content === guidance));
      if (mode === "tools") {
        const skipped = body.messages.find((message) => message.tool_call_id === "write");
        assert.equal(JSON.parse(skipped.content).skipped, true);
      }
      return sse({ content: "new reply" });
    };
    const timeout = setTimeout(() => runtime.interrupt(runId), 15000);
    let result;
    try {
      result = await runtime.start({ runId, taskId: "task", metadata: {}, execute: ({ signal, control, emit, requestApproval }) => runHarness({
        runId, taskId: "task", provider, modelId: "test", workspacePath: mode === "tools" ? root : "", messages: [{ role: "user", content: "Read the file" }], signal, control, requestApproval,
        sandboxStatusResolver: async () => ({ available: true, autoApprovalSafe: true, backend: "test", state: "ready" }),
        onEvent: (event) => {
          events.push(event);
          emit(event);
          if (mode === "tools" && event.type === "tool.started" && event.tool === "read_file") didSteer = runtime.steer(runId, { id: "s", content: guidance });
          if (event.type === "tool.completed" && event.tool === "read_file") toolFinished = true;
        },
      }) });
    } finally { clearTimeout(timeout); }
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.content, "new reply");
    assert.equal(calls, 2);
    assert.equal(didSteer, true);
    assert.ok(events.some((event) => event.type === "steering.applied"));
    if (mode === "model") assert.equal(canceled, true);
    else {
      assert.equal(toolFinished, true, "in-flight read must complete");
      assert.equal(await readFile(join(root, "sample.txt"), "utf8"), "original", "not-yet-started write must not run");
    }
    const recovered = await getRunRecoveryContext(join(root, "journal"), runId);
    assert.ok(recovered.events.some((event) => event.type === "steering.queued" && event.message.content === guidance));
  }
  console.log("Main runtime + durable task control: model cancel, tool boundary, replan, preserved guidance: PASS");
} finally {
  globalThis.fetch = originalFetch;
  await closeRunJournalStore(join(root, "journal"));
  await rm(root, { recursive: true, force: true });
}
