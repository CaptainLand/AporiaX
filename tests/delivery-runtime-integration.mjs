import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runHarness } from "../electron/agent-runtime-core.js";
const temp = await mkdtemp(join(tmpdir(), "aporia-delivery-"));
const originalFetch = globalThis.fetch;
const provider = { id: "test", name: "test", vendor: "openai", baseUrl: "https://test.invalid/v1", apiKey: "test", models: [{ id: "test", supportsTools: true, supportsThinking: false }] };
const sse = (delta) => new Response('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
const call = (id, name, input) => ({ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } });
try {
  for (const waived of [false, true]) {
    const root = join(temp, String(waived)); await mkdir(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node tests.js" } }));
    let mainRounds = 0; let reviews = 0; let commands = 0; let approvals = 0;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.messages.some((m) => String(m.content).includes("You are the AporiaX review subagent."))) {
        if (++reviews === 1) return sse({ tool_calls: [call("review-read", "read_file", { path: "core.js" })] });
        return sse({ content: JSON.stringify({ verdict: "pass", checks: ["Read current core.js"], findings: [], remaining_risks: [] }) });
      }
      if (++mainRounds === 1) return sse({ tool_calls: [
        call("write", "write_file", { path: "core.js", content: "export const ready = true;\n" }),
        { ...call("review", "request_self_check", { reason: "Verify the new implementation", verification: [{ command: "npm run test", cwd: ".", reason: "The test covers core.js" }] }), index: 1 },
      ] });
      assert.ok(mainRounds < 5, "unexpected self-check loop");
      return sse({ content: `[文件](${join(root, "core.js").replaceAll("\\", "/")})\n\n[不存在](missing.docx)` });
    };
    try {
      const result = await runHarness({ runId: `delivery-${waived}`, taskId: "test", workspacePath: root, provider, modelId: "test", permission: "workspace-write", approvalMode: "full-auto", thinking: false, signal: controller.signal,
        messages: [{ role: "user", content: waived ? "先别测试了，直接交付吧" : "Implement core.js and verify it." }],
        sandboxStatusResolver: async () => ({ available: false, localAvailable: true, state: "unavailable" }),
        sandboxExecutor: async () => { commands++; throw Object.assign(new Error("ENOENT, not found in release/resources/app.asar"), { code: "ENOENT" }); },
        requestApproval: async () => { approvals++; return { approved: false }; },
      });
      assert.equal(result.status, "completed", result.content);
      assert.match(result.content, /不存在（文件不存在）/);
      assert.doesNotMatch(result.content, /\[不存在\]\(missing.docx\)/);
      assert.equal(mainRounds, 2, "link validation never starts another model round");
      assert.equal(commands, waived ? 0 : 1);
      assert.equal(approvals, 0, "full auto must reach the executor without asking the user");
      assert.equal(await readFile(join(root, "core.js"), "utf8"), "export const ready = true;\n");
      assert.ok(reviews >= 2, "skipping executable tests must retain independent static review");
      if (waived) { assert.match(result.content, /已交付·未验证/); assert.equal(result.selfCheck.verification.waived, true); assert.equal(result.selfCheck.verification.passed, false); }
      else { assert.match(result.content, /已交付·验证不可用/); assert.equal(result.selfCheck.verification.passed, false); assert.equal(result.selfCheck.verification.results.length, 1); }
    } finally { clearTimeout(timeout); controller.abort(); }
  }
  console.log("Actual runtime full-auto wiring, saved work on unavailable verification, explicit unverified delivery with static review: PASS");
} finally { globalThis.fetch = originalFetch; await rm(temp, { recursive: true, force: true }); }
