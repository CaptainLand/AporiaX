import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFrozenBrowserMentionReader } from "../electron/workbench/mention-snapshots.js";
import { prepareWorkspaceMentionMessage } from "../electron/workspace-mentions.js";
import { recoveryMcpServerIds, selectConfiguredMcpServers } from "../electron/mcp-mentions.js";
import { createMcpRuntime } from "../electron/mcp-runtime.js";
import { contextReserveTokens, compactConversationForRequest } from "../electron/agent-context-core.js";

const root = await mkdtemp(join(tmpdir(), "aporia-overall-repair-"));
try {
  const directory = join(root, "snapshots"); let reads = 0, page = "ORIGINAL_PUBLIC_PAGE";
  const options = { directory, taskId: "task", workspacePath: root, readContext: async () => { reads++; return { visibleText: page }; } };
  const message = { id: "user-1", role: "user", content: "Summarize @browser:browser_1" };
  const reader = createFrozenBrowserMentionReader(options);
  const [first, duplicate] = await Promise.all([1, 2].map(() => prepareWorkspaceMentionMessage(message, root, { readContext: reader })));
  assert.equal(first.content, duplicate.content); assert.equal(reads, 1);
  page = "PRIVATE_PAGE_AFTER_NAVIGATION";
  const reopened = createFrozenBrowserMentionReader({ ...options, retry: true });
  // Renderer retries send the original message, not the prepared main-process one.
  const retry = await prepareWorkspaceMentionMessage(message, root, { readContext: reopened });
  assert.equal(retry.content, first.content); assert.equal(reads, 1);
  assert.doesNotMatch(retry.content, /PRIVATE_PAGE/);
  const absent = await prepareWorkspaceMentionMessage({ ...message, id: "legacy-retry" }, root, { readContext: reopened });
  assert.match(absent.content, /select the page in a new message/); assert.equal(reads, 1);
  await prepareWorkspaceMentionMessage(message, root, { readContext: createFrozenBrowserMentionReader({ ...options, taskId: "other", retry: true }) });
  assert.equal(reads, 1, "another task cannot reuse or refresh the snapshot");
  const fresh = await prepareWorkspaceMentionMessage({ ...message, id: "new-selection" }, root, { readContext: reader });
  assert.match(fresh.content, /PRIVATE_PAGE_AFTER_NAVIGATION/); assert.equal(reads, 2);
  const broken = createFrozenBrowserMentionReader({ ...options, readContext: async () => { reads++; throw new Error("capture failed"); } });
  await prepareWorkspaceMentionMessage({ ...message, id: "failed" }, root, { readContext: broken });
  await prepareWorkspaceMentionMessage({ ...message, id: "failed" }, root, { readContext: reader });
  assert.equal(reads, 3, "an interrupted capture does not silently authorize recapture");
  for (const name of await readdir(directory)) {
    const path = join(directory, name); const data = JSON.parse(await readFile(path, "utf8"));
    if (data.content?.includes("ORIGINAL_PUBLIC_PAGE")) await writeFile(path, "invalid json");
  }
  const corrupt = await prepareWorkspaceMentionMessage(message, root, { readContext: reader });
  assert.match(corrupt.content, /snapshot-unavailable/); assert.equal(reads, 3);
  console.log("PASS frozen browser snapshot: concurrent capture, raw retry, reopen, task scope, reselect, failed/corrupt capture fail closed");

  const recovery = { runId: "old", contexts: { old: { kind: "main", workspaceRoot: root, selectedMcpServerIds: ["first", "later", "../bad"] } } };
  assert.deepEqual(recoveryMcpServerIds(recovery, root), ["first", "later"]);
  assert.throws(() => recoveryMcpServerIds(recovery, join(root, "other")), /WORKSPACE_MISMATCH/);
  const configured = [{ id: "first", enabled: true }, { id: "later", enabled: false }];
  assert.deepEqual(selectConfiguredMcpServers({ selectedIds: ["later"] }, [configured[0]], configured).servers, [configured[0]]);
  const legacy = { runId: "old", contexts: { old: { kind: "main", workspaceRoot: root, inputHistory: [
    { role: "user", content: "Use @mcp:later" }, { role: "user", aporiaSource: "retrieval", content: "@mcp:untrusted" },
  ] } } };
  assert.deepEqual(recoveryMcpServerIds(legacy, root), ["later"]);
  assert.deepEqual(selectConfiguredMcpServers({ messages: [{ role: "user", aporiaSource: "retrieval", content: "@mcp:first" }] }, [], configured).servers, []);
  console.log("PASS MCP recovery identities: enabled configuration only, no retrieval authority, workspace mismatch denied");

  const originalNow = Date.now; let clock = Date.now(), attempts = 0, healthy = false, calls = 0;
  const servers = [{ id: "demo", timeoutMs: 1000, autoApproveReadOnly: true }];
  const runtime = createMcpRuntime({ servers, transportFactory: () => ({ async close() {} }), clientFactory: () => ({
    async connect() { attempts++; if (!healthy) throw new Error("offline fixture"); },
    getServerCapabilities: () => ({ tools: {} }), async listTools() { return { tools: [{ name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] }; },
    async callTool() { calls++; return { content: [] }; }, async close() {},
  }) });
  Date.now = () => clock;
  try {
    await runtime.discover(); clock += 10_000; await runtime.refresh(); clock += 10_000; await runtime.refresh();
    healthy = true; clock += 60_000; await runtime.setServers(servers); await runtime.refresh();
    assert.equal(attempts, 3); assert.equal(runtime.hasTool("mcp__demo__read"), false);
    await runtime.setServers(servers, { retryServerIds: ["demo"] }); await runtime.refresh();
    assert.equal(attempts, 4); assert(runtime.hasTool("mcp__demo__read")); assert.equal(calls, 0);
  } finally { Date.now = originalNow; await runtime.close(); }
  console.log("PASS explicit MCP reselect resets bounded connection attempts without replaying business calls");
  assert.equal(contextReserveTokens(32000), 8192);
  assert.equal(contextReserveTokens(128000), 17920);
  assert.equal(compactConversationForRequest({ conversation: [{ role: "user", content: "x" }], contextCheckpoints: [], contextWindowTokens: 32000, accounting: { providerOverheadTokens: 20287 } }), null);
  assert.throws(() => compactConversationForRequest({ conversation: [{ role: "user", content: "中".repeat(30000) }], contextCheckpoints: [], contextWindowTokens: 32000 }), /CONTEXT_BUDGET_EXCEEDED/);
  console.log("PASS 32K headroom without dropping user requirements; large windows keep original reserve");
} finally { await rm(root, { recursive: true, force: true }); }
