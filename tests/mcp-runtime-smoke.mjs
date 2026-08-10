import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMcpConfiguration,
  normalizeMcpServer,
  publicMcpServerSummary,
} from "../electron/mcp-config.js";
import {
  compactMcpResult,
  createMcpRuntime,
  isMcpToolName,
  mcpToolName,
} from "../electron/mcp-runtime.js";

const http = normalizeMcpServer(
  {
    id: "github",
    transport: "streamable-http",
    url: "https://example.com/mcp",
    headers: { Authorization: "Bearer ${TEST_MCP_TOKEN}" },
  },
  { environment: { TEST_MCP_TOKEN: "secret-token" } },
);
assert.equal(http.headers.Authorization, "Bearer secret-token");
assert.deepEqual(publicMcpServerSummary(http).headerKeys, ["Authorization"]);
assert.equal(publicMcpServerSummary(http).Authorization, undefined);
assert.throws(
  () =>
    normalizeMcpServer({
      id: "bad-http",
      transport: "streamable-http",
      url: "file:///tmp/server",
    }),
  /only supports http\/https/i,
);

const stdio = normalizeMcpServer(
  {
    id: "local-tools",
    name: "Local Tools",
    transport: "stdio",
    command: "node",
    args: ["server.mjs", "${WORKSPACE_NAME}"],
    env: { API_TOKEN: "${TOKEN}" },
  },
  { environment: { WORKSPACE_NAME: "demo", TOKEN: "top-secret" } },
);
assert.deepEqual(stdio.args, ["server.mjs", "demo"]);
assert.equal(stdio.env.API_TOKEN, "top-secret");
assert.deepEqual(publicMcpServerSummary(stdio).envKeys, ["API_TOKEN"]);

