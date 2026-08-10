import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const PLUGIN_NAME = /^[a-z][a-z0-9_-]{1,63}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{1,79}$/;

function normalizePluginTool(tool, pluginName) {
  const name = String(tool?.name || tool?.definition?.function?.name || "").trim();
  if (!TOOL_NAME.test(name)) throw new Error(`Invalid plugin tool name: ${name || "<empty>"}`);
  const risk = ["read", "write", "execute", "control"].includes(tool?.risk) ? tool.risk : "read";
  const definition = tool?.definition || {
    type: "function",
    function: {
      name,
      description: String(tool?.description || `Tool provided by ${pluginName}`).slice(0, 1_000),
      parameters:
        tool?.parameters && typeof tool.parameters === "object"
          ? tool.parameters
          : { type: "object", properties: {}, additionalProperties: false },
    },
  };
  return Object.freeze({
    ...tool,
    name,
    risk,
    definition,
    plugin: pluginName,
  });
}

export class HarnessPluginHost {
  #plugins = new Map();
  #eventBus;
  #agents;
  #toolHost;
  #fallbackTools = new Map();

  constructor({ eventBus, agentRegistry, toolHost = null } = {}) {
    this.#eventBus = eventBus;
    this.#agents = agentRegistry;
    this.#toolHost = toolHost;
  }

  register(plugin) {
    const name = String(plugin?.name || "").trim();
    if (!PLUGIN_NAME.test(name)) throw new Error(`Invalid plugin name: ${name || "<empty>"}`);
    if (this.#plugins.has(name)) throw new Error(`Plugin already registered: ${name}`);
    if (typeof plugin.setup !== "function") throw new Error(`Plugin ${name} must export setup(api).`);

    const disposers = [];
    const toolNames = [];
    const api = Object.freeze({
      events: Object.freeze({
        on: (pattern, handler) => {
          const dispose = this.#eventBus?.on(pattern, handler) || (() => undefined);
          disposers.push(dispose);
          return dispose;
        },
        hook: (pattern, handler, options) => {
          const dispose = this.#eventBus?.hook(pattern, handler, {
            ...options,
            id: options?.id || `${name}:${pattern}`,
          }) || (() => undefined);
          disposers.push(dispose);
          return dispose;
        },
        emit: (event) => this.#eventBus?.emit({ ...event, plugin: name }),
      }),
      agents: Object.freeze({
        register: (definition) => this.#agents?.register({ ...definition, source: `plugin:${name}` }),
        get: (agentName) => this.#agents?.get(agentName) || null,
      }),
      tools: Object.freeze({
        register: (tool) => {
          const normalized = normalizePluginTool(tool, name);
          if (this.#toolHost) {
            this.#toolHost.register(normalized);
          } else {
            if (this.#fallbackTools.has(normalized.name)) {
              throw new Error(`Plugin tool already registered: ${normalized.name}`);
            }
            this.#fallbackTools.set(normalized.name, normalized);
          }
          toolNames.push(normalized.name);
          return normalized;
        },
        get: (toolName) =>
          this.#toolHost?.get(toolName) || this.#fallbackTools.get(String(toolName)) || null,
      }),
    });

    const setupResult = plugin.setup(api);
    if (typeof setupResult === "function") disposers.push(setupResult);
    const record = {
      name,
      version: String(plugin.version || "0.0.0"),
      description: String(plugin.description || ""),
      disposers,
      toolNames,
    };
    this.#plugins.set(name, record);
    this.#eventBus?.emit({ type: "plugin.registered", plugin: name, version: record.version });
    return this.get(name);
  }

  unregister(name) {
    const record = this.#plugins.get(String(name));
    if (!record) return false;
    for (const dispose of record.disposers.reverse()) {
      try {
        dispose?.();
      } catch {
        // Cleanup should continue for the rest of the plugin registrations.
      }
    }
    for (const toolName of record.toolNames) {
      this.#toolHost?.unregister(toolName);
      this.#fallbackTools.delete(toolName);
    }
    this.#plugins.delete(record.name);
    this.#eventBus?.emit({ type: "plugin.unregistered", plugin: record.name });
    return true;
  }

  get(name) {
    const record = this.#plugins.get(String(name));
    return record
      ? { name: record.name, version: record.version, description: record.description, tools: [...record.toolNames] }
      : null;
  }

  list() {
    return [...this.#plugins.values()].map((record) => ({
      name: record.name,
      version: record.version,
      description: record.description,
      tools: [...record.toolNames],
    }));
  }

  tools() {
    if (this.#toolHost) {
      return this.#toolHost.list().filter((tool) => Boolean(tool.plugin));
    }
    return [...this.#fallbackTools.values()];
  }
}

export async function loadPluginModule(filePath, host, { allowLocalCode = false } = {}) {
  if (!allowLocalCode) {
    throw new Error("Loading local plugin code is disabled. Enable allowLocalCode explicitly for trusted plugins.");
  }
  const moduleUrl = pathToFileURL(resolve(filePath)).href;
  const imported = await import(moduleUrl);
  const plugin = imported.default || imported.plugin || imported;
  return host.register(plugin);
}
