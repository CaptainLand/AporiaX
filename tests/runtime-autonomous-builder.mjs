import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runHarness, shouldUseBuilderOrchestration } from "../electron/agent-runtime.js";
import { runIsolatedBuilder } from "../electron/runtime/delegated-builder.js";
import { withDurableRun } from "../electron/runtime/durable-run.js";
import { createKernelAgentRuntimeBroker, setDefaultAgentRuntimeBroker, clearDefaultAgentRuntimeBroker } from "../electron/harness/agent-runtime-broker.js";
import { createAgentDefinitionRegistry } from "../electron/harness/agent-definitions.js";
import { HarnessSessionStore } from "../electron/harness/session.js";
import { HarnessScheduler } from "../electron/harness/scheduler.js";
import { planAgentBudget, runWithAgentBudget, withAgentBudgetAdmission, enforceAgentBudgetEvent, currentAgentBudget, restoreAgentBudget } from "../electron/harness/agent-budget.js";
const git = (cwd, args) => { const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true }); assert.equal(r.status, 0, r.stderr); };
const root = await mkdtemp(join(tmpdir(), "aporia-autonomous-builder-"));
const fetchOriginal = globalThis.fetch;
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30000);
try {
  git(root, ["init"]);
  await mkdir(join(root, "src")); await writeFile(join(root, "src/a.txt"), "before"); await writeFile(join(root, "other.txt"), "untouched");
  git(root, ["add", "."]); git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);
  const kernel = { agents: createAgentDefinitionRegistry(), sessions: new HarnessSessionStore(), scheduler: new HarnessScheduler({ concurrency: 4 }) };
  setDefaultAgentRuntimeBroker(createKernelAgentRuntimeBroker({ kernel }));
  const sse = (delta) => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
  const call = (id, name, input) => sse({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] });
  let main = 0, worker = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const text = body.messages.map((m) => m.content || "").join("\n");
    assert(!text.includes("Harness orchestration preflight"), "default avoids an extra planner round");
    if (text.includes("You are the AporiaX builder subagent.")) {
      assert(!body.tools.some((tool) => ["delegate_subagent", "run_command", "github_push"].includes(tool.function.name)));
      if (++worker === 1) return call("outside", "apply_patch", { path: "src/a.txt", patch: "--- a/other.txt\n+++ b/other.txt\n@@ -1 +1 @@\n-untouched\n+oops\n" });
      if (worker === 2) { assert.match(text, /outside.*scope/i); return call("write", "write_file", { path: "src/a.txt", content: "after" }); }
      return sse({ content: "Implemented a.txt; no tests were run." });
    }
    if (++main === 1) return call("spawn", "delegate_subagent", { role: "builder", task: "Change src/a.txt to after, preserve other files.", write_scopes: ["src/a.txt"], background: true });
    if (main === 2) return call("collect", "collect_subagents", { wait: true });
    assert.equal(await readFile(join(root, "src/a.txt"), "utf8"), "after");
    return call("finish", "finish_task", { status: "completed", summary: "Updated a.txt. Tests not run." });
  };
  const events = [];
  const result = await runHarness({ runId: "autonomous", workspacePath: root, permission: "workspace-write", approvalMode: "full-auto", signal: controller.signal, language: "en",
    messages: [{ role: "user", content: "Modify one file." }], onEvent: (e) => events.push(e),
    provider: { id: "fake", name: "fake", vendor: "openai", baseUrl: "https://test.invalid/v1", apiKey: "fake", models: [{ id: "test", supportsTools: true, contextWindow: 32000 }] }, modelId: "test" });
  assert.equal(result.status, "completed", JSON.stringify({ result, events }, null, 2)); assert.equal(result.subagents.length, 1);
  assert(result.changes.some((change) => change.path === "src/a.txt"));
  assert(events.some((e) => e.type === "builder.merge.completed"));
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "untouched");
  assert.equal(kernel.sessions.get("autonomous-sub-1").state, "completed");
  clearDefaultAgentRuntimeBroker();
  const saved = new Map(), session = {};
  const workerOptions = { agentId: "resume-builder", workspaceRoot: root, input: { role: "builder", task: "partial", scope: ["."], writeScopes: ["src/a.txt"] }, session, emit: () => {} };
  await withDurableRun({ context: async (id, value) => saved.set(id, JSON.parse(value)), operation: async () => {} }, async () => {
    const partial = await runIsolatedBuilder(workerOptions, async ({ workspaceRoot: isolated }) => {
      await writeFile(join(isolated, "src/a.txt"), "partial edit"); return { status: "budget_exhausted", summary: "More work needed" };
    });
    assert.equal(partial.integrated, false);
    assert.equal(await readFile(join(root, "src/a.txt"), "utf8"), "after");
    assert.equal(saved.get("resume-builder").session.provisionalChanges[0].afterContent, "partial edit");
    await runIsolatedBuilder(workerOptions, async ({ workspaceRoot: isolated }) => {
      assert.equal(await readFile(join(isolated, "src/a.txt"), "utf8"), "partial edit");
      return { status: "completed", summary: "Finished continuation" };
    });
    assert.equal(await readFile(join(root, "src/a.txt"), "utf8"), "partial edit");
    await runIsolatedBuilder(workerOptions, async ({ workspaceRoot: isolated }) => {
      await writeFile(join(isolated, "src/a.txt"), "conflicting edit");
      await writeFile(join(root, "src/a.txt"), "parent edit");
      return { status: "completed", summary: "Worker finished" };
    });
    assert.equal(saved.get("resume-builder").status, "blocked");
    assert.equal(await readFile(join(root, "src/a.txt"), "utf8"), "parent edit");
    assert.equal(session.provisionalChanges[0].afterContent, "conflicting edit");
  });
  assert.equal(shouldUseBuilderOrchestration({ workspacePath: root, permission: "workspace-write" }, planAgentBudget({ agentBudget: { profile: "large" } })), false);
  let active = 0, peak = 0;
  const budget = planAgentBudget({ workspacePath: root, agentBudget: { profile: "large", maxTotalSubagents: 4, maxActiveSubagents: 1, roles: { explore: 4 } } });
  let snapshot;
  await runWithAgentBudget(budget, {}, async () => {
    await Promise.all(Array.from({ length: 4 }, (_, i) => withAgentBudgetAdmission({ role: "explore" }, async () => {
      enforceAgentBudgetEvent({ type: "subagent.started", agentId: String(i), role: "explore" });
      peak = Math.max(peak, ++active); await new Promise((done) => setTimeout(done, 3)); active--;
      enforceAgentBudgetEvent({ type: "subagent.completed", agentId: String(i) });
    })));
    snapshot = currentAgentBudget(); assert.equal(snapshot.state.totalStarted, 4);
  });
  assert.equal(peak, 1);
  await runWithAgentBudget(budget, {}, async () => {
    restoreAgentBudget(snapshot);
    assert.throws(() => enforceAgentBudgetEvent({ type: "subagent.started", agentId: "new", role: "explore" }), /budget/i);
    enforceAgentBudgetEvent({ type: "subagent.started", agentId: "0", role: "explore" });
    assert.equal(currentAgentBudget().state.totalStarted, 4);
  });
} finally { clearTimeout(timeout); clearDefaultAgentRuntimeBroker(); globalThis.fetch = fetchOriginal; await rm(root, { recursive: true, force: true }); }
console.log("Autonomous Builder: default no preflight, scoped native tools, isolated integration, durable partial continuation, conflict retention, queued admission and restored budgets: PASS");
