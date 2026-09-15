import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, createPermissionPolicy } from "../electron/agent-core.js";
import { dispatchNativeTool } from "../electron/runtime/tool-dispatcher.js";
import { providerMessages, recoverConversation, requireToolResult } from "../electron/runtime/task-conversation.js";
import { callModelProviderOnce } from "../electron/runtime/provider-stream.js";

const directory = await mkdtemp(join(tmpdir(), "aporia-tool-contract-"));
const originalFetch = globalThis.fetch;
try {
  await writeFile(join(directory, "evidence.txt"), "fixture");
  const registry = new ToolRegistry([{ risk: "read", definition: { type: "function", function: {
    name: "read_external_file", description: "Read", parameters: { type: "object", properties: {} },
  } } }]);
  const read = (path) => dispatchNativeTool({
    toolCall: { id: "read", function: { name: "read_external_file", arguments: JSON.stringify({ path }) } },
    registry, permissionPolicy: createPermissionPolicy("workspace-write"), requestApproval: async () => ({ approved: true }),
    parseArguments: (call) => JSON.parse(call.function.arguments),
    executeAuthorized: async () => ({ modelResult: { kind: "file", content: "fixture" } }),
  });
  for (const result of [await read(directory), ...await Promise.all([read(directory), read(directory)])]) {
    assert.equal(result.modelResult.kind, "directory");
    assert(result.modelResult.entries.some((entry) => entry.name === "evidence.txt"));
    const receipt = { role: "tool", tool_call_id: "read", content: JSON.stringify(result.modelResult) };
    assert.equal(JSON.parse(JSON.stringify(providerMessages([receipt])))[0].content, receipt.content);
  }
  assert.equal((await read(join(directory, "evidence.txt"))).modelResult.kind, "file");
  await assert.rejects(() => read(join(directory, "missing")), /ENOENT/);
  assert.throws(() => requireToolResult({ kind: "directory" }, "read_external_file"), /TOOL_RESULT_INVALID.*unknown/);
  assert.equal(requireToolResult({ modelResult: null }, "nullable").modelResult, null);

  const calls = ["missing", "null", "object", "good", "absent"].map((id) => ({ id, type: "function", function: { name: "read_external_file", arguments: "{}" } }));
  const old = [{ role: "assistant", tool_calls: calls },
    { role: "tool", tool_call_id: "missing" }, { role: "tool", tool_call_id: "null", content: null },
    { role: "tool", tool_call_id: "object", content: { entries: ["preserve-me"] } },
    { role: "tool", tool_call_id: "good", content: "exact evidence" }];
  const before = JSON.stringify(old);
  const fixed = providerMessages(recoverConversation(old));
  assert.equal(JSON.stringify(old), before, "do not mutate saved checkpoints");
  assert.equal(fixed.length, 6);
  assert.equal(fixed[0].content, null);
  assert.equal(JSON.parse(fixed[1].content).outcome, "unknown");
  assert.match(fixed[1].content, /do not blindly replay/);
  assert.equal(JSON.parse(fixed[2].content).outcome, "unknown");
  assert.deepEqual(JSON.parse(fixed[3].content), { entries: ["preserve-me"] });
  assert.equal(fixed[4].content, "exact evidence");
  assert.equal(JSON.parse(fixed[5].content).outcome, "unknown");
  assert.deepEqual(providerMessages([{ role: "user", content: "hello", aporiaSource: "human", aporiaPinned: true }]), [{ role: "user", content: "hello" }]);

  let networkRequests = 0;
  globalThis.fetch = async () => { networkRequests++; throw new Error("No network expected"); };
  for (const bad of [{ role: "tool", tool_call_id: "missing" }, { role: "user" }, { role: "tool", content: null }]) {
    await assert.rejects(() => callModelProviderOnce({ provider: {}, body: { messages: [bad] } }),
      (error) => error.code === "MODEL_MESSAGE_INVALID" && error.retryable === false);
  }
  assert.equal(networkRequests, 0, "invalid messages must not consume an API request");
} finally {
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
console.log("Tool message contract: directory/file/error, serial/parallel, legacy recovery, provider preflight: PASS");
