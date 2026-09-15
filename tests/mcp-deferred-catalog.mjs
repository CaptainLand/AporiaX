import assert from "node:assert/strict";
import { createMcpRuntime, mcpToolName } from "../electron/mcp-runtime.js";

function fixture({ first = "alpha", count = 160, permissionMode = "workspace-write" } = {}) {
  let executed = 0;
  const runtime = createMcpRuntime({ servers: ["alpha", "beta"].map((id) => ({ id, name: id, timeoutMs: 2000 })),
    transportFactory: () => ({ close: async () => {} }),
    clientFactory: (server) => ({ connect: async () => {}, close: async () => {}, getServerCapabilities: () => ({ tools: {} }),
      listTools: async () => {
        if (server.id !== first) await new Promise((done) => setTimeout(done, 20));
        return { tools: Array.from({ length: count }, (_, i) => ({ name: `tool_${i}`, description: `Capability ${i}`,
          annotations: { readOnlyHint: i % 2 === 0 }, inputSchema: { type: "object", properties: {} } })) };
      }, callTool: async ({ name }) => { executed++; return { content: [{ type: "text", text: name }] }; },
    }),
  });
  return { runtime, permissionMode, executed: () => executed };
}

let baseline;
for (const first of ["alpha", "beta"]) {
  const { runtime, executed } = fixture({ first });
  try {
    await runtime.discover({ permissionMode: "workspace-write" });
    const catalog = runtime.toolCatalog("workspace-write");
    assert.equal(catalog.length, 320);
    const active = runtime.toolDefinitions("workspace-write").filter((tool) => tool.function.name.startsWith("mcp__")).map((tool) => tool.function.name);
    assert.equal(active.length, 32);
    assert.equal(active.filter((name) => name.startsWith("mcp__alpha__")).length, 16);
    if (baseline) assert.deepEqual(active, baseline, "connection order does not change active tools"); else baseline = active;
    for (const server of runtime.serverSummaries()) {
      assert.equal(server.toolCount, 160);
      assert.equal(server.activeToolCount, 16);
      assert.equal(server.deferredToolCount, 144);
    }
    const search = await runtime.call("mcp_search_tools", { server_id: "beta", query: "tool_159", limit: 1 });
    assert.equal(search.totalMatches, 1);
    assert.equal(executed(), 0, "search never executes an external capability");
    assert(runtime.toolDefinitions("workspace-write").some((tool) => tool.function.name === "mcp__beta__tool_159"));
    let approvals = 0;
    await runtime.call("mcp__beta__tool_159", {}, { requestApproval: async () => { approvals++; return { approved: true }; } });
    assert.equal(approvals, 1);
    assert.equal(executed(), 1);
    const page = await runtime.call("mcp_search_tools", { server_id: "alpha", limit: 2 });
    assert.equal(page.nextOffset, 2);
    assert.equal((await runtime.call("mcp_search_tools", { server_id: "alpha", offset: 2, limit: 2 })).tools[0].name, catalog.filter((t) => t.serverId === "alpha")[2].name);
    await assert.rejects(runtime.call("mcp_search_tools", { offset: -1 }), /Invalid/);
  } finally { await runtime.close(); }
}
const readonly = fixture();
try {
  await readonly.runtime.discover({ permissionMode: "read-only" });
  assert.equal((await readonly.runtime.call("mcp_search_tools", { query: "tool_159" })).totalMatches, 0);
  await assert.rejects(readonly.runtime.call("mcp__beta__tool_159", {}, { requestApproval: async () => ({ approved: true }) }), /read-only/);
  assert.equal(readonly.executed(), 0);
} finally { await readonly.runtime.close(); }
const overflow = fixture({ count: 2001 });
try {
  const result = await overflow.runtime.discover({ permissionMode: "workspace-write" });
  assert.equal(result.errors.length, 2);
  assert(result.servers.every((server) => server.discoveryStatus === "failed"));
  assert.match(result.errors[0].error, /catalog limit/);
} finally { await overflow.runtime.close(); }
assert.notEqual(mcpToolName("a.b", "test"), mcpToolName("a_b", "test"), "normalized server IDs cannot collide");
console.log("MCP 320-tool catalog, deterministic fair schemas, deferred activation/paging, permission enforcement and explicit limits: PASS");
