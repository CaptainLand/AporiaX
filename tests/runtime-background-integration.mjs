import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runHarness } from "../electron/agent-runtime-core.js";

const root = await mkdtemp(join(tmpdir(), "aporia-background-"));
const originalFetch = globalThis.fetch;
const provider = { id: "background-test", name: "test", vendor: "openai", baseUrl: "https://test.invalid/v1", apiKey: "test-only",
  models: [{ id: "test", supportsTools: true, supportsThinking: false, contextWindow: 128000 }] };
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const sse = (delta) => new Response(`data: ${JSON.stringify({ choices: [{ delta }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`);
const call = (id, name, input) => sse({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] });
try {
  await writeFile(join(root, "notes.txt"), "A test note\n");
  for (const optional of [true, false]) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 8000);
    const childWaiting = defer();
    const allowChildFinish = defer();
    let mainRounds = 0;
    let childRounds = 0;
    let childAborted = false;
    const events = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      const text = body.messages.map((m) => typeof m.content === "string" ? m.content : "").join("\n");
      if (text.includes("You are the AporiaX explore subagent.")) {
        if (++childRounds === 1) return call("read-note", "read_file", { path: "notes.txt" });
        childWaiting.resolve();
        await new Promise((resolve, reject) => {
          const abort = () => { childAborted = true; reject(Object.assign(new Error("cancelled"), { name: "AbortError" })); };
          options.signal.addEventListener("abort", abort, { once: true });
          if (options.signal.aborted) abort();
          allowChildFinish.promise.then(() => { options.signal.removeEventListener("abort", abort); resolve(); });
        });
        return sse({ content: "Required exploration evidence collected." });
      }
      if (++mainRounds === 1) return call("delegate", "delegate_subagent", {
        role: "explore", task: "Inspect notes.txt", scope: ["notes.txt"], background: true,
        ...(optional ? { required_for_completion: false } : {}),
      });
      await childWaiting.promise;
      if (!optional) allowChildFinish.resolve();
      if (!optional && mainRounds === 3) return call('accept', 'review_subagent_result', {
        agent_id: 'background-false-sub-1', report_id: 'background-false-sub-1:1', decision: 'accepted', reason: 'Read the returned note evidence; it answers the delegated question.', evidence_ids: ['background-false-sub-1:1:read-note'],
      });
      return sse({ content: "Main answer ready." });
    };
    try {
      const result = await runHarness({ runId: `background-${optional}`, taskId: "test", provider, modelId: "test", workspacePath: root,
        permission: "workspace-write", approvalMode: "manual", thinking: false, signal: controller.signal, language: "en",
        messages: [{ role: "user", content: "Explain this note, without changing files." }],
        sandboxStatusResolver: async () => ({ available: false, state: "unavailable", autoApprovalSafe: false }),
        requestApproval: async () => ({ approved: false }), onEvent: (event) => events.push(event) });
      assert.equal(result.status, "completed", result.content);
      assert.equal(mainRounds, optional ? 2 : 4, "required work is collected and explicitly accepted; optional work does not block delivery");
      assert.equal(childAborted, optional);
      assert.equal(result.usage.total_tokens, optional ? 33 : 66, "completed child and acceptance calls stay counted, without double counting");
      assert.equal(events.some((e) => e.type === "subagent.optional.skipped"), optional);
    } finally { clearTimeout(deadline); controller.abort(); allowChildFinish.resolve(); }
  }
  console.log("Optional background cancellation, required collection and per-round usage: PASS");
} finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
