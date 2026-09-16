import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runHarness } from "../electron/agent-runtime-core.js";

const root = await mkdtemp(join(tmpdir(), "aporia-sandbox-harness-"));
const workspace = join(root, "workspace"), data = join(root, "data");
const originalFetch = globalThis.fetch;
const events = [];
try {
  await mkdir(workspace);
  await writeFile(join(workspace, "worker.cjs"), "require('fs').writeFileSync('important.txt','retained output');process.exit(2);");
  let rounds = 0;
  globalThis.fetch = async () => {
    const delta = ++rounds === 1 ? { tool_calls: [{ index: 0, id: "cmd", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "node worker.cjs" }) } }] } : { content: "命令失败，检查保留产物后继续。" };
    return new Response("data: " + JSON.stringify({ choices: [{ delta }] }) + "\n\ndata: [DONE]\n\n");
  };
  const result = await runHarness({ runId: "recovery-run", taskId: "recovery-task", workspacePath: workspace, sandboxDataDirectory: data,
    provider: { id: "fixture", name: "fixture", vendor: "openai", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", models: [{ id: "fixture", supportsTools: true, supportsThinking: false }] },
    modelId: "fixture", permission: "workspace-write", approvalMode: "full-auto", thinking: false,
    sandboxStatusResolver: async () => ({ executionProfile: "safe", available: false, localAvailable: true }),
    messages: [{ role: "user", content: "运行 worker.cjs，如果失败就保留产物并告诉我。" }], onEvent: (event) => events.push(event),
  });
  assert.equal(result.status, "completed");
  assert.equal(rounds, 2);
  const recovery = result.sandbox.recoveries[0];
  assert.equal(await readFile(join(recovery.workspace, "important.txt"), "utf8"), "retained output");
  assert.match(recovery.directory, /data/);
  assert.equal(recovery.runId, "recovery-run");
  assert.match(result.content, /\[查看保留产物 1\]\(file:/);
  assert.ok(events.some((event) => event.type === "sandbox.recovery"));
  console.log("PASS sandbox Harness integration: real failed command, durable app-data recovery, emitted event, final clickable handoff, no extra model rounds.");
} finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
