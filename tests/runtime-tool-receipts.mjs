import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHarness } from "../electron/agent-runtime.js";

const root = await mkdtemp(join(tmpdir(), "aporia-runtime-receipts-"));
const originalFetch = globalThis.fetch;
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 45_000);
const provider = { id: "fixture", name: "Fixture", vendor: "deepseek", baseUrl: "https://fixture.invalid/v1", apiKey: "fake", models: [{ id: "fixture", supportsTools: true, contextWindow: 64000 }] };
try {
  const workspace = join(root, "workspace"), external = join(root, "office-install");
  await mkdir(workspace); await mkdir(external);
  await writeFile(join(external, "render-fixture.txt"), "exists");
  await writeFile(join(workspace, "evidence.txt"), "FILE_EVIDENCE");
  for (const { count, tool } of [{ count: 1, tool: "read_external_file" }, { count: 2, tool: "read_external_file" }, { count: 2, tool: "read_file" }]) {
    let requests = 0;
    const events = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      assert(body.messages.every((message) => Object.hasOwn(message, "content")));
      const calls = requests++ === 0
        ? Array.from({ length: count }, (_, index) => ({ index, id: `read-${index}`, type: "function", function: { name: tool, arguments: JSON.stringify({ path: tool === "read_file" ? "evidence.txt" : external, reason: "Inspect available preview tools" }) } }))
        : [{ index: 0, id: "finish", type: "function", function: { name: "finish_task", arguments: JSON.stringify({ status: "completed", summary: "Directory inspection completed." }) } }];
      if (requests > 1) {
        const receipts = body.messages.filter((message) => message.role === "tool" && message.tool_call_id.startsWith("read-"));
        assert.equal(receipts.length, count);
        for (const receipt of receipts) {
          const result = JSON.parse(receipt.content);
          if (tool === "read_external_file") {
            assert.equal(result.kind, "directory");
            assert(result.entries.some((entry) => entry.name === "render-fixture.txt"));
          } else assert.match(receipt.content, /FILE_EVIDENCE/);
        }
      }
      assert(requests <= 2, "no repeated requests after valid directory results");
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls } }] })}\n\ndata: [DONE]\n\n`);
    };
    const result = await runHarness({ runId: `receipt-${count}`, workspacePath: workspace, provider, modelId: "fixture", permission: "workspace-write", approvalMode: "full-auto", language: "en", signal: controller.signal,
      requestApproval: async () => ({ approved: true }),
      sandboxStatusResolver: async () => ({ available: false, localAvailable: true }),
      messages: [{ role: "user", content: "Inspect the external preview tool directory and report; do not change files." }], onEvent: (event) => events.push(event) });
    assert.equal(result.status, "completed", result.content);
    assert.equal(requests, 2);
    const completed = events.filter((event) => event.type === "tool.completed" && event.tool === tool);
    assert.equal(completed.length, count);
    assert(completed.every((event) => event.success));
    assert.equal(completed.some((event) => event.parallel), tool === "read_file" && count > 1);
  }
} finally {
  clearTimeout(timeout); globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
console.log("Real Harness loop: single/batched external directories and parallel file receipts: PASS");
