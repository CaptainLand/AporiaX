import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MAX_DYNAMIC_TOOLS = 160;
const MAX_RESOURCE_ITEMS = 200;
const MAX_PROMPT_ITEMS = 200;
const MAX_RESULT_TEXT = 80_000;
const MAX_DESCRIPTION_CHARS = 1_200;
const TOOL_NAME_LIMIT = 64;
const CORE_RESOURCE_LIST = "mcp_list_resources";
const CORE_RESOURCE_READ = "mcp_read_resource";
const CORE_PROMPT_LIST = "mcp_list_prompts";
const CORE_PROMPT_GET = "mcp_get_prompt";
const CORE_NAMES = new Set([
  CORE_RESOURCE_LIST,
  CORE_RESOURCE_READ,
  CORE_PROMPT_LIST,
  CORE_PROMPT_GET,
]);

function timeout(promise, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs} ms.`)),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function toolSafePart(value, fallback = "item") {
  const normalized = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return normalized || fallback;
}

export function mcpToolName(serverId, remoteToolName) {
  const server = toolSafePart(serverId, "server");
  const tool = toolSafePart(remoteToolName, "tool");
  const preferred = `mcp__${server}__${tool}`;
  if (preferred.length <= TOOL_NAME_LIMIT) return preferred;
  const digest = createHash("sha256")
    .update(`${serverId}\0${remoteToolName}`)
    .digest("hex")
    .slice(0, 10);
  const budget = TOOL_NAME_LIMIT - `mcp____${digest}`.length;
  const left = Math.max(4, Math.floor(budget * 0.36));
  const right = Math.max(6, budget - left);
  return `mcp__${server.slice(0, left)}__${tool.slice(0, right)}_${digest}`.slice(
    0,
    TOOL_NAME_LIMIT,
  );
}

export function isMcpToolName(name) {
  const value = String(name || "");
  return value.startsWith("mcp__") || CORE_NAMES.has(value);
}

function schemaObject(inputSchema) {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return { type: "object", properties: {}, additionalProperties: true };
  }
  return {
    ...inputSchema,
    type: inputSchema.type || "object",
  };
}

function readOnlyTool(tool) {
  return tool?.annotations?.readOnlyHint === true;
}

function publicToolRecord(connection, tool, localName) {
  return {
    name: localName,
    serverId: connection.server.id,
    serverName: connection.server.name,
    remoteName: tool.name,
    title: String(tool.title || tool.annotations?.title || tool.name || "MCP tool").slice(
      0,
      160,
    ),
    description: String(tool.description || "").slice(0, MAX_DESCRIPTION_CHARS),
    readOnly: readOnlyTool(tool),
    destructive: tool?.annotations?.destructiveHint === true,
    idempotent: tool?.annotations?.idempotentHint === true,
    openWorld: tool?.annotations?.openWorldHint === true,
    autoApproveReadOnly: connection.server.autoApproveReadOnly === true,
  };
}

function compactString(value, limit = MAX_RESULT_TEXT) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}\n[MCP output truncated]` : text;
}

function compactContentItem(item) {
  if (!item || typeof item !== "object") return item;
  if (item.type === "text") {
    return { ...item, text: compactString(item.text, 48_000) };
  }
  if (item.type === "image" || item.type === "audio") {
    return {
      type: item.type,
      mimeType: item.mimeType || null,
      dataOmitted: true,
      approximateBase64Chars: String(item.data || "").length,
    };
  }
  if (item.type === "resource" && item.resource) {
    return {
      ...item,
      resource: compactResourceContent(item.resource),
    };
  }
  return item;
}

function compactResourceContent(resource) {
  if (!resource || typeof resource !== "object") return resource;
  const next = { ...resource };
  if (typeof next.text === "string") next.text = compactString(next.text, 60_000);
  if (typeof next.blob === "string") {
    next.approximateBase64Chars = next.blob.length;
    next.blob = "[binary resource omitted by AporiaX]";
  }
  return next;
}

export function compactMcpResult(result) {
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    ...(Array.isArray(result.content)
      ? { content: result.content.slice(0, 64).map(compactContentItem) }
      : {}),
    ...(result.structuredContent && typeof result.structuredContent === "object"
      ? { structuredContent: result.structuredContent }
      : {}),
  };
}

