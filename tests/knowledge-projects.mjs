import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectUnderstandingStore } from "../electron/project-understanding.js";
import { createKnowledgeWorkspace, createKnowledgeSession } from "../electron/knowledge-projects.js";
import { runHarness } from "../electron/agent-runtime-core.js";
import { createTaskHistoryStore } from "../electron/task-history-store.js";

// Match the physical root used by runHarness, including Windows short TEMP aliases.
const root = await realpath(await mkdtemp(join(tmpdir(), "aporia-knowledge-projects-")));
const originalFetch = globalThis.fetch;
try {
  const workspaceRoot = join(root, "workspace"), baseDirectory = join(root, "knowledge");
  await mkdir(workspaceRoot);
  const options = { workspaceRoot, baseDirectory };
  const legacy = await createProjectUnderstandingStore(options);
  await legacy.commit({ changes: [{ content: "LEGACY_UNRELATED_SENTINEL", evidence: [{ type: "user", reference: "Old user preference" }] }] });
  await legacy.setSettings({ useForContext: true });
  const before = await readFile(legacy.path, "utf8");
  const workspace = await createKnowledgeWorkspace(options);
  const creations = await Promise.all(Array.from({ length: 8 }, () => workspace.create({ name: "Alpha", taskId: "t1" })));
  assert.equal(new Set(creations.map((item) => item.project.id)).size, 1);
  assert.equal(creations.filter((item) => item.created).length, 1);
  const alpha = creations[0].project, beta = (await workspace.create({ name: "Beta" })).project;
  assert.equal((await workspace.list()).length, 3);
  assert.equal(await readFile(legacy.path, "utf8"), before, "Legacy bytes and history remain untouched");
  await assert.rejects(() => workspace.open("../../escape"), /workspace/);
  await assert.rejects(() => workspace.create({ name: "bad", directory: "../other" }), /workspace-relative/);
  await assert.rejects(() => workspace.create({ name: "api_key=secretvalue" }), /Secrets/);
  const a = await workspace.open(alpha.id), b = await workspace.open(beta.id);
  await writeFile(join(workspaceRoot, "alpha.txt"), "evidence v1");
  await a.commit({ changes: [{ content: "ALPHA_SENTINEL PostgreSQL architecture", evidence: [{ type: "file", reference: "alpha.txt" }] }] });
  await a.setSettings({ useForContext: true });
  await b.commit({ changes: [{ content: "BETA_UNRELATED_SENTINEL unrelated architecture", evidence: [{ type: "user", reference: "User decision" }] }] });
  assert.equal((await a.readKnowledge({ query: "architecture" })).facts.length, 1);
  const events = [];
  const session = await createKnowledgeSession({ ...options, enabled: true, projectId: alpha.id, canWrite: true, taskId: "t1", emit: (e) => events.push(e) });
  const read = await session.call({ action: "search", query: "PostgreSQL" });
  assert.equal(read.facts[0].knowledgeProjectId, alpha.id);
  assert.deepEqual(read.facts[0].warnings, []);
  await assert.rejects(() => session.call({ action: "select", project_id: beta.id }), /bound/);
  await writeFile(join(workspaceRoot, "alpha.txt"), "evidence v2");
  assert.deepEqual((await session.call({ action: "read", fact_ids: [read.facts[0].id] })).facts[0].warnings, ["file_changed_or_unavailable"]);
  await assert.rejects(() => session.call({ action: "save", content: "no evidence" }), /evidence/);
  const saved = await session.call({ action: "save", category: "preference", content: "ALPHA uses Chinese docs", evidence: [{ type: "user", reference: "Explicit request in task t1" }] });
  assert.equal(saved.committed, true);
  await b.refresh(); assert.equal(b.snapshot().facts.length, 1, "No cross-project writes");
  const disabled = await createKnowledgeSession({ ...options, enabled: false, projectId: alpha.id });
  await assert.rejects(() => disabled.call({ action: "list" }), /disabled/);
  const readOnly = await createKnowledgeSession({ ...options, enabled: true });
  await assert.rejects(() => readOnly.call({ action: "create", name: "Gamma" }), /write/);
  await readOnly.call({ action: "select", project_id: alpha.id });
  await assert.rejects(() => readOnly.call({ action: "save", content: "x" }), /write/);
  const auto = await createKnowledgeSession({ ...options, enabled: true, canWrite: true });
  const autoCreated = await auto.call({ action: "create", name: "Gamma" });
  assert.equal(auto.projectId, autoCreated.project.id);
  const otherRoot = join(root, "other"); await mkdir(otherRoot);
  await assert.rejects(() => createKnowledgeSession({ baseDirectory, workspaceRoot: otherRoot, enabled: true, projectId: alpha.id }), /workspace/);
  assert(events.some((event) => event.type === "knowledge.read"));
  const taskStore = createTaskHistoryStore(join(root, "task-data"));
  await taskStore.saveTasks([{ id: "knowledge-task", title: "Knowledge task", workspacePath: workspaceRoot, knowledgeEnabled: true, knowledgeProjectId: alpha.id, knowledgeReads: [{ projectId: alpha.id, count: 1 }], messages: [] }]);
  const reloadedTask = (await createTaskHistoryStore(join(root, "task-data")).loadTasks())[0];
  assert.equal(reloadedTask.knowledgeEnabled, true);
  assert.equal(reloadedTask.knowledgeProjectId, alpha.id);
  assert.equal(reloadedTask.knowledgeReads.length, 1, "Real task history retains settings and read records across restarts");

  // Actual provider requests: enabling the task exposes a tool, not the facts.
  await a.setSettings({ autoCurate: true }); // A read-only task must not start a writer/Curator.
  const testProvider = { id: "test", name: "test", vendor: "openai", baseUrl: "https://test.invalid/v1", apiKey: "fake", models: [{ id: "test", supportsTools: true, contextWindow: 32000 }] };
  const recovery = { runId: "previous", contexts: { previous: { kind: "main", workspaceRoot, knowledgeProjectId: alpha.id } } };
  await assert.rejects(() => runHarness({ provider: testProvider, modelId: "test", workspacePath: workspaceRoot, understandingDirectory: baseDirectory, knowledgeEnabled: true, knowledgeProjectId: beta.id, recoveryContext: recovery, messages: [{ role: "user", content: "Resume" }] }), /RECOVERY_KNOWLEDGE_PROJECT_MISMATCH/);
  for (const scenario of ["disabled", "enabled", "recovered"]) {
    const enabled = scenario !== "disabled";
    let calls = 0;
    globalThis.fetch = async (_url, request) => {
      calls++;
      const body = JSON.parse(request.body);
      const text = body.messages.map((m) => String(m.content || "")).join("\n");
      assert(!text.includes("BETA_UNRELATED_SENTINEL") && !text.includes("LEGACY_UNRELATED_SENTINEL"));
      assert.equal(Boolean(body.tools?.some((tool) => tool.function.name === "project_knowledge")), enabled);
      assert(!body.tools?.some((tool) => tool.function.name === "remember_project_fact"), "Read-only tasks must not stage automatic writes");
      assert.equal(text.includes("ALPHA_SENTINEL"), enabled && calls > 1, "Facts appear only after an explicit tool read");
      const delta = enabled && calls === 1 ? { tool_calls: [{ index: 0, id: "read-knowledge", type: "function", function: { name: "project_knowledge", arguments: JSON.stringify({ action: "search", query: "PostgreSQL" }) } }] } : { content: "Explanation complete." };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
    };
    const result = await runHarness({ runId: `knowledge-${enabled}`, taskId: "test", workspacePath: workspaceRoot, understandingDirectory: baseDirectory,
      knowledgeEnabled: enabled, knowledgeProjectId: scenario === "recovered" ? "" : alpha.id, recoveryContext: scenario === "recovered" ? recovery : null,
      provider: testProvider,
      modelId: "test", permission: "read-only", messages: [{ role: "user", content: "Explain PostgreSQL architecture. Do not edit files." }] });
    assert.equal(result.status, "completed"); assert.equal(calls, enabled ? 2 : 1, "No automatic Curator calls");
  }
  console.log("PASS knowledge projects: legacy preservation, atomic/idempotent creation, scope isolation, locks, evidence freshness, disabled/read-only policy, explicit save and actual provider on-demand read.");
} finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
