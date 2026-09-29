import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  acquireLocalControlWorker, assertLocalControlActive, assertLocalControlMcp,
  assertLocalControlTool, consumeLocalControlModelCall, createLocalControlPolicy,
  currentLocalControlPolicy, isLocalControlToolAvailable, localControlPolicySnapshot,
  withLocalControlPolicy, withLocalControlWorkspace, withLocalControlWorker,
} from "../electron/control/policy.js";
import { createPermissionPolicy } from "../electron/agent-core.js";
import { TOOL_REGISTRY } from "../electron/runtime/native-tool-catalog.js";
import { dispatchNativeTool } from "../electron/runtime/tool-dispatcher.js";
import { callModelProviderOnce } from "../electron/runtime/provider-stream.js";
import { createMcpRuntime, mcpToolName } from "../electron/mcp-runtime.js";
import { runGitCommand } from "../electron/runtime/workspace-runtime.js";
import { HarnessScheduler } from "../electron/harness/scheduler.js";
import { loadProjectInstructionContext as loadProjectInstructionContextCore, resolveScopedInstructions } from "../electron/agent-context-core.js";

const exec = promisify(execFile);
const temp = await mkdtemp(join(tmpdir(), "aporiax-control-policy-"));
const workspaceRoot = join(temp, "workspace");
const outside = join(temp, "outside");
const originalFetch = globalThis.fetch;
let checks = 0;
const check = async (name, callback) => {
  await callback();
  checks += 1;
  console.log(`PASS ${name}`);
};
const denied = callback => assert.rejects(callback, error => error.code === "LOCAL_CONTROL_FORBIDDEN");
const policy = overrides => createLocalControlPolicy({ clientId: "client-test", runId: "run-test", workspaceRoot, permissionProfile: "read_only", ...overrides });
const invoke = (toolName, input = {}, options = {}) => dispatchNativeTool({
  toolCall: { id: "call-test", function: { name: toolName, arguments: JSON.stringify(input) } },
  registry: TOOL_REGISTRY, permissionPolicy: createPermissionPolicy("workspace-write"),
  approvalMode: "sandbox-auto", sandboxStatus: { available: true, executionProfile: "isolated" },
  parseArguments: call => JSON.parse(call.function.arguments),
  requestApproval: async () => ({ approved: true }),
  executeContext: { workspaceRoot },
  executeAuthorized: async () => ({ modelResult: { executed: true } }),
  ...options,
});

