import { readFile, writeFile, rm } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return source.replace(before, after);
}

let mcp = await readFile("electron/mcp-runtime.js", "utf8");
mcp = replaceOnce(
  mcp,
  `  #transportFactory;\n  #discovered = false;\n`,
  `  #transportFactory;\n  #capabilities;\n  #scopeId;\n  #discovered = false;\n`,
  "MCP capability fields",
);
mcp = replaceOnce(
  mcp,
  `    clientFactory = () => new Client(clientIdentity(), { capabilities: {} }),\n    transportFactory = defaultTransport,\n  } = {}) {`,
  `    clientFactory = () => new Client(clientIdentity(), { capabilities: {} }),\n    transportFactory = defaultTransport,\n    capabilityRegistry = null,\n    scopeId = "",\n  } = {}) {`,
  "MCP constructor args",
);
mcp = replaceOnce(
  mcp,
  `    this.#clientFactory = clientFactory;\n    this.#transportFactory = transportFactory;\n  }`,
  `    this.#clientFactory = clientFactory;\n    this.#transportFactory = transportFactory;\n    this.#capabilities = capabilityRegistry;\n    this.#scopeId = String(scopeId || "").trim();\n  }`,
  "MCP constructor assignments",
);
mcp = replaceOnce(
  mcp,
  `      this.#emit({\n        type: "mcp.server.connected",`,
  `      this.#registerConnectionCapabilities(connection);\n      this.#emit({\n        type: "mcp.server.connected",`,
  "MCP register discovered capabilities",
);
const registrar = [
  "  #registerConnectionCapabilities(connection) {",
  "    if (!this.#capabilities || !this.#scopeId) return;",
  "    const server = connection.server;",
  "    for (const [localName, record] of this.#tools) {",
  "      if (record.connection !== connection) continue;",
  "      this.#capabilities.upsert({",
  "        id: this.#scopeId + ':tool:mcp:' + server.id + ':' + localName,",
  "        kind: 'tool',",
  "        source: 'mcp',",
  "        name: localName,",
  "        title: record.public.title || record.public.remoteName,",
  "        description: record.public.description || '',",
  "        risk: record.public.readOnly ? 'read' : 'control',",
  "        scopeId: this.#scopeId,",
  "        serverId: server.id,",
  "        readOnly: record.public.readOnly,",
  "        tags: [record.public.destructive ? 'destructive' : '', record.public.openWorld ? 'open-world' : ''].filter(Boolean),",
  "        metadata: { remoteName: record.public.remoteName, serverName: server.name, idempotent: record.public.idempotent },",
  "      });",
  "    }",
  "    const registerResource = (resource, template = false) => {",
  "      const key = String(resource?.uri || resource?.uriTemplate || resource?.name || 'resource');",
  "      const digest = createHash('sha256').update(key).digest('hex').slice(0, 12);",
  "      this.#capabilities.upsert({",
  "        id: this.#scopeId + ':resource:mcp:' + server.id + ':' + digest,",
  "        kind: 'resource',",
  "        source: 'mcp',",
  "        name: String(resource?.name || resource?.uri || resource?.uriTemplate || 'resource'),",
  "        title: String(resource?.title || resource?.name || 'MCP resource'),",
  "        description: String(resource?.description || ''),",
  "        risk: 'read',",
  "        scopeId: this.#scopeId,",
  "        serverId: server.id,",
  "        readOnly: true,",
  "        tags: template ? ['template'] : [],",
  "        metadata: { uri: resource?.uri || null, uriTemplate: resource?.uriTemplate || null, mimeType: resource?.mimeType || null, serverName: server.name },",
  "      });",
  "    };",
  "    for (const resource of connection.resources || []) registerResource(resource, false);",
  "    for (const resource of connection.resourceTemplates || []) registerResource(resource, true);",
  "    for (const prompt of connection.prompts || []) {",
  "      const key = String(prompt?.name || 'prompt');",
  "      const digest = createHash('sha256').update(key).digest('hex').slice(0, 12);",
  "      this.#capabilities.upsert({",
  "        id: this.#scopeId + ':prompt:mcp:' + server.id + ':' + digest,",
  "        kind: 'prompt',",
  "        source: 'mcp',",
  "        name: key,",
  "        title: String(prompt?.title || prompt?.name || 'MCP prompt'),",
  "        description: String(prompt?.description || ''),",
  "        risk: 'none',",
  "        scopeId: this.#scopeId,",
  "        serverId: server.id,",
  "        metadata: { serverName: server.name },",
  "      });",
  "    }",
  "  }",
  "",
].join("\n");
mcp = replaceOnce(
  mcp,
  `  #connection(serverId) {`,
  `${registrar}  #connection(serverId) {`,
  "MCP capability registrar",
);
mcp = replaceOnce(
  mcp,
  `    this.#connections.clear();\n    this.#tools.clear();`,
  `    this.#connections.clear();\n    this.#tools.clear();\n    if (this.#capabilities && this.#scopeId) {\n      this.#capabilities.unregisterScope(this.#scopeId);\n    }`,
  "MCP scoped capability cleanup",
);
await writeFile("electron/mcp-runtime.js", mcp, "utf8");

let runtime = await readFile("electron/agent-runtime-core.js", "utf8");
runtime = replaceOnce(
  runtime,
  `  mcpServers = [],\n  mcpConfigErrors = [],\n}) {`,
  `  mcpServers = [],\n  mcpConfigErrors = [],\n  capabilityRegistry = null,\n}) {`,
  "runHarness capability registry arg",
);
runtime = replaceOnce(
  runtime,
  `  const mcpRuntime = createMcpRuntime({\n    servers: Array.isArray(mcpServers) ? mcpServers : [],\n    emit,\n  });`,
  `  const mcpRuntime = createMcpRuntime({\n    servers: Array.isArray(mcpServers) ? mcpServers : [],\n    emit,\n    capabilityRegistry,\n    scopeId: runId ? "mcp:" + runId : "",\n  });`,
  "MCP runtime capability bridge",
);
await writeFile("electron/agent-runtime-core.js", runtime, "utf8");

const pkg = JSON.parse(await readFile("package.json", "utf8"));
pkg.scripts["test:mcp-capabilities"] = "node tests/mcp-capabilities-smoke.mjs";
await writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

await rm("scripts/apply-mcp-capability-refactor.mjs", { force: true });
await rm(".github/workflows/validate-mcp-capabilities.yml", { force: true });
console.log("MCP capability bridge applied");
