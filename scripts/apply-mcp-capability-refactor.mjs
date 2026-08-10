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
mcp = replaceOnce(
  mcp,
  `  #connection(serverId) {`,
  `  #registerConnectionCapabilities(connection) {\n    if (!this.#capabilities || !this.#scopeId) return;\n    const server = connection.server;\n    for (const [localName, record] of this.#tools) {\n      if (record.connection !== connection) continue;\n      this.#capabilities.upsert({\n        id: \`${"${this.#scopeId}