try {
  await mkdir(workspaceRoot);
  await mkdir(outside);
  await writeFile(join(workspaceRoot, "readme.txt"), "authorized\n");
  await writeFile(join(outside, "secret.txt"), "outside\n");
  await symlink(outside, join(workspaceRoot, "escape"), process.platform === "win32" ? "junction" : "dir");

  await check("ordinary desktop tools keep their existing authorization without a policy", async () => {
    assert.equal(currentLocalControlPolicy(), null);
    assert.equal((await invoke("write_file", { path: "readme.txt", content: "x" })).modelResult.executed, true);
    await assertLocalControlTool({ toolName: "unknown-future-tool" });
    assert.equal(localControlPolicySnapshot(), null);
  });

  await check("read-only overrides permissive project policy and human approval cannot elevate it", () => withLocalControlPolicy(policy({ capabilities: { commands: true, browser: true, mcp: true } }), async () => {
    assert.equal((await invoke("read_file", { path: "readme.txt" })).modelResult.executed, true);
    for (const [toolName, input] of [
      ["write_file", { path: "readme.txt", content: "x" }], ["apply_patch", { path: "readme.txt", dry_run: true }],
      ["create_word_document", { path: "report.docx" }], ["create_presentation", { path: "slides.pptx" }],
      ["create_spreadsheet", { path: "sheet.xlsx" }], ["run_command", { command: "cat ../outside/secret.txt", cwd: "." }],
      ["start_process", { command: "node", cwd: "." }], ["write_stdin", { process_id: "old", data: "anything" }],
      ["read_external_file", { path: join(outside, "secret.txt") }], ["browser_open", { url: "https://example.com" }],
      ["lsp", { operation: "status" }], ["read_skill_resource", {}],
      ["project_knowledge", { action: "save", content: "untrusted" }],
      ["present_to_user", { url: "https://example.com" }],
      ["delegate_subagent", { role: "builder", task: "write", write_scopes: ["readme.txt"] }],
      ["request_self_check", { action: "run", verification: [{ command: "node evil.js", cwd: "." }] }],
    ]) await denied(() => invoke(toolName, input, { executeAuthorized: async () => assert.fail(`${toolName} executed`), requestApproval: async () => assert.fail(`${toolName} reached approval`) }));
    await denied(() => assertLocalControlTool({ toolName: "future_tool", workspaceRoot }));
    assert.equal(isLocalControlToolAvailable("write_file"), false);
    assert.equal(isLocalControlToolAvailable("run_command"), false);
  }));

  await check("workspace path checks reject traversal, symlinks, mixed separators and root substitution", () => withLocalControlPolicy(policy(), async () => {
    for (const path of ["../outside/secret.txt", "..\\outside\\secret.txt", "escape/secret.txt", join(outside, "secret.txt"), "file.txt:stream"]) {
      await denied(() => invoke("read_file", { path }, { executeAuthorized: async () => assert.fail("path escaped") }));
    }
    await denied(() => invoke("read_file", { path: "readme.txt" }, { executeContext: { workspaceRoot: outside } }));
  }));

  await check("the real instruction loader rejects linked .aporiax parents and rules roots before loading outside Markdown", async () => {
    const ruleDirectory = join(outside, "rules");
    await mkdir(ruleDirectory);
    await writeFile(join(ruleDirectory, "private.md"), "OUTSIDE_RULE_SENTINEL\n");
    for (const linkedPart of ["parent", "rules"]) {
      const root = join(temp, `linked-rules-${linkedPart}`);
      await mkdir(root);
      if (linkedPart === "parent") await symlink(outside, join(root, ".aporiax"), process.platform === "win32" ? "junction" : "dir");
      else {
        await mkdir(join(root, ".aporiax"));
        await symlink(ruleDirectory, join(root, ".aporiax", "rules"), process.platform === "win32" ? "junction" : "dir");
      }
      // Exercise the actual source reader, not a substituted dispatcher. The
      // ordinary desktop behavior is intentionally unchanged by this guard.
      assert.match((await loadProjectInstructionContextCore(root)).rules[0].content, /OUTSIDE_RULE_SENTINEL/);
      const context = policy({ workspaceRoot: root });
      await withLocalControlPolicy(context, async () => {
        await denied(() => loadProjectInstructionContextCore(root));
        assert.equal(localControlPolicySnapshot().toolCalls, 0);
      });
    }
    // Regular instruction files beneath linked ancestors also cannot bypass
    // the boundary through a direct scoped-instruction lookup.
    await writeFile(join(outside, "AGENTS.md"), "OUTSIDE_INSTRUCTION_SENTINEL\n");
    await withLocalControlPolicy(policy(), async () => {
      const context = await loadProjectInstructionContextCore(workspaceRoot);
      await denied(() => resolveScopedInstructions(context, ["escape/secret.txt"]));
    });
  });

  await check("workspace-edit allows native writes while metadata and patch/image path escapes remain denied", () => withLocalControlPolicy(policy({ permissionProfile: "workspace_edit" }), async () => {
    assert.equal((await invoke("write_file", { path: "new.txt", content: "ok" })).modelResult.executed, true);
    for (const path of ["escape/new.txt", "../outside/new.txt", ".git/config", ".aporiax/mcp.json"]) await denied(() => invoke("write_file", { path, content: "x" }));
    await denied(() => invoke("apply_patch", { patch: "--- a/../outside/secret.txt\n+++ b/../outside/secret.txt\n@@ -1 +1 @@\n-outside\n+changed\n" }));
    await denied(() => invoke("create_word_document", { path: "report.docx", blocks: [{ type: "image", path: "escape/secret.txt" }] }));
    await denied(() => invoke("run_command", { command: "npm test", cwd: "." }));
  }));

  await check("explicit command capability retains a mandatory desktop approval boundary", () => withLocalControlPolicy(policy({ permissionProfile: "workspace_edit", capabilities: { commands: true } }), async () => {
    let approvals = 0;
    await invoke("run_command", { command: "npm test", cwd: "." }, {
      requestApproval: async () => { approvals += 1; return { approved: true }; },
      executeAuthorized: async ({ permissionDecision }) => {
        assert.equal(permissionDecision.requiresApproval, true);
        assert.equal(permissionDecision.autoApproved, false);
        return { modelResult: { executed: true } };
      },
    });
    assert.equal(approvals, 1);
  }));

  await check("workspace paths are revalidated after an approval wait", () => withLocalControlPolicy(policy({ permissionProfile: "workspace_edit", capabilities: { commands: true } }), async () => {
    const pendingDirectory = join(workspaceRoot, "pending-approval");
    await mkdir(pendingDirectory);
    await denied(() => invoke("run_command", { command: "npm test", cwd: "pending-approval" }, {
      requestApproval: async () => {
        await rm(pendingDirectory, { recursive: true });
        await symlink(outside, pendingDirectory, process.platform === "win32" ? "junction" : "dir");
        return { approved: true };
      },
      executeAuthorized: async () => assert.fail("Changed workspace path reached execution"),
    }));
  }));

  await check("parallel descendants share cumulative model budget and unrelated runs remain independent", async () => {
    const context = policy({ limits: { maxModelCalls: 2 } });
    await withLocalControlPolicy(context, async () => {
      await Promise.all([0, 1].map(async () => {
        await Promise.resolve();
        consumeLocalControlModelCall({ provider: {}, body: {} });
      }));
      assert.throws(() => consumeLocalControlModelCall({ provider: {}, body: {} }), error => error.code === "LOCAL_CONTROL_BUDGET_EXCEEDED");
      assert.throws(assertLocalControlActive, error => error.code === "LOCAL_CONTROL_BUDGET_EXCEEDED");
    });
    assert.equal(localControlPolicySnapshot(context).modelCalls, 2);
    await withLocalControlPolicy(policy(), async () => consumeLocalControlModelCall({ provider: {}, body: {} }));
    assert.equal(currentLocalControlPolicy(), null);
  });

  await check("the shared Harness scheduler retains each queued client's policy context", async () => {
    const scheduler = new HarnessScheduler({ concurrency: 1 });
    const first = policy({ clientId: "first" });
    const second = policy({ clientId: "second" });
    let unblock;
    const gate = new Promise(resolve => { unblock = resolve; });
    const a = withLocalControlPolicy(first, () => scheduler.enqueue({ id: "first", run: async () => {
      await gate;
      assert.equal(currentLocalControlPolicy().clientId, "first");
      consumeLocalControlModelCall({ provider: {}, body: {} });
    } }));
    const b = withLocalControlPolicy(second, () => scheduler.enqueue({ id: "second", run: async () => {
      assert.equal(currentLocalControlPolicy().clientId, "second");
      consumeLocalControlModelCall({ provider: {}, body: {} });
    } }));
    unblock();
    await Promise.all([a.promise, b.promise]);
    assert.equal(localControlPolicySnapshot(first).modelCalls, 1);
    assert.equal(localControlPolicySnapshot(second).modelCalls, 1);
  });

  await check("real provider boundary rejects unauthorized providers/models and stops before extra fetch", async () => {
    const provider = { id: "allowed-provider", name: "Fixture", baseUrl: "https://example.com/v1", apiKey: "fixture" };
    const body = { model: "allowed-model", messages: [] };
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    };
    const context = policy({ allowedProviderIds: [provider.id], allowedModelIds: [body.model], limits: { maxModelCalls: 1 } });
    await withLocalControlPolicy(context, async () => {
      await denied(() => callModelProviderOnce({ provider: { ...provider, id: "other" }, body }));
      await denied(() => callModelProviderOnce({ provider, body: { ...body, model: "other" } }));
      assert.equal(fetches, 0);
      const results = await Promise.allSettled([callModelProviderOnce({ provider, body }), callModelProviderOnce({ provider, body })]);
      assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
      assert.equal(results.find(item => item.status === "rejected").reason.code, "LOCAL_CONTROL_BUDGET_EXCEEDED");
      assert.equal(fetches, 1);
    });
    assert.equal((await callModelProviderOnce({ provider, body })).message.content, "done");
    assert.equal(fetches, 2);
  });

  await check("tool budget is enforced by the actual dispatcher, including rejected attempts", () => withLocalControlPolicy(policy({ limits: { maxToolCalls: 1 } }), async () => {
    await denied(() => invoke("write_file", { path: "new.txt", content: "x" }));
    await assert.rejects(() => invoke("read_file", { path: "readme.txt" }), error => error.code === "LOCAL_CONTROL_BUDGET_EXCEEDED");
  }));

  await check("worker limits cover concurrent starts, follow-ups and thrown worker exits", async () => {
    const context = policy({ limits: { maxParallelAgents: 1, maxSubagents: 2 } });
    await withLocalControlPolicy(context, async () => {
      const release = acquireLocalControlWorker({ agentId: "a", role: "explore" });
      assert.throws(() => acquireLocalControlWorker({ agentId: "b", role: "review" }), error => error.code === "LOCAL_CONTROL_CONCURRENCY_LIMIT");
      release(); release();
      const resumed = acquireLocalControlWorker({ agentId: "a", role: "explore" }); resumed();
      assert.equal(localControlPolicySnapshot().totalAgents, 1);
      await assert.rejects(() => withLocalControlWorker({ agentId: "b", role: "review" }, async () => { throw new Error("worker failed"); }), /worker failed/);
      assert.equal(localControlPolicySnapshot().activeAgents, 0);
      assert.throws(() => acquireLocalControlWorker({ agentId: "c", role: "review" }), error => error.code === "LOCAL_CONTROL_BUDGET_EXCEEDED");
    });
    withLocalControlPolicy(policy({ limits: { maxSubagents: 0 } }), () => assert.throws(() => acquireLocalControlWorker({ agentId: "a", role: "explore" }), /limit reached/));
    withLocalControlPolicy(policy({ limits: { maxParallelAgents: 0 } }), () => {
      assert.equal(isLocalControlToolAvailable("delegate_subagent"), false);
      assert.throws(() => acquireLocalControlWorker({ agentId: "a", role: "explore" }), error => error.code === "LOCAL_CONTROL_CONCURRENCY_LIMIT");
      assert.equal(localControlPolicySnapshot().activeAgents, 0);
      assert.equal(localControlPolicySnapshot().totalAgents, 0);
    });
  });

  await check("trusted Builder worktree rebinding shares its parent budget without allowing parent paths", async () => {
    const context = policy({ permissionProfile: "workspace_edit", limits: { maxModelCalls: 1 } });
    await withLocalControlPolicy(context, async () => {
      await withLocalControlWorkspace(outside, async () => {
        await assertLocalControlTool({ toolName: "read_file", input: { path: "secret.txt" }, workspaceRoot: outside });
        await denied(() => assertLocalControlTool({ toolName: "read_file", input: { path: join(workspaceRoot, "readme.txt") }, workspaceRoot: outside }));
        consumeLocalControlModelCall({ provider: {}, body: {} });
      });
      assert.equal(currentLocalControlPolicy().workspaceRoot, workspaceRoot);
      assert.throws(() => consumeLocalControlModelCall({ provider: {}, body: {} }), /limit reached/);
    });
    withLocalControlPolicy(policy(), () => assert.throws(() => withLocalControlWorkspace(outside, () => {}), /Read-only/));
  });

  await check("deadlines and restored counters cannot be renewed by continuation", async () => {
    withLocalControlPolicy(policy({ deadlineAt: Date.now() - 1 }), () => assert.throws(assertLocalControlActive, error => error.code === "LOCAL_CONTROL_DEADLINE_EXCEEDED"));
    withLocalControlPolicy(policy({ limits: { maxModelCalls: 2 }, usage: { modelCalls: 2 } }), () => assert.throws(() => consumeLocalControlModelCall({ provider: {}, body: {} }), /limit reached/));
    withLocalControlPolicy(policy({ onUsage() { throw new Error("disk failed"); } }), () => {
      assert.throws(() => consumeLocalControlModelCall({ provider: {}, body: {} }), error => error.code === "LOCAL_CONTROL_PERSISTENCE_FAILED");
      assert.throws(assertLocalControlActive, error => error.code === "LOCAL_CONTROL_PERSISTENCE_FAILED");
    });
  });

  await check("MCP grant applies before transport startup, resource calls and nested control tools", async () => {
    let connections = 0;
    let remoteCalls = 0;
    const server = { id: "allowed", name: "Fixture", transport: "stdio", command: "fixture-server", timeoutMs: 1000 };
    const runtime = createMcpRuntime({ servers: [server, { ...server, id: "ungranted" }], transportFactory: () => ({ close: async () => {} }),
      clientFactory: () => ({
        connect: async () => { connections += 1; }, close: async () => {},
        getServerCapabilities: () => ({ tools: {}, resources: {} }), getServerVersion: () => ({ name: "fixture", version: "1" }),
        listTools: async () => ({ tools: ["read_item", "aporiax_start_run"].map(name => ({ name, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } })) }),
        listResources: async () => ({ resources: [{ uri: "fixture://doc", name: "doc" }] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        readResource: async () => { remoteCalls += 1; return { contents: [{ uri: "fixture://doc", text: "ok" }] }; },
        callTool: async () => { remoteCalls += 1; return { content: [{ type: "text", text: "ok" }] }; },
      }) });
    await withLocalControlPolicy(policy(), async () => {
      const discovered = await runtime.discover();
      assert.equal(discovered.tools.length, 0);
      assert.equal(connections, 0);
    });
    const context = policy({ permissionProfile: "workspace_edit", capabilities: { mcp: true }, allowedMcpServerIds: ["allowed"] });
    await withLocalControlPolicy(context, async () => {
      const discovered = await runtime.discover();
      assert.equal(connections, 1);
      assert.equal(discovered.tools.length, 2);
      await runtime.call(mcpToolName("allowed", "read_item"), {}, { requestApproval: async () => ({ approved: true }) });
      await runtime.call("mcp_read_resource", { server: "allowed", uri: "fixture://doc" });
      await denied(() => runtime.call(mcpToolName("allowed", "aporiax_start_run"), {}, { requestApproval: async () => assert.fail("nested control approval") }));
      assert.equal(remoteCalls, 2);
      for (const malicious of [{ ...server, url: "http://127.0.0.1:123/mcp" }, { ...server, url: "http://[::1]/mcp" }, { ...server, command: "node", args: ["aporiax-mcp.cjs"] }]) {
        assert.throws(() => assertLocalControlMcp({ server: malicious, operation: "connect" }), /Nested AporiaX/);
      }
    });
    await runtime.close();
  });

  await check("Git read tools disable repository-provided command execution", async () => {
    await exec("git", ["init", "--quiet", workspaceRoot]);
    await writeFile(join(workspaceRoot, "fsmonitor-hook"), "#!/bin/sh\necho unsafe > hook-ran\n");
    await exec("git", ["-C", workspaceRoot, "config", "core.fsmonitor", process.execPath + " -e \"require('fs').writeFileSync('hook-ran','unsafe')\""]);
    await withLocalControlPolicy(policy(), async () => {
      const result = await runGitCommand({ args: ["status", "--short"], cwd: workspaceRoot });
      assert.equal(result.exitCode, 0);
      await assert.rejects(() => readFile(join(workspaceRoot, "hook-ran")), error => error.code === "ENOENT");
    });
  });

  console.log(`Local control policy: ${checks} checks passed.`);
} finally {
  globalThis.fetch = originalFetch;
  await rm(temp, { recursive: true, force: true });
}
