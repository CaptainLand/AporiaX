import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runHarness } from "../electron/agent-runtime.js";

const root = await mkdtemp(join(tmpdir(), "aporia-concurrency-"));
const originalFetch = globalThis.fetch;
const controller = new AbortController();
const events = [];
const timeout = setTimeout(() => {
  console.error("Concurrency deadline:", JSON.stringify({ order, rounds, events: events.slice(-14).map(({ type, role, agentId, error, detail }) => ({ type, role, agentId, error: String(error || "").slice(0, 180), detail: String(detail || "").slice(0, 180) })) }));
  controller.abort();
}, 20000);
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const mainStarted = defer();
const dependentStarted = defer();
function waitFor(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("Test run aborted"), { name: "AbortError" }));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
  });
}
const sse = (delta) => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
const call = (id, name, input) => sse({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] });
const provider = { id: "parallel-test", name: "test", vendor: "openai", baseUrl: "https://test.invalid/v1", apiKey: "test-only",
  models: [{ id: "test", supportsTools: true, supportsThinking: false, contextWindow: 128000 }] };
const rounds = { a: 0, b: 0, main: 0 };
const order = [];
try {
  for (const args of [["init"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Test"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr);
  }
  for (const name of ["a.txt", "b.txt", "shared.txt"]) await writeFile(join(root, name), "version one\n");
  for (const args of [["add", "."], ["commit", "-m", "baseline"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr);
  }
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const text = body.messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
    if (text.includes("AporiaX Harness orchestration preflight.")) return sse({ content: JSON.stringify({ parallelize: true,
      contract: { title: "Version contract", invariants: [{ key: "version", value: "two", severity: "must" }], sharedFiles: ["shared.txt"], acceptance: ["All files say version two"] },
      tasks: [
        { id: "a", task: "Update a.txt to version two", writeScopes: ["a.txt"], approvedPlan: { approach: "Update the version" } },
        { id: "b", task: "Update b.txt after a is merged", writeScopes: ["b.txt"], dependsOn: ["a"], approvedPlan: { approach: "Use a handoff" } },
      ], mainTask: { task: "Independently update shared.txt to version two", writeScopes: ["shared.txt"] },
    }) });
    const builder = text.match(/AporiaX Builder worker \((a|b)\)/)?.[1];
    const role = builder || (text.includes("You are AporiaX Lead/Main, doing independent scoped implementation") ? "main" : null);
    if (role) {
      const round = ++rounds[role];
      const path = role === "main" ? "shared.txt" : `${role}.txt`;
      if (round === 1) {
        order.push(`${role}:start`);
        if (role === "a") await waitFor(mainStarted.promise, options.signal);
        if (role === "main") { mainStarted.resolve(); await waitFor(dependentStarted.promise, options.signal); }
        if (role === "b") dependentStarted.resolve();
        return call(`${role}-write`, "write_file", { path, content: "version two\n" });
      }
      if (round === 2 || round === 4) return call(`${role}-check-${round}`, "complete_self_check", {
        summary: `${role} scoped implementation checked`, checks: ["latest scoped file re-read"], improvements: [], remaining_risks: [],
      });
      if (round === 3) return call(`${role}-read`, "read_file", { path });
      assert.ok(round < 6, `unexpected worker loop ${role}`);
      order.push(`${role}:finish`);
      return sse({ content: JSON.stringify({ summary: `${role} updated`, assumptions: [], requiresMain: [],
        contractAssertions: [{ key: "version", value: "two", evidence: path }], messages: [] }) });
    }
    assert.ok(text.includes("AporiaX Harness orchestration update for the Lead/Main agent."));
    for (const path of ["a.txt", "b.txt", "shared.txt"]) assert.equal(await readFile(join(root, path), "utf8"), "version two\n");
    return sse({ content: "All scoped work integrated." });
  };
  const result = await runHarness({ runId: "concurrent-main-test", taskId: "test", provider, modelId: "test", workspacePath: root,
    agentBudget: { profile: "large" },
    permission: "workspace-write", approvalMode: "manual", thinking: false, signal: controller.signal, language: "en",
    messages: [{ role: "user", content: "Large multi-module architecture refactor with independent Builder tasks and Main work." }],
    sandboxStatusResolver: async () => ({ available: false, state: "unavailable", autoApprovalSafe: false }),
    requestApproval: async () => ({ approved: false }), onEvent: (event) => events.push(event) });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.orchestration.error, null);
  assert.equal(result.orchestration.semanticCheck.passed, true);
  assert.ok(order.indexOf("main:start") < order.indexOf("a:finish"), "Main must make progress while A is working");
  assert.ok(order.indexOf("b:start") < order.indexOf("main:finish"), "B must start as soon as A finishes, without waiting for unrelated Main work");
  assert.equal(events.filter((event) => event.type === "subagent.started" && event.role === "main").length, 1);
  assert.equal(result.changes.length, 3);
  console.log("Concurrent Main + Builder dependency release + isolated merge: PASS");
} finally {
  clearTimeout(timeout); controller.abort(); globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
