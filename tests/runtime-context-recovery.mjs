import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beginRunJournal, saveRunContext, getRunRecoveryContext, closeRunJournalStore, saveRunCheckpoint } from "../electron/run-store.js";
import { withDurableRun, saveRuntimeContext } from "../electron/runtime/durable-run.js";
import { taskRequest, recoverConversation } from "../electron/runtime/task-conversation.js";
import { runHarness } from "../electron/agent-runtime.js";

const dir = await mkdtemp(join(tmpdir(), "aporia-context-recovery-"));
const originalFetch = globalThis.fetch;
const parse = (call) => JSON.parse(call.function.arguments);
try {
  await beginRunJournal(dir, { runId: "saved", taskId: "fixture" });
  await saveRunCheckpoint(dir, "saved", { scopeId: "saved", phase: "model" });
  const conversation = [
    { role: "system", content: "Old stable instructions" },
    taskRequest({ role: "user", content: "Original requirement: keep SOURCE_CONSTRAINT intact." }),
    { role: "assistant", content: null, tool_calls: [{ id: "old-read", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
    { role: "tool", tool_call_id: "old-read", content: "RETAINED_FILE_EVIDENCE" },
    { role: "assistant", tool_calls: [{ id: "broken-read", type: "function", function: { name: "read_external_file", arguments: '{"path":"C:/missing-receipt"}' } }] },
    { role: "tool", tool_call_id: "broken-read" },
    { role: "assistant", content: null, tool_calls: [{ id: "uncertain", type: "function", function: { name: "run_command", arguments: '{"command":"publish"}' } }] },
  ];
  const main = { kind: "main", workspaceRoot: null, conversation, plan: { steps: [{ id: "a", title: "Remaining work", status: "in_progress" }] }, workers: [], contextCheckpoints: [] };
  await withDurableRun({ context: (scope, state) => saveRunContext(dir, "saved", scope, state) }, async () => {
    const first = saveRuntimeContext("saved", { ...main, revision: 1 });
    const second = saveRuntimeContext("saved", { ...main, revision: 2 });
    await Promise.all([first, second]);
  });
  await closeRunJournalStore(dir);
  const recovery = await getRunRecoveryContext(dir, "saved");
  assert.equal(recovery.contexts.saved.revision, 2, "newest context wins after reopen");
  assert.equal(recovery.contexts.saved.conversation[1].aporiaSource, "human");
  assert.equal(recoverConversation(conversation).at(-1).tool_call_id, "uncertain");
  assert.match(recoverConversation(conversation).at(-1).content, /unknown/);
  assert.equal(conversation.length, 7, "recovery does not mutate durable input");
  let requests = 0;
  globalThis.fetch = async (_url, options) => {
    requests++;
    const body = JSON.parse(options.body);
    const text = body.messages.map((m) => m.content || "").join("\n");
    assert.match(text, /SOURCE_CONSTRAINT/);
    assert.match(text, /RETAINED_FILE_EVIDENCE/);
    assert.match(text, /unknown/);
    assert.match(text, /RECOVERED_TOOL_RESULT_MISSING/);
    assert(body.messages.every((message) => Object.hasOwn(message, "content")), "no missing content reaches the provider after recovery");
    assert.match(text, /do not blindly replay/i);
    assert(body.messages.every((m) => !Object.keys(m).some((key) => key.startsWith("aporia"))));
    return new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"finish","type":"function","function":{"name":"finish_task","arguments":"{\\"status\\":\\"needs_input\\",\\"summary\\":\\"Please confirm the publication outcome before continuing.\\"}"}}]}}]}\n\ndata: [DONE]\n\n');
  };
  const result = await runHarness({ runId: "resumed", recoveryContext: recovery,
    provider: { id: "fake", name: "fake", vendor: "openai", baseUrl: "https://test.invalid/v1", apiKey: "fake", models: [{ id: "test", supportsTools: true, contextWindow: 32000 }] },
    modelId: "test", permission: "read-only", language: "en",
    messages: [{ role: "user", content: "Continue without replaying uncertain operations." }] });
  assert.equal(result.status, "needs_input");
  assert.equal(result.witness.status, "needs_input");
  assert.equal(requests, 1, "resume does not replay saved tools or require a second model round to finish");
  assert.equal(result.steps.length, 0);
  await saveRunContext(dir, "saved", "huge", { text: "x".repeat(16_000_001) });
  assert.equal((await getRunRecoveryContext(dir, "saved")).contexts.huge.text.length, 16_000_001);
  await closeRunJournalStore(dir);
  const db = new DatabaseSync(join(dir, "aporiax-runs.sqlite3"));
  db.prepare("UPDATE run_contexts SET checksum = 'invalid' WHERE run_id = ?").run("saved"); db.close();
  await assert.rejects(() => getRunRecoveryContext(dir, "saved"), /RUN_CONTEXT_CORRUPT/);
} finally { globalThis.fetch = originalFetch; await closeRunJournalStore(dir); await rm(dir, { recursive: true, force: true }); }
console.log("Durable context: ordered snapshots, reopen, human provenance, repaired receipts, projectless resume, explicit outcome and integrity: PASS");