const root = await mkdtemp(join(tmpdir(), "aporiax-mcp-"));
try {
  const userData = join(root, "user-data");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".aporiax"), { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(
    join(userData, "aporiax-mcp.json"),
    JSON.stringify({
      servers: [
        {
          id: "trusted-local",
          transport: "stdio",
          command: "node",
          args: ["trusted-server.mjs"],
        },
        {
          id: "remote",
          transport: "streamable-http",
          url: "https://example.com/mcp",
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(workspace, ".aporiax", "mcp.json"),
    JSON.stringify({
      servers: ["remote"],
      command: "malicious-project-command",
      args: ["should-never-run"],
    }),
    "utf8",
  );
  const config = await loadMcpConfiguration({
    userDataDirectory: userData,
    workspacePath: workspace,
  });
  assert.deepEqual(config.servers.map((server) => server.id), ["remote"]);
  assert.equal(config.servers[0].transport, "streamable-http");
  assert.equal(config.servers.some((server) => server.command === "malicious-project-command"), false);
} finally {
  await rm(root, { recursive: true, force: true });
}

const fakeClients = new Map();
function clientFactory(server) {
  const calls = [];
  const client = {
    calls,
    async connect() {},
    getServerCapabilities() {
      return { tools: {}, resources: {}, prompts: {} };
    },
    getServerVersion() {
      return { name: `fake-${server.id}`, version: "1.0.0" };
    },
    async listTools() {
      return {
        tools: [
          {
            name: "read_item",
            description: "Read one item",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
            annotations: { readOnlyHint: true },
          },
          {
            name: "delete_item",
            description: "Delete one item",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
            annotations: { destructiveHint: true },
          },
        ],
      };
    },
    async listResources() {
      return { resources: [{ uri: "demo://readme", name: "Readme" }] };
    },
    async listResourceTemplates() {
      return { resourceTemplates: [] };
    },
    async readResource({ uri }) {
      return { contents: [{ uri, mimeType: "text/plain", text: "resource text" }] };
    },
    async listPrompts() {
      return { prompts: [{ name: "review", description: "Review something" }] };
    },
    async getPrompt({ name }) {
      return { description: name, messages: [{ role: "user", content: { type: "text", text: "review it" } }] };
    },
    async callTool(request) {
      calls.push(request);
      return { content: [{ type: "text", text: `called ${request.name}` }], isError: false };
    },
    async close() {},
  };
  fakeClients.set(server.id, client);
  return client;
}

const events = [];
const runtime = createMcpRuntime({
  servers: [
    {
      id: "demo",
      name: "Demo",
      transport: "stdio",
      enabled: true,
      command: "fake",
      args: [],
      env: {},
      timeoutMs: 5_000,
      autoApproveReadOnly: false,
    },
  ],
  emit: (event) => events.push(event),
  clientFactory,
  transportFactory: () => ({ async close() {} }),
});
const discovery = await runtime.discover({ permissionMode: "workspace-write" });
assert.equal(discovery.servers.length, 1);
assert.equal(discovery.tools.length, 2);
const readTool = discovery.tools.find((tool) => tool.remoteName === "read_item");
const deleteTool = discovery.tools.find((tool) => tool.remoteName === "delete_item");
assert(readTool && deleteTool);
assert.equal(readTool.permission, "ask");
assert.equal(deleteTool.permission, "ask");
assert.equal(isMcpToolName(readTool.name), true);
assert(readTool.name.length <= 64);

const readonlyDiscovery = runtime.toolCatalog("read-only");
assert.deepEqual(readonlyDiscovery.map((tool) => tool.remoteName), ["read_item"]);
assert(runtime.toolDefinitions("workspace-write").some((definition) => definition.function.name === "mcp_read_resource"));
assert(runtime.toolDefinitions("workspace-write").some((definition) => definition.function.name === "mcp_get_prompt"));

let approvals = 0;
await runtime.call(
  readTool.name,
  { id: "42" },
  {
    requestApproval: async () => {
      approvals += 1;
      return { approved: true };
    },
  },
);
assert.equal(approvals, 1);
assert.equal(fakeClients.get("demo").calls[0].name, "read_item");

await runtime.call(
  deleteTool.name,
  { id: "42" },
  {
    requestApproval: async (request) => {
      approvals += 1;
      assert.equal(request.kind, "control");
      return { approved: true };
    },
  },
);
assert.equal(approvals, 2);

const resource = await runtime.call("mcp_read_resource", {
  server: "demo",
  uri: "demo://readme",
});
assert.equal(resource.contents[0].text, "resource text");
const prompt = await runtime.call("mcp_get_prompt", {
  server: "demo",
  name: "review",
  arguments: { target: "src" },
});
assert.equal(prompt.description, "review");
assert(events.some((event) => event.type === "mcp.server.connected"));
assert(events.some((event) => event.type === "mcp.tool.completed"));
await runtime.close();

const autoRuntime = createMcpRuntime({
  servers: [
    {
      id: "auto",
      name: "Auto",
      transport: "stdio",
      enabled: true,
      command: "fake",
      args: [],
      env: {},
      timeoutMs: 5_000,
      autoApproveReadOnly: true,
    },
  ],
  clientFactory,
  transportFactory: () => ({ async close() {} }),
});
await autoRuntime.discover({ permissionMode: "workspace-write" });
const autoRead = autoRuntime.toolCatalog("workspace-write").find((tool) => tool.remoteName === "read_item");
assert.equal(autoRead.permission, "allow");
await autoRuntime.call(autoRead.name, { id: "x" });
await assert.rejects(
  () =>
    autoRuntime.call(
      autoRuntime.toolCatalog("workspace-write").find((tool) => tool.remoteName === "delete_item").name,
      { id: "x" },
    ),
  /requires approval/i,
);
await autoRuntime.close();

const longName = mcpToolName(
  "very-long-server-name-that-keeps-going",
  "a_tool_name_that_is_far_too_long_for_openai_compatible_function_calling_interfaces",
);
assert(longName.length <= 64);
assert.match(longName, /^mcp__/);
const compacted = compactMcpResult({
  content: [{ type: "image", mimeType: "image/png", data: "a".repeat(1000) }],
});
assert.equal(compacted.content[0].dataOmitted, true);
assert.equal(compacted.content[0].data, undefined);

console.log("mcp runtime smoke: PASS");
