import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createMcpResultStore } from "./mcp-result-store.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema, PromptListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { version: appVersion } = createRequire(import.meta.url)("../package.json");

const MAX_DYNAMIC_TOOLS = 32; // Active schemas, not the tool catalog.
const MAX_CATALOG_TOOLS_PER_SERVER = 2000;
const MAX_RESOURCE_ITEMS = 200;
const MAX_PROMPT_ITEMS = 200;
const MAX_RESULT_TEXT = 80_000;
const MAX_DESCRIPTION_CHARS = 1_200;
const TOOL_NAME_LIMIT = 64;
const CORE_RESOURCE_LIST = "mcp_list_resources";
const CORE_RESOURCE_READ = "mcp_read_resource";
const CORE_PROMPT_LIST = "mcp_list_prompts";
const CORE_PROMPT_GET = "mcp_get_prompt";
const CORE_RESULT_READ = "mcp_read_result";
const CORE_TOOL_SEARCH = "mcp_search_tools";
const CORE_NAMES = new Set([
  CORE_RESOURCE_LIST,
  CORE_RESOURCE_READ,
  CORE_PROMPT_LIST,
  CORE_PROMPT_GET,
  CORE_RESULT_READ,
  CORE_TOOL_SEARCH,
]);

// Local timeout/cancellation does not prove the remote action was undone.
// Always pass the combined signal into the SDK AND bound our own wait for
// servers/transports that ignore cancellation.
export async function cancellableMcpRequest(invoke, timeoutMs, signals = [], label = "MCP request") {
  const controller = new AbortController();
  const sources = signals.filter(Boolean);
  const cancel = () => controller.abort(Object.assign(new Error(`${label} cancelled; remote outcome may be uncertain.`), { name: "AbortError" }));
  for (const signal of sources) signal.addEventListener("abort", cancel, { once: true });
  if (sources.some(signal => signal.aborted)) cancel();
  const duration = Math.max(1, Math.min(300000, Number(timeoutMs) || 30000));
  const timer = setTimeout(() => controller.abort(Object.assign(new Error(`${label} timed out after ${duration} ms; remote outcome may be uncertain.`), { code: "MCP_TIMEOUT" })), duration);
  let onAbort;
  try {
    controller.signal.throwIfAborted();
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return invoke({ signal: controller.signal, timeout: duration, resetTimeoutOnProgress: false });
    }), cancelled]);
  } finally {
    clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    for (const signal of sources) signal.removeEventListener("abort", cancel);
  }
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
  if (preferred.length <= TOOL_NAME_LIMIT && server === serverId && tool === remoteToolName) return preferred;
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
  return { name: "AporiaX", version: appVersion };
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
  const cursors = new Set();
  let cursor = undefined;
  do {
    const payload = await fetchPage(cursor);
    if (!Array.isArray(payload?.[key])) throw new Error(`Invalid MCP ${key} discovery response.`);
    const next = payload[key];
    if (items.length + next.length > limit || (items.length + next.length === limit && payload.nextCursor)) {
      throw new Error(`MCP ${key} discovery exceeds the explicit catalog limit (${limit}); narrow the server configuration.`);
    }
    items.push(...next.slice(0, Math.max(0, limit - items.length)));
    cursor = payload?.nextCursor || undefined;
    if (cursor && cursors.has(cursor)) throw new Error(`MCP ${key} discovery returned a repeated cursor.`);
    if (cursor) cursors.add(cursor);
    if (cursors.size > 50) throw new Error(`MCP ${key} discovery exceeded the page limit.`);
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
  #discoveryPromise = null;
  #errors = new Map();
  #closed = false;
  #lifetime = new AbortController();
  #selectedTools = [];
  #permissionMode = "read-only";
  #resultStore = createMcpResultStore();
  #nativeResultRefs = new Map();
  #retries = new Map();
  #catalogDirty = new Set();

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
    const active = new Set(this.#activeTools(this.#permissionMode).map((record) => record.public.name));
    const ready = [...this.#connections.values()].map((connection) => ({
      id: connection.server.id,
      name: connection.server.name,
      transport: connection.server.transport,
      connected: true,
      discoveryStatus: "ready",
      toolCount: connection.tools.length,
      activeToolCount: [...this.#tools.values()].filter((record) => record.connection === connection && active.has(record.public.name)).length,
      deferredToolCount: [...this.#tools.values()].filter((record) => record.connection === connection && !active.has(record.public.name)).length,
      resourceCount: connection.resources.length + connection.resourceTemplates.length,
      promptCount: connection.prompts.length,
      serverVersion: connection.serverVersion || null,
      capabilities: connection.capabilities || {},
    }));
    return [...ready, ...[...this.#errors].map(([id, error]) => ({
      id, name: this.#servers.find((server) => server.id === id)?.name || id,
      connected: false, discoveryStatus: "failed", error,
      toolCount: 0, resourceCount: 0, promptCount: 0,
    }))];
  }

  toolCatalog(permissionMode = "read-only") {
    const mode = normalizePermissionMode(permissionMode);
    const active = new Set(this.#activeTools(mode).map((record) => record.public.name));
    return [...this.#tools.values()]
      .sort((a, b) => a.public.name.localeCompare(b.public.name))
      .filter((record) => mode !== "builder-write")
      .filter((record) => mode !== "read-only" || record.public.readOnly)
      .map((record) => ({
        ...record.public,
        permission:
          record.public.readOnly && record.public.autoApproveReadOnly ? "allow" : "ask",
        risk: record.public.readOnly ? "read" : "control",
        mcp: true,
        deferred: !active.has(record.public.name),
      }));
  }

  toolDefinitions(permissionMode = "read-only") {
    const mode = normalizePermissionMode(permissionMode);
    if (mode === "builder-write") return [];
    const dynamic = this.#activeTools(mode)
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
      ...(connections.length ? [{ type: "function", function: {
        name: CORE_TOOL_SEARCH,
        description: "Search the full MCP tool catalog, including deferred tools. Matching tools are activated for the next model request without executing them. Use server_id and/or query; page with offset. Only a bounded set of schemas is loaded at once. Tool permissions still apply.",
        parameters: { type: "object", properties: { query: { type: "string" }, server_id: { type: "string" },
          offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 8 } }, additionalProperties: false },
      } }] : []),
      ...(connections.length || this.#resultStore.persistent ? [{ type: "function", function: {
        name: CORE_RESULT_READ,
        description: "Read the full saved JSON of a large tool result (native or MCP) in UTF-8 byte pages. Use resultRef.id and nextOffset. resultRef.lifetime declares whether it survives task recovery; this never repeats the original tool action.",
        parameters: { type: "object", properties: {
          result_id: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 4, maximum: 32000 },
        }, required: ["result_id"], additionalProperties: false },
      } }] : []),
      ...helperDefinitions(
        connections.map((connection) => connection.server.id),
        connections.some(
          (connection) => connection.resources.length || connection.resourceTemplates.length,
        ),
        connections.some((connection) => connection.prompts.length),
      ),
    ];
  }

  #activeTools(mode) {
    if (mode === "builder-write") return [];
    const available = [...this.#tools.values()].filter((record) => mode !== "read-only" || record.public.readOnly)
      .sort((a, b) => a.public.name.localeCompare(b.public.name));
    const selected = this.#selectedTools.map((name) => available.find((record) => record.public.name === name)).filter(Boolean);
    // Deterministic round-robin: network completion order cannot starve a server.
    const servers = [...new Set(available.map((record) => record.public.serverId))].sort();
    const groups = servers.map((id) => available.filter((record) => record.public.serverId === id && !selected.includes(record)));
    for (let round = 0; selected.length < MAX_DYNAMIC_TOOLS; round++) {
      const next = groups.map((records) => records[round]).filter(Boolean);
      if (!next.length) break;
      selected.push(...next.slice(0, MAX_DYNAMIC_TOOLS - selected.length));
    }
    return selected.slice(0, MAX_DYNAMIC_TOOLS);
  }

  #searchTools(args) {
    const query = args.query ?? "";
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 8;
    if (typeof query !== "string" || query.length > 500 || (args.server_id !== undefined && typeof args.server_id !== "string") ||
      !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error("Invalid MCP tool search parameters.");
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const catalog = this.toolCatalog(this.#permissionMode).filter((record) => (!args.server_id || record.serverId === args.server_id) &&
      terms.every((term) => [record.name, record.remoteName, record.description, record.title, record.serverName].join(" ").toLowerCase().includes(term)));
    const found = catalog.slice(offset, offset + limit);
    this.#selectedTools = [...new Set([...found.map((record) => record.name), ...this.#selectedTools])].slice(0, MAX_DYNAMIC_TOOLS);
    this.#emit({ type: "mcp.tools.activated", tools: found.map((record) => record.name), totalMatches: catalog.length });
    return { tools: found.map((record) => ({ ...record, deferred: false })), totalMatches: catalog.length,
      nextOffset: offset + limit < catalog.length ? offset + limit : null, note: "Schemas are available on the next model request. No tool has been executed." };
  }

  hasTool(name) {
    return this.#tools.has(String(name || "")) || CORE_NAMES.has(String(name || ""));
  }

  async setServers(servers, { retryServerIds = [] } = {}) {
    if (this.#closed) return;
    const next = (Array.isArray(servers) ? servers : []).filter((server) => server?.enabled !== false);
    const byId = new Map(next.map((server) => [server.id, server]));
    for (const [id, connection] of this.#connections) {
      if (JSON.stringify(byId.get(id)) === JSON.stringify(connection.server)) continue;
      this.#dropConnection(id, connection);
      await connection.client.close?.().catch(() => {});
      await connection.transport.close?.().catch(() => {});
    }
    for (const old of this.#servers) if (!byId.has(old.id) || JSON.stringify(byId.get(old.id)) !== JSON.stringify(old)) {
      this.#errors.delete(old.id); this.#retries.delete(old.id);
    }
    this.#servers = [...byId.values()];
    // A fresh explicit user mention grants a new bounded connection attempt,
    // not permission to replay any tool. Ordinary refresh retains its backoff.
    for (const id of retryServerIds) if (byId.has(id) && !this.#connections.has(id)) {
      this.#retries.delete(id); this.#errors.delete(id);
    }
  }

  #dropConnection(id, connection) {
    this.#connections.delete(id);
    this.#catalogDirty.delete(id);
    for (const [name, record] of this.#tools) if (record.connection === connection) this.#tools.delete(name);
    for (const capability of this.#capabilities?.list({ source: "mcp", scopeId: this.#scopeId }) || []) {
      if (capability.serverId === id) this.#capabilities.unregister(capability.id);
    }
  }

  async refresh({ permissionMode = this.#permissionMode, signal } = {}) {
    if (signal?.aborted || this.#closed) return;
    // Refresh schemas only. A transport reconnect never replays a tool call.
    for (const id of [...this.#catalogDirty]) {
      const connection = this.#connections.get(id);
      if (!connection) continue;
      this.#catalogDirty.delete(id);
      try {
        const { client, server, capabilities } = connection;
        const pages = (method, key, limit) => collectPages((cursor) => cancellableMcpRequest(options => client[method](cursor ? { cursor } : {}, options), server.timeoutMs, [signal, this.#lifetime.signal], `MCP ${id} ${method}`), key, limit);
        const tools = capabilities.tools ? await pages("listTools", "tools", MAX_CATALOG_TOOLS_PER_SERVER) : [];
        const resources = capabilities.resources ? await pages("listResources", "resources", MAX_RESOURCE_ITEMS) : [];
        const resourceTemplates = capabilities.resources && client.listResourceTemplates
          ? await pages("listResourceTemplates", "resourceTemplates", MAX_RESOURCE_ITEMS).catch(error => { if (error?.code === -32601) return []; throw error; }) : [];
        const prompts = capabilities.prompts ? await pages("listPrompts", "prompts", MAX_PROMPT_ITEMS) : [];
        const names = new Set();
        for (const tool of tools) {
          if (typeof tool?.name !== "string" || !tool.name.trim() || names.has(tool.name)) throw new Error("Invalid or duplicate MCP tool name in catalog.");
          names.add(tool.name);
        }
        if (this.#closed || signal?.aborted || this.#connections.get(id) !== connection) continue;
        this.#dropConnection(id, connection);
        Object.assign(connection, { tools, resources, resourceTemplates, prompts });
        this.#connections.set(id, connection);
        for (const tool of tools) {
          let localName = mcpToolName(id, tool.name);
          if (this.#tools.has(localName)) localName = mcpToolName(id, `${tool.name}_${this.#tools.size}`);
          this.#tools.set(localName, { connection, tool, public: publicToolRecord(connection, tool, localName) });
        }
        this.#registerConnectionCapabilities(connection);
        this.#emit({ type: "mcp.catalog.updated", serverId: id, tools: tools.length });
      } catch (error) {
        this.#dropConnection(id, connection);
        await connection.client.close?.().catch(() => {});
        await connection.transport.close?.().catch(() => {});
        this.#errors.set(id, safeMcpError(error, connection.server));
        this.#retries.set(id, { attempts: 1, after: Date.now() + 1000 });
        this.#emit({ type: "mcp.server.failed", serverId: id, error: safeMcpError(error, connection.server) });
      }
    }
    return this.discover({ permissionMode, automatic: true, signal });
  }

  async discover({ permissionMode = "read-only", automatic = false, signal } = {}) {
    if (this.#closed) throw new Error("MCP runtime is closed.");
    if (signal?.aborted) throw Object.assign(new Error("MCP discovery cancelled."), { name: "AbortError" });
    this.#permissionMode = normalizePermissionMode(permissionMode);
    for (const server of this.#servers.slice(32)) this.#errors.set(server.id, "MCP server limit (32) exceeded; this server was not connected.");
    if (!this.#discoveryPromise) {
      this.#discoveryPromise = Promise.allSettled(
        this.#servers.slice(0, 32).filter((server) => {
          const retry = this.#retries.get(server.id);
          return !this.#connections.has(server.id) && (!automatic || !retry || (retry.attempts < 3 && Date.now() >= retry.after));
        })
          .map(async (server) => {
            try { await this.#connectServer(server, signal); this.#errors.delete(server.id); this.#retries.delete(server.id); }
            catch (error) {
              const attempts = (this.#retries.get(server.id)?.attempts || 0) + 1;
              this.#retries.set(server.id, { attempts, after: Date.now() + Math.min(30_000, 1000 * 2 ** (attempts - 1)) });
              this.#errors.set(server.id, safeMcpError(error, server));
            }
          }),
      );
    }
    const pending = this.#discoveryPromise;
    try { await pending; signal?.throwIfAborted(); }
    finally { if (this.#discoveryPromise === pending) this.#discoveryPromise = null; }
    return {
      servers: this.serverSummaries(),
      tools: this.toolCatalog(permissionMode),
      errors: [...this.#errors].map(([serverId, error]) => ({ serverId, error })),
    };
  }

  async #connectServer(server, signal) {
    if (server.missingEnvironment?.length) throw new Error("MCP_ENV_MISSING: " + server.missingEnvironment.join(", "));
    this.#emit({ type: "mcp.server.connecting", serverId: server.id, transport: server.transport });
    const client = this.#clientFactory(server);
    const transport = this.#transportFactory(server);
    // Servers may write verbose startup logs. Drain the pipe so backpressure
    // cannot deadlock discovery; do not forward potentially secret-bearing logs.
    transport.stderr?.resume?.();
    try {
      await cancellableMcpRequest(() => client.connect(transport), server.timeoutMs, [signal, this.#lifetime.signal], `MCP ${server.id} connect`);
      const capabilities = client.getServerCapabilities?.() || {};
      const serverVersion = client.getServerVersion?.() || null;
      const tools = capabilities.tools ? await collectPages(
        (cursor) => cancellableMcpRequest(options => client.listTools(cursor ? { cursor } : {}, options), server.timeoutMs, [signal, this.#lifetime.signal], `MCP ${server.id} listTools`),
        "tools",
        MAX_CATALOG_TOOLS_PER_SERVER,
      ) : [];
      const resources = capabilities.resources
        ? await collectPages(
            (cursor) => cancellableMcpRequest(options => client.listResources(cursor ? { cursor } : {}, options), server.timeoutMs, [signal, this.#lifetime.signal], `MCP ${server.id} listResources`),
            "resources",
            MAX_RESOURCE_ITEMS,
          )
        : [];
      const resourceTemplates = capabilities.resources && client.listResourceTemplates
        ? await collectPages(
            (cursor) => cancellableMcpRequest(options => client.listResourceTemplates(cursor ? { cursor } : {}, options), server.timeoutMs, [signal, this.#lifetime.signal], `MCP ${server.id} listResourceTemplates`),
            "resourceTemplates",
            MAX_RESOURCE_ITEMS,
          ).catch((error) => { if (error?.code === -32601) return []; throw error; })
        : [];
      const prompts = capabilities.prompts
        ? await collectPages(
            (cursor) => cancellableMcpRequest(options => client.listPrompts(cursor ? { cursor } : {}, options), server.timeoutMs, [signal, this.#lifetime.signal], `MCP ${server.id} listPrompts`),
            "prompts",
            MAX_PROMPT_ITEMS,
          )
        : [];
      if (this.#closed) throw new Error("MCP runtime closed during discovery.");
      const names = new Set();
      for (const tool of tools) {
        if (typeof tool?.name !== "string" || !tool.name.trim() || names.has(tool.name)) throw new Error("Invalid or duplicate MCP tool name in catalog.");
        names.add(tool.name);
      }
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
      client.onclose = () => {
        if (this.#closed || this.#connections.get(server.id) !== connection) return;
        this.#dropConnection(server.id, connection);
        this.#retries.set(server.id, { attempts: 0, after: Date.now() + 1000 });
        this.#errors.set(server.id, "MCP_DISCONNECTED: the service connection closed; reconnect before calling tools.");
        this.#emit({ type: "mcp.server.failed", serverId: server.id, error: "MCP_DISCONNECTED" });
      };
      for (const schema of [ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema, PromptListChangedNotificationSchema]) {
        client.setNotificationHandler?.(schema, () => {
          if (!this.#closed && this.#connections.get(server.id) === connection) this.#catalogDirty.add(server.id);
        });
      }
      for (const tool of tools) {
        if (!tool?.name) continue;
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
        error: safeMcpError(error, server),
      });
      throw new Error(safeMcpError(error, server));
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

  async call(name, args = {}, { requestApproval, signal } = {}) {
    signal?.throwIfAborted();
    const localName = String(name || "");
    if (this.#closed) throw new Error("MCP runtime is closed.");
    if (this.#permissionMode === "builder-write") throw new Error("MCP tools are disabled for isolated Builders.");
    if (localName === CORE_TOOL_SEARCH) return this.#searchTools(args);
    if (localName === CORE_RESULT_READ) return this.#resultStore.read(args);
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
      const result = await cancellableMcpRequest(
        options => connection.client.readResource({ uri }, options),
        connection.server.timeoutMs, [signal, this.#lifetime.signal],
        `MCP ${connection.server.id} readResource`,
      );
      return this.#modelResult({
        server: connection.server.id,
        ...result,
      });
    }
    if (localName === CORE_PROMPT_LIST) {
      const connection = this.#connection(args.server);
      return { server: connection.server.id, prompts: connection.prompts.slice(0, MAX_PROMPT_ITEMS) };
    }
    if (localName === CORE_PROMPT_GET) {
      const connection = this.#connection(args.server);
      const promptName = String(args.name || "").trim();
      if (!promptName || promptName.length > 300) throw new Error("A valid MCP prompt name is required.");
      const result = await cancellableMcpRequest(
        options => connection.client.getPrompt({
          name: promptName,
          arguments:
            args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
              ? Object.fromEntries(
                  Object.entries(args.arguments)
                    .slice(0, 64)
                    .map(([key, value]) => [String(key), String(value)]),
                )
              : {},
        }, options),
        connection.server.timeoutMs, [signal, this.#lifetime.signal],
        `MCP ${connection.server.id} getPrompt`,
      );
      return this.#modelResult(result);
    }

    const record = this.#tools.get(localName);
    if (!record) throw new Error(`Unknown MCP tool: ${localName}`);
    if (this.#permissionMode === "read-only" && !record.public.readOnly) throw new Error("MCP tool is not available in read-only mode.");
    await this.#approve(record, requestApproval);
    signal?.throwIfAborted();
    this.#lifetime.signal.throwIfAborted();
    this.#emit({
      type: "mcp.tool.started",
      serverId: record.public.serverId,
      tool: record.public.remoteName,
      localTool: localName,
      readOnly: record.public.readOnly,
    });
    try {
      const result = await cancellableMcpRequest(
        options => record.connection.client.callTool({
          name: record.public.remoteName,
          arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {},
        }, undefined, options),
        record.connection.server.timeoutMs, [signal, this.#lifetime.signal],
        `MCP ${record.public.serverId}/${record.public.remoteName}`,
      );
      const compacted = await this.#modelResult(result);
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
        error: safeMcpError(error, record.connection.server),
      });
      throw Object.assign(new Error(safeMcpError(error, record.connection.server)), { name: error.name, code: error.code });
    }
  }

  async close() {
    this.#closed = true;
    this.#lifetime.abort();
    await this.#discoveryPromise;
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    this.#tools.clear();
    this.#errors.clear();
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
    this.#nativeResultRefs.clear();
    await this.#resultStore.close();
    this.#emit({ type: "mcp.closed", servers: connections.length });
  }

  // Local native evidence shares the task-owned pager. No MCP server is called,
  // no user path is accepted, and Builder-only tool sets remain unchanged.
  async retainNativeResult(result) {
    if (this.#permissionMode === "builder-write" || !this.#resultStore.persistent ||
        !result || typeof result !== "object" || result.resultRef) return result;
    const text = JSON.stringify(result);
    if (text.length <= 16_000 || text.length > 1_000_000) return result;
    const key = createHash("sha256").update(text).digest("hex");
    let resultRef = this.#nativeResultRefs.get(key);
    if (!resultRef) {
      resultRef = await this.#resultStore.put(text);
      this.#nativeResultRefs.set(key, resultRef);
      if (this.#nativeResultRefs.size > 128) this.#nativeResultRefs.delete(this.#nativeResultRefs.keys().next().value);
    }
    return { ...result, resultRef };
  }

  async #modelResult(result) {
    const text = JSON.stringify(result) ?? "null";
    const compacted = compactMcpResult(result);
    if (text.length <= 24_000 && JSON.stringify(compacted) === text) return compacted;
    let resultRef = null;
    let storageError;
    try { resultRef = await this.#resultStore.put(text); }
    catch (error) { storageError = String(error?.message || error); }
    return {
      ...(typeof result?.isError === "boolean" ? { isError: result.isError } : {}),
      content: [{ type: "text", text: `${text.slice(0, 12_000)}\n[MCP result preview; full JSON is ${text.length} characters]` }],
      truncated: true, resultRef,
      ...(storageError ? { storageError, warning: "The original tool completed but its full result could not be saved. Do not repeat a side-effecting action just to retrieve output." } : {}),
    };
  }
}

export function createMcpRuntime(options) {
  return new AporiaXMcpRuntime(options);
}

function safeMcpError(error, server) {
  let message = String(error?.message || error);
  for (const value of [...(server?.redactValues || [])].sort((a, b) => b.length - a.length)) {
    if (value) message = message.replaceAll(value, "[redacted]").replaceAll(encodeURIComponent(value), "[redacted]");
  }
  return message;
}
