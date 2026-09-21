import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectUnderstandingStore } from "../electron/project-understanding.js";
import { createSkillRegistry, parseSkillDocument } from "../electron/harness/skills/registry.js";
import { prepareSkillRequest, prepareSkillMessage } from "../electron/skill-runtime.js";
import { createMcpRuntime } from "../electron/mcp-runtime.js";
import { runHarness } from "../electron/agent-runtime.js";
import { upsertRelevantContextMessage, buildStructuredContextCheckpoint } from "../electron/agent-context.js";

const root = await mkdtemp(join(tmpdir(), "aporia-context-foundation-"));
const originalFetch = globalThis.fetch;
try {
  const workspaceRoot = join(root, "workspace"); await mkdir(workspaceRoot);
  const baseDirectory = join(root, "knowledge");
  const options = { baseDirectory, workspaceRoot };
  const oldConversation = [{ role: "system", content: 'AporiaX durable context checkpoint:\n{"requirements":["Keep the requested task"],"relevantMemory":[{"content":"OLD_MEMORY_SENTINEL"}]}' }, { role: "user", content: "Keep working" }];
  upsertRelevantContextMessage(oldConversation);
  assert(!JSON.stringify(oldConversation).includes("OLD_MEMORY_SENTINEL"));
  assert(JSON.stringify(oldConversation).includes("Keep the requested task"));
  assert.deepEqual(buildStructuredContextCheckpoint([], { relevantMemory: [{ content: "do not freeze this" }] }).relevantMemory, []);
  const first = await createProjectUnderstandingStore(options);
  const second = await createProjectUnderstandingStore(options);
  await writeFile(join(workspaceRoot, "database.txt"), "initial evidence");
  await first.commit({ changes: [
    { content: "DATABASE_SENTINEL Postgres deadlock diagnostics use pg_locks", confidence: .9, evidence: [{ type: "file", reference: "database.txt" }] },
    { content: "PASTEL_SENTINEL Marketing pages should use pastel colors", confidence: .99 },
  ] });
  assert.deepEqual(first.snapshot().settings, { useForContext: false, autoCurate: false });
  assert.deepEqual(await first.contextFacts("Postgres deadlock"), []);
  assert.equal(first.retrieve("Postgres deadlock").length, 1);
  assert.deepEqual(first.retrieve("zzzzzz unrelatedword"), []);
  assert.deepEqual(first.retrieve(""), []);
  await second.setSettings({ useForContext: true });
  assert.equal((await first.contextFacts("Postgres")).length, 1);
  await writeFile(join(workspaceRoot, "database.txt"), "changed evidence");
  assert.deepEqual(await first.contextFacts("Postgres"), []);
  assert.equal(first.snapshot().facts.length, 2, "stale facts remain viewable");
  await first.commit({ changes: [{ content: "DATABASE_SENTINEL Postgres deadlock diagnostics use pg_locks", confidence: .9, evidence: [{ type: "file", reference: "database.txt" }] }] });
  assert.equal((await second.contextFacts("Postgres")).length, 1, "reconfirmed file is eligible again");
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).commit({ changes: [{ content: `Concurrent unique fact ${i}` }] })));
  await first.refresh();
  assert.equal(first.snapshot().facts.length, 14);
  assert.equal(first.snapshot().currentRevision, 14);
  assert.equal(first.snapshot().settings.useForContext, true);
  const disk = JSON.parse(await readFile(first.path, "utf8"));
  disk.facts.find((fact) => fact.content.includes("DATABASE_SENTINEL")).lastConfirmedAt = "2020-01-01T00:00:00Z";
  await writeFile(first.path, JSON.stringify(disk));
  assert.deepEqual(await first.contextFacts("Postgres"), []);

  // Exercise the actual main request, not just the retrieval helper.
  await first.commit({ changes: [{ content: "DATABASE_SENTINEL Postgres deadlock diagnostics use pg_locks", evidence: [{ type: "file", reference: "database.txt" }] }] });
  for (const enabled of [false, true]) {
    await first.setSettings({ useForContext: enabled, autoCurate: false });
    let calls = 0;
    globalThis.fetch = async (_url, request) => {
      calls++;
      const body = JSON.parse(request.body);
      assert(!body.messages[0].content.includes("DATABASE_SENTINEL"), "root system never holds memory copies");
      const text = body.messages.map((item) => String(item.content || "")).join("\n");
      assert.equal(text.includes("DATABASE_SENTINEL"), false, "Legacy useForContext no longer causes automatic injection");
      assert(!text.includes("PASTEL_SENTINEL"));
      assert(!body.tools?.some((tool) => tool.function.name === "remember_project_fact"));
      assert(!body.messages[0].content.includes("AporiaX curator subagent"));
      return new Response('data: {"choices":[{"delta":{"content":"Explanation complete."}}]}\n\ndata: [DONE]\n\n');
    };
    const result = await runHarness({ runId: `recall-${enabled}`, workspacePath: workspaceRoot, understandingDirectory: baseDirectory,
      provider: { id: "test", name: "test", vendor: "openai", baseUrl: "https://test.invalid/v1", apiKey: "fake", models: [{ id: "test", supportsTools: true, contextWindow: 32000 }] },
      modelId: "test", permission: "read-only", messages: [{ role: "user", content: "Explain Postgres deadlock diagnostics; do not change files." }],
    });
    assert.equal(result.status, "completed"); assert.equal(calls, 1, "no automatic Curator request");
  }

  const registry = createSkillRegistry();
  for (const name of ["first-skill", "second-skill", "third-skill"]) registry.register(parseSkillDocument(`---\nname: ${name}\nauto: false\n---\nFull workflow for ${name}.`), { builtin: true });
  const prompt = "@skill:first-skill @skill:second-skill @skill:third-skill";
  const request = { workspacePath: workspaceRoot, messages: [{ id: "u", role: "user", content: prompt }] };
  const prepared = await prepareSkillRequest(request, { registry });
  assert.equal(prepared.activatedSkills.length, 3);
  const again = await prepareSkillRequest(prepared, { registry });
  assert.equal(again.messages[0].content, prepared.messages[0].content, "retry never duplicates instruction blocks");
  assert.deepEqual((await prepareSkillMessage({ content: "@skill:missing-skill" }, workspaceRoot, { registry })).unresolvedSkills, ["missing-skill"]);
  const emptyRegistry = createSkillRegistry();
  const removed = await prepareSkillRequest(prepared, { registry: emptyRegistry });
  assert.equal(removed.messages[0].content, prompt, "missing skills remove stale injected instructions");
  const longSkill = parseSkillDocument(`---\nname: long-skill\nauto: false\n---\n${"L".repeat(49_000)}END_OF_COMPLETE_SKILL`);
  assert(longSkill.instructions.endsWith("END_OF_COMPLETE_SKILL"));
  registry.register(longSkill, { builtin: true });
  registry.register(parseSkillDocument(`---\nname: another-long\nauto: false\n---\n${"X".repeat(49_000)}`), { builtin: true });
  await assert.rejects(() => prepareSkillMessage({ content: "@skill:long-skill @skill:another-long" }, workspaceRoot, { registry }), /SKILL_CONTEXT_BUDGET_EXCEEDED/);

  const events = []; let broken = true; let connections = 0; let invocations = 0;
  const large = { content: Array.from({ length: 70 }, (_, i) => ({ type: "text", text: `${i}:中文🙂`.repeat(200) })), structuredContent: { tail: "TAIL_MARKER", big: "a".repeat(40_000) }, isError: false };
  const runtime = createMcpRuntime({ servers: [{ id: "demo", name: "Demo", enabled: true, timeoutMs: 1000, autoApproveReadOnly: true }], emit: (event) => events.push(event),
    transportFactory: () => ({ async close() {} }), clientFactory: () => ({
      async connect() { connections++; }, getServerCapabilities() { return { tools: {} }; },
      async listTools() { if (broken) throw new Error("tools/list permission denied"); return { tools: [{ name: "read_big", annotations: { readOnlyHint: true } }] }; },
      async callTool() { invocations++; return large; }, async close() {},
    }),
  });
  try {
    const [a, b] = await Promise.all([runtime.discover(), runtime.discover()]);
    assert.equal(connections, 1); assert.equal(a.errors.length, 1); assert.equal(b.errors.length, 1);
    assert.equal(a.servers[0].connected, false); assert.equal(a.servers[0].discoveryStatus, "failed");
    assert(!events.some((event) => event.type === "mcp.server.connected"));
    const stillBroken = await runtime.discover(); assert.equal(stillBroken.errors.length, 1);
    broken = false;
    const good = await runtime.discover(); assert.equal(good.errors.length, 0); assert.equal(good.servers[0].connected, true);
    assert.equal(good.tools.length, 1);
    const output = await runtime.call(good.tools[0].name);
    assert(output.resultRef?.id); assert(JSON.stringify(output).length < 15_000);
    let text = ""; let offset = 0;
    do {
      const page = await runtime.call("mcp_read_result", { result_id: output.resultRef.id, offset, limit: 777 });
      text += page.text; offset = page.nextOffset;
    } while (offset !== null);
    assert.deepEqual(JSON.parse(text), large); assert.equal(invocations, 1);
    await assert.rejects(() => runtime.call("mcp_read_result", { result_id: "../other-task.json" }), /Unknown or expired/);
  } finally { await runtime.close(); }
  await assert.rejects(() => runtime.discover(), /closed/);

  const resourcesOnly = createMcpRuntime({ servers: [{ id: "resources", timeoutMs: 1000 }], transportFactory: () => ({ async close() {} }), clientFactory: () => ({
    async connect() {}, getServerCapabilities() { return { resources: {} }; },
    async listTools() { throw new Error("must not request unsupported tools"); },
    async listResources() { return { resources: [] }; }, async close() {},
  }) });
  try { assert.deepEqual((await resourcesOnly.discover()).errors, []); } finally { await resourcesOnly.close(); }
  console.log("Context foundations: opt-in memory, relevance/freshness/concurrency, real request isolation, explicit skills/completeness/retry, MCP failure/retry and lossless paged results: PASS");
} finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
