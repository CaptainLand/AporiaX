import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseMcpMentions } from "../electron/mcp-mentions.js";
import { parseMentionTokens } from "../shared/mention-tokens.js";
import { prepareWorkspaceMentionMessage } from "../electron/workspace-mentions.js";
import { sanitizeConversation } from "../electron/runtime/conversation.js";
import { createSkillRegistry, parseSkillDocument } from "../electron/harness/skills/registry.js";
import { searchSkills } from "../electron/skill-resources.js";
import { readMentionContext } from "../electron/workbench/mention-context.js";
import { withDurableRun, executeDurableTool } from "../electron/runtime/durable-run.js";
import { createMcpRuntime } from "../electron/mcp-runtime.js";

assert.deepEqual(parseMcpMentions("(@mcp:docs)，@mcp:other。 mail@x.com"), ["docs", "other"]);
const registry = createSkillRegistry(); registry.register(parseSkillDocument("---\nname: x\nauto: false\n---\nComplete instructions"));
assert.equal(registry.match("(@skill:x)，检查").skills[0].name, "x");
assert.deepEqual(parseMentionTokens("@中文.md:2-3 @git:changes @terminal:terminal_1").map(token => token.kind), ["file", "git", "terminal"]);
const root = await mkdtemp(join(tmpdir(), "aporia-extensions-repair-"));
try {
  const workspace = join(root, "workspace"); await mkdir(join(workspace, "dir"), { recursive: true });
  await writeFile(join(workspace, "中文.md"), "one\ntwo\nthree\nfour");
  await writeFile(join(workspace, "dir", "private.txt"), "DIRECTORY_CONTENT_MUST_NOT_LOAD");
  await mkdir(join(root, "skills", "fixture"), { recursive: true });
  await writeFile(join(root, "skills", "fixture", "SKILL.md"), "---\nname: fixture\ndescription: Special asteroid analysis workflow\nauto: false\nhooks:\n  forbidden: never-execute\n---\nRead ref.txt");
  const message = { role: "user", content: "(@中文.md:2-3)，@dir/ @git:changes" };
  let reads = 0;
  const options = { readContext: async token => { reads++; assert.equal(token.kind, "git"); return "DIFF_SNAPSHOT"; } };
  const once = await prepareWorkspaceMentionMessage(message, workspace, options);
  const twice = await prepareWorkspaceMentionMessage(once, workspace, options);
  assert.equal(once.content, twice.content); assert.equal(reads, 2);
  assert.match(once.content, /2: two\n3: three/); assert.doesNotMatch(once.content, /one|four|DIRECTORY_CONTENT_MUST_NOT_LOAD/);
  assert.match(once.content, /private.txt/); assert.match(once.content, /DIFF_SNAPSHOT/);
  const sanitized = sanitizeConversation([once]);
  assert.equal(sanitized[0].content, message.content);
  assert.equal(sanitized[1].aporiaSource, "retrieval");
  assert.match(sanitized[1].content, /DIFF_SNAPSHOT/);
  for(const path of ["../outside.txt", "中文.md:0-3", "中文.md:4-2"]) {
    const prepared = await prepareWorkspaceMentionMessage({ role: "user", content: "@{" + path + "}" }, workspace);
    assert.notEqual(prepared.workspaceMentions[0].status, "loaded");
  }
  const search = await searchSkills({ userSkillsDirectory: join(root, "skills"), builtinDirectory: "" }, { query: "asteroid" });
  assert.equal(search.skills[0].name, "fixture");
  assert.match(search.skills[0].compatibilityWarnings.join(" "), /not executed/);
  const resources = new Map([["terminal_1", { taskId: "task", workspacePath: workspace, kind: "terminal", output: "tail", offset: 0 }]]);
  assert.equal((await readMentionContext({ taskId: "task", workspacePath: workspace }, { kind: "terminal", value: "terminal_1" }, { resources })).output, "tail");
  await assert.rejects(readMentionContext({ taskId: "other", workspacePath: workspace }, { kind: "terminal", value: "terminal_1" }, { resources }), /does not belong/);
  const browser = { taskId: "task", workspacePath: workspace, kind: "browser", owner: "user", async mentionSnapshot() { return { visibleText: "PAGE_TEXT" }; } };
  resources.set("browser_1", browser);
  assert.equal((await readMentionContext({ taskId: "task", workspacePath: workspace }, { kind: "browser", value: "browser_1" }, { resources })).visibleText, "PAGE_TEXT");
  assert.equal(browser.owner, "user", "explicit snapshot does not transfer browser control");
  const gitCalls = [];
  const git = { async request(input) {
    gitCalls.push(input);
    if (input.operation === "status") return { repository: true, files: [{ path: ".env", untracked: true }, { path: "a.txt", staged: true, unstaged: true }], totalFiles: 2 };
    assert.equal(input.operation, "diff"); assert.equal(input.path, "a.txt"); return { text: "safe diff" };
  } };
  const diff = await readMentionContext({ taskId: "task", workspacePath: workspace }, { kind: "git", value: "changes" }, { resources, git });
  assert.equal(gitCalls.length, 3); assert.match(diff.diffs[0].note, /Untracked content omitted/);
  let approvals = 0, executions = 0; const receipts = [];
  await withDurableRun({ workspacePath: workspace, operation: async receipt => receipts.push(receipt) }, async () => {
    const call = () => executeDurableTool("mcp__demo__write", { id: 1 }, async () => { executions++; return { isError: true, content: [] }; }, async () => { approvals++; return { approved: false }; });
    await call(); await assert.rejects(call(), /RECOVERY_RECONCILIATION_REQUIRED/);
  });
  assert.equal(executions, 1); assert.equal(approvals, 1); assert.equal(receipts.at(-1).state, "uncertain");

  let attempts = 0, calls = 0, live, remoteTool = "read"; const notifications = new Map();
  const runtime = createMcpRuntime({ servers: [{ id: "demo", timeoutMs: 1000, autoApproveReadOnly: true }],
    transportFactory: () => ({ async close() {} }), clientFactory: () => (live = {
      async connect() { attempts++; }, getServerCapabilities() { return { tools: {} }; },
      async listTools() { return { tools: [{ name: remoteTool, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] }; },
      setNotificationHandler(schema, fn) { notifications.set(schema.shape.method.value, fn); },
      async callTool() { calls++; return { isError: false, content: [] }; }, async close() {},
    }) });
  try {
    await runtime.discover(); assert.equal(attempts, 1);
    await runtime.call("mcp__demo__read", {}); assert.equal(calls, 1);
    live.onclose(); await runtime.refresh(); assert.equal(attempts, 1, "reconnect must honor backoff");
    await new Promise(resolve => setTimeout(resolve, 1050)); await runtime.refresh();
    assert.equal(attempts, 2); assert.equal(calls, 1, "reconnect must not replay calls");
    remoteTool = "read_new";
    notifications.get("notifications/tools/list_changed")(); await runtime.refresh();
    assert(runtime.hasTool("mcp__demo__read_new")); assert.equal(runtime.hasTool("mcp__demo__read"), false);
    assert.equal(attempts, 2, "catalog refresh must preserve the connection and server session state");
    await runtime.setServers([]); assert.equal(runtime.active, false); assert.equal(runtime.hasTool("mcp__demo__read_new"), false);
  } finally { await runtime.close(); }
  const controller = new AbortController(); let closed = 0;
  const blocked = createMcpRuntime({ servers: [{ id: "slow", timeoutMs: 30000 }],
    clientFactory: () => ({ connect: () => new Promise(() => {}), async close() { closed++; } }),
    transportFactory: () => ({ async close() {} }),
  });
  const started = Date.now(); const pending = blocked.discover({ signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { name: "AbortError" }); await blocked.close();
  assert(closed > 0); assert(Date.now() - started < 1000, "cancel must not wait for discovery timeout");
  console.log("Extension repair: punctuation, idempotent references, ranges/folders, retrieval provenance, Skill discovery, task scoping, uncertain-operation replay guard, bounded MCP reconnect/catalog refresh: PASS");
} finally { await rm(root, { recursive: true, force: true }); }
