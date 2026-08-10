import assert from "node:assert/strict";
import { createCapabilityRegistry } from "../electron/harness/capability-registry.js";
import { createMcpRuntime } from "../electron/mcp-runtime.js";

const capabilities = createCapabilityRegistry();
const fakeClient = {
  async connect() {},
  getServerCapabilities() {
    return { tools: {}, resources: {}, prompts: {} };
  },
  getServerVersion() {
    return { name: "fake", version: "1" };
  },
  async listTools() {
    return {
      tools: [
        {
          name: "read_item",
          title: "Read item",
          description: "Read one item",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
        {
          name: "change_item",
          description: "Change one item",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  },
  async listResources() {
    return { resources: [{ uri: "demo://readme", name: "Readme", description: "Docs" }] };
  },
  async listResourceTemplates() {
    return { resourceTemplates: [{ uriTemplate: "demo://item/{id}", name: "Item" }] };
  },
  async listPrompts() {
    return { prompts: [{ name: "review", description: "Review item" }] };
  },
  async close() {},
};
const runtime = createMcpRuntime({
  servers: [
    {
      id: "demo",
      name: "Demo MCP",
      transport: "stdio",
      enabled: true,
      command: "fake",
      args: [],
      env: {},
      timeoutMs: 5_000,
      autoApproveReadOnly: false,
    },
  ],
  capabilityRegistry: capabilities,
  scopeId: "mcp:run-123",
  clientFactory: () => fakeClient,
  transportFactory: () => ({ async close() {} }),
});

await runtime.discover({ permissionMode: "workspace-write" });
const scoped = capabilities.list({ scopeId: "mcp:run-123" });
assert.equal(scoped.filter((item) => item.kind === "tool").length, 2);
assert.equal(scoped.filter((item) => item.kind === "resource").length, 2);
assert.equal(scoped.filter((item) => item.kind === "prompt").length, 1);
const readTool = scoped.find((item) => item.kind === "tool" && item.metadata.remoteName === "read_item");
const changeTool = scoped.find((item) => item.kind === "tool" && item.metadata.remoteName === "change_item");
assert.equal(readTool.source, "mcp");
assert.equal(readTool.risk, "read");
assert.equal(changeTool.risk, "control");
assert.equal(readTool.serverId, "demo");
assert.equal(scoped.some((item) => JSON.stringify(item).includes("secret")), false);

await runtime.close();
assert.equal(capabilities.list({ scopeId: "mcp:run-123" }).length, 0);

console.log("mcp capabilities smoke: PASS");
