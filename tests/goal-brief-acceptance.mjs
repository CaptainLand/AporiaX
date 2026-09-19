import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBrief } from "../electron/runtime/task-brief.js";
import { TaskAcceptance, loadTaskContract, normalizeTaskContract } from "../electron/runtime/task-acceptance.js";
import { summarizeTaskBrief, briefSummarySources } from "../electron/runtime/brief-summarizer.js";
import { compactConversationForRequest, createTokenAccounting } from "../electron/agent-context.js";
import { taskRequest, providerMessages } from "../electron/runtime/task-conversation.js";
import { suite } from "./goal-loop-fixtures.mjs";
const { test, finish } = suite("goal-brief-acceptance");
const root = await mkdtemp(join(tmpdir(), "aporia-goal-check-"));
const contract = (checks, extra = {}) => ({ version: 1, enforce: true, requirements: [{ id: "r1", text: "Required behavior", checks }], ...extra });
const record = { action: "record", expected_revision: 0, kind: "decision", summary: "Keep the original file", rationale: "A real read showed migration still depends on it.", evidence_call_ids: ["read-1"] };
try {
  await test("brief requires current revision and observed evidence, not a model's invented call", () => {
    const brief = new TaskBrief(null, { ownerKey: "task-A" });
    assert.throws(() => brief.apply(record), /UNKNOWN_EVIDENCE/);
    brief.observe({ callId: "read-1", tool: "read_file", input: { path: "a" }, result: { path: "a", sha256: "real-fixture-hash" }, version: "v1" });
    const first = brief.apply(record); assert.equal(first.revision, 1); assert.equal(first.entries[0].assertion, "agent-recorded-not-verified");
    assert.throws(() => brief.apply(record), /REVISION_CONFLICT/);
    brief.apply({ ...record, expected_revision: 1, summary: "Use a separate migration journal", supersedes: "decision-1" });
    assert.equal(brief.snapshot().entries[0].supersededBy, "decision-2"); assert.equal(brief.snapshot().entries.length, 2);
    assert.equal(brief.view("v2").entries[1].evidence[0].historical, true);
    const resumed = new TaskBrief(brief.snapshot(), { resumed: true, ownerKey: "task-A" });
    assert.equal(resumed.snapshot().entries[1].evidence[0].historical, true);
    assert.throws(() => new TaskBrief(brief.snapshot(), { ownerKey: "other-task" }), /OWNER_MISMATCH/);
  });
  await test("brief survives repeated compaction with original constraints and no provenance on wire", () => {
    const brief = new TaskBrief(); brief.apply({ ...record, evidence_call_ids: [] });
    const conversation = [{ role: "system", content: "Rules" }, taskRequest({ role: "user", content: "NEVER_REMOVE_ORIGINAL" })];
    const checkpoints = [];
    for (let i = 0; i < 3; i++) {
      conversation.push(...Array.from({ length: 30 }, (_, j) => ({ role: "assistant", content: `old ${i}:${j} ` + "中".repeat(900) })));
      brief.inject(conversation);
      compactConversationForRequest({ conversation, contextCheckpoints: checkpoints, accounting: createTokenAccounting(), contextWindowTokens: 32000, inputBudgetTokens: 10000 });
      assert(conversation.some((m) => m.aporiaTaskBrief && m.content.includes("migration still depends")));
      assert(conversation.some((m) => m.content === "NEVER_REMOVE_ORIGINAL"));
    }
    assert(checkpoints.length >= 3); assert(providerMessages(conversation).every((m) => m.aporiaTaskBrief === undefined));
    assert.equal(brief.snapshot().entries.length, 1);
  });
  await test("automatic summary accepts exact public sources only, never promotes a quote to truth", async () => {
    const brief = new TaskBrief(), conversation = [{ role: "assistant", content: "We rejected deleting the legacy file because it may be the only recoverable original." }, ...Array.from({ length: 8 }, () => ({ role: "assistant", content: "recent" }))];
    let charged = 0, called = 0;
    const selectedProvider = { complete: async ({ body }) => {
      called++; assert.equal(body.tools, undefined);
      const { sources, expected_revision } = JSON.parse(body.messages[1].content);
      return { message: { content: JSON.stringify({ expected_revision, entries: [{ kind: "rejected", summary: "Do not discard originals", source_id: sources[0].id, quote: "deleting the legacy file" }] }) }, usage: { prompt_tokens: 20, completion_tokens: 10 } };
    } };
    assert.equal(await summarizeTaskBrief({ brief, conversation, provider: selectedProvider, modelId: "same-selected-model", onUsage: () => charged++ }), true);
    assert.equal(called, 1); assert.equal(charged, 1); assert.equal(brief.snapshot().entries[0].assertion, "agent-recorded-not-verified");
    const before = JSON.stringify(brief.snapshot());
    assert.throws(() => brief.applySummary({ expected_revision: 1, entries: [{ kind: "decision", summary: "Invented", source_id: briefSummarySources(conversation)[0].id, quote: "a quote that was never said" }] }, briefSummarySources(conversation)), /SOURCE_INVALID/);
    assert.equal(JSON.stringify(brief.snapshot()), before);
  });
  await test("summary interrupted by guidance cannot commit a stale model interpretation", async () => {
    const brief = new TaskBrief(); let guidance = false;
    const conversation = [{ role: "assistant", content: "We decided to preserve all old user data during migration." }, ...Array.from({ length: 8 }, () => ({ role: "assistant", content: "recent" }))];
    assert.equal(await summarizeTaskBrief({ brief, conversation, modelId: "fixture", shouldYield: () => guidance, provider: { complete: async () => { guidance = true; return { message: { content: '{"expected_revision":0,"entries":[]}' } }; } } }), false);
    assert.equal(brief.snapshot().revision, 0);
  });
  await test("schema rejects traversal, arbitrary executable predicates and prototype paths", () => {
    for (const path of ["../secret", "/secret", "C:\\secret", "a/../../secret", "\\\\server\\share"]) assert.throws(() => normalizeTaskContract(contract([{ type: "file_exists", path }])));
    assert.throws(() => normalizeTaskContract(contract([{ type: "javascript", script: "anything" }])), /UNSUPPORTED/);
    assert.throws(() => normalizeTaskContract(contract([{ type: "json_value", path: "a", keys: ["__proto__"], equals: true }])), /JSON_PATH/);
    assert.throws(() => normalizeTaskContract(contract([{ type: "command_exit", command: "npm test", inputs: [] }])), /REQUIRES_INPUTS/);
    assert.throws(() => normalizeTaskContract({ ...contract([]), enforce: "false" }));
  });
  await test("file predicates inspect actual contents; an unchecked requirement needs review", async () => {
    await writeFile(join(root, "a.json"), '{"ok":true}');
    const check = new TaskAcceptance(contract([{ type: "file_exists", path: "a.json" }, { type: "file_contains", path: "a.json", text: "true" }, { type: "json_value", path: "a.json", keys: ["ok"], equals: true }]), { workspaceRoot: root });
    assert.equal((await check.evaluate()).passed, true);
    await writeFile(join(root, "a.json"), '{"ok":false}');
    assert.equal((await check.evaluate()).passed, false);
    const unchecked = new TaskAcceptance(contract([]), { workspaceRoot: root });
    const report = await unchecked.evaluate(); assert.equal(report.passed, false); assert.equal(report.requirements[0].status, "needs-human-review");
    assert.equal(unchecked.decide("completed", report).action, "continue");
    assert.equal(unchecked.decide("completed", report).status, "partial");
    assert.equal(unchecked.decide("blocked", report).status, "blocked");
  });
  await test("command proof requires real success and unchanged declared inputs, including after evaluation", async () => {
    await writeFile(join(root, "source.txt"), "ONE");
    const c = contract([{ type: "command_exit", command: "npm test", inputs: ["source.txt"] }]);
    const check = new TaskAcceptance(c, { workspaceRoot: root });
    assert.equal((await check.evaluate()).passed, false);
    const prepared = await check.beforeTool("run_command", { command: "npm test" });
    await check.afterTool(prepared, { exitCode: 1 }, "failed"); assert.equal((await check.evaluate()).passed, false);
    await check.afterTool(prepared, { exitCode: 0 }, "real-pass"); assert.equal((await check.evaluate()).passed, true);
    await writeFile(join(root, "source.txt"), "TWO"); assert.equal((await check.evaluate()).passed, false);
    const during = await check.beforeTool("run_command", { command: "npm test" }); await writeFile(join(root, "source.txt"), "THREE");
    await check.afterTool(during, { exitCode: 0 }, "mutated"); assert.equal((await check.evaluate()).passed, false);
    const restored = new TaskAcceptance(check.snapshot().contract, { workspaceRoot: root }); assert.equal((await restored.evaluate()).requirements[0].checks[0].status, "not-run");
  });
  await test("project contract is frozen for invocation, and null explicitly disables it", async () => {
    await mkdir(join(root, ".aporiax"));
    await writeFile(join(root, ".aporiax/acceptance.json"), JSON.stringify(contract([{ type: "file_exists", path: "missing" }])));
    const check = new TaskAcceptance(await loadTaskContract(root), { workspaceRoot: root });
    await writeFile(join(root, ".aporiax/acceptance.json"), JSON.stringify(contract([{ type: "file_exists", path: "a.json" }])));
    assert.equal((await check.evaluate()).passed, false); assert.equal(await loadTaskContract(root, null), null);
    assert.equal(await loadTaskContract(root, undefined, { canRead: false }), null);
  });
  await test("read denial and malformed/non-UTF8/oversized files cannot create passes", async () => {
    await writeFile(join(root, "binary"), Buffer.from([255, 0, 254]));
    const check = new TaskAcceptance(contract([{ type: "file_contains", path: "binary", text: "x" }]), { workspaceRoot: root });
    assert.equal((await check.evaluate()).passed, false);
    const denied = new TaskAcceptance(contract([{ type: "file_exists", path: "a.json" }]), { workspaceRoot: root, canRead: false });
    assert.equal((await denied.evaluate()).passed, false);
    await writeFile(join(root, "large"), Buffer.alloc(8 * 1024 * 1024 + 1));
    assert.equal((await new TaskAcceptance(contract([{ type: "file_exists", path: "large" }]), { workspaceRoot: root }).evaluate()).passed, false);
  });
  await test("external symbolic link check fails closed", async () => {
    const outside = await mkdtemp(join(tmpdir(), "aporia-outside-"));
    try { await writeFile(join(outside, "private"), "must-not-read");
      await symlink(outside, join(root, "outside-link"), process.platform === "win32" ? "junction" : "dir");
      const report = await new TaskAcceptance(contract([{ type: "file_contains", path: "outside-link/private", text: "must-not-read" }]), { workspaceRoot: root }).evaluate();
      assert.equal(report.passed, false); assert(!JSON.stringify(report).includes('"sha256"'));
    } finally { await rm(join(root, "outside-link"), { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });
} finally { await rm(root, { recursive: true, force: true }); }
await finish();