function clientIdentity() {
  return { name: "AporiaX", version: "0.5.0" };
}

function defaultTransport(server) {
  if (server.transport === "stdio") {
    return new StdioClientTransport({
      command: server.command,
      args: [...(server.args || [])],
      ...(server.cwd ? { cwd: server.cwd } : {}),
      env: {
        ...getDefaultEnvironment(),
        ...(server.env || {}),
      },
      stderr: "pipe",
    });
  }
  return new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: {
      headers: { ...(server.headers || {}) },
    },
  });
}

async function collectPages(fetchPage, key, limit) {
  const items = [];
  let cursor = undefined;
  do {
    const payload = await fetchPage(cursor);
    const next = Array.isArray(payload?.[key]) ? payload[key] : [];
    items.push(...next.slice(0, Math.max(0, limit - items.length)));
    cursor = payload?.nextCursor || undefined;
  } while (cursor && items.length < limit);
  return items;
}

function normalizePermissionMode(value) {
  return new Set(["read-only", "workspace-write", "builder-write"]).has(value)
    ? value
    : "read-only";
}

function helperDefinitions(serverIds, hasResources, hasPrompts) {
  const serverProperty = {
    type: "string",
    ...(serverIds.length ? { enum: serverIds } : {}),
    description: "Configured MCP server id.",
  };
  const definitions = [];
  if (hasResources) {
    definitions.push(
      {
        type: "function",
        function: {
          name: CORE_RESOURCE_LIST,
          description: "List resources and resource templates exposed by one configured MCP server.",
          parameters: {
            type: "object",
            properties: { server: serverProperty },
            required: ["server"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: CORE_RESOURCE_READ,
          description: "Read one MCP resource by URI from a configured server.",
          parameters: {
            type: "object",
            properties: {
              server: serverProperty,
              uri: { type: "string", description: "Exact resource URI returned by MCP discovery." },
            },
            required: ["server", "uri"],
            additionalProperties: false,
          },
        },
      },
    );
  }
  if (hasPrompts) {
    definitions.push(
      {
        type: "function",
        function: {
          name: CORE_PROMPT_LIST,
          description: "List reusable prompts exposed by one configured MCP server.",
          parameters: {
            type: "object",
            properties: { server: serverProperty },
            required: ["server"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: CORE_PROMPT_GET,
          description: "Get one MCP prompt template by name and optional arguments.",
          parameters: {
            type: "object",
            properties: {
              server: serverProperty,
              name: { type: "string" },
              arguments: { type: "object", additionalProperties: { type: "string" } },
            },
            required: ["server", "name"],
            additionalProperties: false,
          },
        },
      },
    );
  }
  return definitions;
}

export class AporiaXMcpRuntime {
  #servers;
  #connections = new Map();
  #tools = new Map();
  #emit;
  #clientFactory;
  #transportFactory;
  #capabilities;
  #scopeId;
  #discovered = false;

  constructor({
    servers = [],
    emit = () => {},
    clientFactory = () => new Client(clientIdentity(), { capabilities: {} }),
    transportFactory = defaultTransport,
    capabilityRegistry = null,
    scopeId = "",
  } = {}) {
    this.#servers = Array.isArray(servers) ? servers.filter((server) => server?.enabled !== false) : [];
    this.#emit = typeof emit === "function" ? emit : () => {};
    this.#clientFactory = clientFactory;
    this.#transportFactory = transportFactory;
    this.#capabilities = capabilityRegistry;
    this.#scopeId = String(scopeId || "").trim();
  }

  get active() {
    return this.#connections.size > 0;
  }

  serverSummaries() {
    return [...this.#connections.values()].map((connection) => ({
      id: connection.server.id,
      name: connection.server.name,
      transport: connection.server.transport,
      connected: true,
      toolCount: connection.tools.length,
      resourceCount: connection.resources.length + connection.resourceTemplates.length,
      promptCount: connection.prompts.length,
      serverVersion: connection.serverVersion || null,
      capabilities: connection.capabilities || {},
    }));
  }

  toolCatalog(permissionMode = "read-only") {
    const mode = normalizePermissionMode(permissionMode);
    return [...this.#tools.values()]
      .filter((record) => mode !== "builder-write")
      .filter((record) => mode !== "read-only" || record.public.readOnly)
      .map((record) => ({
        ...record.public,
        permission:
          record.public.readOnly && record.public.autoApproveReadOnly ? "allow" : "ask",
        risk: record.public.readOnly ? "read" : "control",
        mcp: true,
      }));
  }

  toolDefinitions(permissionMode = "read-only") {
    const mode = normalizePermissionMode(permissionMode);
    if (mode === "builder-write") return [];
    const dynamic = [...this.#tools.values()]
      .filter((record) => mode !== "read-only" || record.public.readOnly)
      .slice(0, MAX_DYNAMIC_TOOLS)
      .map((record) => ({
        type: "function",
        function: {
          name: record.public.name,
          description: [
            `[MCP: ${record.public.serverName}]`,
            record.public.description || record.public.title,
            record.public.readOnly
              ? "The server marks this tool read-only."
              : "This MCP tool may have side effects and AporiaX will require approval.",
          ].join(" ").slice(0, 1_800),
          parameters: schemaObject(record.tool.inputSchema),
        },
      }));
    const connections = [...this.#connections.values()];
    return [
      ...dynamic,
      ...helperDefinitions(
        connections.map((connection) => connection.server.id),
        connections.some(
          (connection) => connection.resources.length || connection.resourceTemplates.length,
        ),
        connections.some((connection) => connection.prompts.length),
      ),
    ];
  }

  hasTool(name) {
    return this.#tools.has(String(name || "")) || CORE_NAMES.has(String(name || ""));
  }

  async discover({ permissionMode = "read-only" } = {}) {
    if (this.#discovered) {
      return {
        servers: this.serverSummaries(),
        tools: this.toolCatalog(permissionMode),
      };
    }
    this.#discovered = true;
    const results = await Promise.allSettled(
      this.#servers.slice(0, 32).map((server) => this.#connectServer(server)),
    );
    const errors = [];
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        errors.push({
          serverId: this.#servers[index]?.id || "unknown",
          error: String(result.reason?.message || result.reason),
        });
      }
    });
    return {
      servers: this.serverSummaries(),
      tools: this.toolCatalog(permissionMode),
      errors,
    };
  }

  async #connectServer(server) {
    this.#emit({ type: "mcp.server.connecting", serverId: server.id, transport: server.transport });
    const client = this.#clientFactory(server);
    const transport = this.#transportFactory(server);
    try {
      await timeout(client.connect(transport), server.timeoutMs, `MCP ${server.id} connect`);
      const capabilities = client.getServerCapabilities?.() || {};
      const serverVersion = client.getServerVersion?.() || null;
      const tools = await collectPages(
        (cursor) => timeout(client.listTools(cursor ? { cursor } : {}), server.timeoutMs, `MCP ${server.id} listTools`),
        "tools",
        MAX_DYNAMIC_TOOLS,
      ).catch(() => []);
      const resources = capabilities.resources
        ? await collectPages(
            (cursor) => timeout(client.listResources(cursor ? { cursor } : {}), server.timeoutMs, `MCP ${server.id} listResources`),
            "resources",
            MAX_RESOURCE_ITEMS,
          ).catch(() => [])
        : [];
      const resourceTemplates = capabilities.resources && client.listResourceTemplates
        ? await collectPages(
            (cursor) => timeout(client.listResourceTemplates(cursor ? { cursor } : {}), server.timeoutMs, `MCP ${server.id} listResourceTemplates`),
            "resourceTemplates",
            MAX_RESOURCE_ITEMS,
          ).catch(() => [])
        : [];
      const prompts = capabilities.prompts
        ? await collectPages(
            (cursor) => timeout(client.listPrompts(cursor ? { cursor } : {}), server.timeoutMs, `MCP ${server.id} listPrompts`),
            "prompts",
            MAX_PROMPT_ITEMS,
          ).catch(() => [])
        : [];
      const connection = {
        server,
        client,
        transport,
        capabilities,
        serverVersion,
        tools,
        resources,
        resourceTemplates,
        prompts,
      };
      this.#connections.set(server.id, connection);
      for (const tool of tools) {
        if (!tool?.name || this.#tools.size >= MAX_DYNAMIC_TOOLS) continue;
        let localName = mcpToolName(server.id, tool.name);
        if (this.#tools.has(localName)) {
          localName = mcpToolName(server.id, `${tool.name}_${this.#tools.size}`);
        }
        this.#tools.set(localName, {
          connection,
          tool,
          public: publicToolRecord(connection, tool, localName),
        });
      }
      this.#registerConnectionCapabilities(connection);
      this.#emit({
        type: "mcp.server.connected",
        serverId: server.id,
        serverName: server.name,
        transport: server.transport,
        tools: tools.length,
        resources: resources.length + resourceTemplates.length,
        prompts: prompts.length,
      });
      return connection;
    } catch (error) {
      try {
        await client.close?.();
      } catch {
        // Best-effort cleanup after failed connect.
      }
      try {
        await transport.close?.();
      } catch {
        // Best-effort cleanup after failed connect.
      }
      this.#emit({
        type: "mcp.server.failed",
        serverId: server.id,
        error: String(error?.message || error),
      });
      throw error;
    }
  }

  #registerConnectionCapabilities(connection) {
    if (!this.#capabilities || !this.#scopeId) return;
    const server = connection.server;
    for (const [localName, record] of this.#tools) {
      if (record.connection !== connection) continue;
      this.#capabilities.upsert({
        id: this.#scopeId + ':tool:mcp:' + server.id + ':' + localName,
        kind: 'tool',
        source: 'mcp',
        name: localName,
        title: record.public.title || record.public.remoteName,
        description: record.public.description || '',
        risk: record.public.readOnly ? 'read' : 'control',
        scopeId: this.#scopeId,
        serverId: server.id,
        readOnly: record.public.readOnly,
        tags: [record.public.destructive ? 'destructive' : '', record.public.openWorld ? 'open-world' : ''].filter(Boolean),
        metadata: { remoteName: record.public.remoteName, serverName: server.name, idempotent: record.public.idempotent },
      });
    }
    const registerResource = (resource, template = false) => {
      const key = String(resource?.uri || resource?.uriTemplate || resource?.name || 'resource');
      const digest = createHash('sha256').update(key).digest('hex').slice(0, 12);
      this.#capabilities.upsert({
        id: this.#scopeId + ':resource:mcp:' + server.id + ':' + digest,
        kind: 'resource',
        source: 'mcp',
        name: String(resource?.name || resource?.uri || resource?.uriTemplate || 'resource'),
        title: String(resource?.title || resource?.name || 'MCP resource'),
        description: String(resource?.description || ''),
        risk: 'read',
        scopeId: this.#scopeId,
        serverId: server.id,
        readOnly: true,
        tags: template ? ['template'] : [],
        metadata: { uri: resource?.uri || null, uriTemplate: resource?.uriTemplate || null, mimeType: resource?.mimeType || null, serverName: server.name },
      });
    };
    for (const resource of connection.resources || []) registerResource(resource, false);
    for (const resource of connection.resourceTemplates || []) registerResource(resource, true);
    for (const prompt of connection.prompts || []) {
      const key = String(prompt?.name || 'prompt');
      const digest = createHash('sha256').update(key).digest('hex').slice(0, 12);
      this.#capabilities.upsert({
        id: this.#scopeId + ':prompt:mcp:' + server.id + ':' + digest,
        kind: 'prompt',
        source: 'mcp',
        name: key,
        title: String(prompt?.title || prompt?.name || 'MCP prompt'),
        description: String(prompt?.description || ''),
        risk: 'none',
        scopeId: this.#scopeId,
        serverId: server.id,
        metadata: { serverName: server.name },
      });
    }
  }
  #connection(serverId) {
    const connection = this.#connections.get(String(serverId || "").trim().toLowerCase());
    if (!connection) throw new Error(`MCP server is not connected: ${serverId}`);
    return connection;
  }

  async #approve(record, requestApproval) {
    if (record.public.readOnly && record.public.autoApproveReadOnly) return;
    if (typeof requestApproval !== "function") {
      throw new Error(`MCP tool ${record.public.name} requires approval.`);
    }
    const approval = await requestApproval({
      kind: record.public.readOnly ? "read" : "control",
      title: `允许 MCP 工具：${record.public.title}`,
      command: `${record.public.serverId} / ${record.public.remoteName}`,
      cwd: ".",
      reason: record.public.readOnly
        ? "MCP Server 将执行其声明为只读的外部工具。"
        : "MCP Server 将执行可能影响外部系统或远程状态的工具。",
      mcp: {
        serverId: record.public.serverId,
        tool: record.public.remoteName,
        readOnlyHint: record.public.readOnly,
      },
    });
    if (!approval?.approved) {
      throw new Error(`The user rejected MCP tool: ${record.public.remoteName}`);
    }
  }

  async call(name, args = {}, { requestApproval } = {}) {
    const localName = String(name || "");
    if (localName === CORE_RESOURCE_LIST) {
      const connection = this.#connection(args.server);
      return {
        server: connection.server.id,
        resources: connection.resources.slice(0, MAX_RESOURCE_ITEMS),
        resourceTemplates: connection.resourceTemplates.slice(0, MAX_RESOURCE_ITEMS),
      };
    }
    if (localName === CORE_RESOURCE_READ) {
      const connection = this.#connection(args.server);
      const uri = String(args.uri || "").trim();
      if (!uri || uri.length > 8_000) throw new Error("A valid MCP resource URI is required.");
      const result = await timeout(
        connection.client.readResource({ uri }),
        connection.server.timeoutMs,
        `MCP ${connection.server.id} readResource`,
      );
      return {
        server: connection.server.id,
        contents: (result?.contents || []).slice(0, 64).map(compactResourceContent),
      };
    }
    if (localName === CORE_PROMPT_LIST) {
      const connection = this.#connection(args.server);
      return { server: connection.server.id, prompts: connection.prompts.slice(0, MAX_PROMPT_ITEMS) };
    }
    if (localName === CORE_PROMPT_GET) {
      const connection = this.#connection(args.server);
      const promptName = String(args.name || "").trim();
      if (!promptName || promptName.length > 300) throw new Error("A valid MCP prompt name is required.");
      const result = await timeout(
        connection.client.getPrompt({
          name: promptName,
          arguments:
            args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
              ? Object.fromEntries(
                  Object.entries(args.arguments)
                    .slice(0, 64)
                    .map(([key, value]) => [String(key), String(value)]),
                )
              : {},
        }),
        connection.server.timeoutMs,
        `MCP ${connection.server.id} getPrompt`,
      );
      return compactMcpResult(result);
    }

    const record = this.#tools.get(localName);
    if (!record) throw new Error(`Unknown MCP tool: ${localName}`);
    await this.#approve(record, requestApproval);
    this.#emit({
      type: "mcp.tool.started",
      serverId: record.public.serverId,
      tool: record.public.remoteName,
      localTool: localName,
      readOnly: record.public.readOnly,
    });
    try {
      const result = await timeout(
        record.connection.client.callTool({
          name: record.public.remoteName,
          arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {},
        }),
        record.connection.server.timeoutMs,
        `MCP ${record.public.serverId}/${record.public.remoteName}`,
      );
      const compacted = compactMcpResult(result);
      this.#emit({
        type: "mcp.tool.completed",
        serverId: record.public.serverId,
        tool: record.public.remoteName,
        localTool: localName,
        success: result?.isError !== true,
      });
      return compacted;
    } catch (error) {
      this.#emit({
        type: "mcp.tool.completed",
        serverId: record.public.serverId,
        tool: record.public.remoteName,
        localTool: localName,
        success: false,
        error: String(error?.message || error),
      });
      throw error;
    }
  }

  async close() {
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    this.#tools.clear();
    if (this.#capabilities && this.#scopeId) {
      this.#capabilities.unregisterScope(this.#scopeId);
    }
    await Promise.allSettled(
      connections.map(async (connection) => {
        try {
          await connection.client.close?.();
        } finally {
          try {
            await connection.transport.close?.();
          } catch {
            // Best-effort transport teardown.
          }
        }
      }),
    );
    this.#emit({ type: "mcp.closed", servers: connections.length });
  }
}

export function createMcpRuntime(options) {
  return new AporiaXMcpRuntime(options);
}
