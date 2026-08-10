import { ToolRegistry, getToolPermission } from "../agent-core.js";

export class HarnessToolHost {
  #descriptors = new Map();
  #eventBus;

  constructor({ descriptors = [], eventBus = null } = {}) {
    this.#eventBus = eventBus;
    for (const descriptor of descriptors) this.register(descriptor);
  }

  register(descriptor) {
    const name = descriptor?.definition?.function?.name;
    if (!name) throw new Error("Tool descriptor requires definition.function.name.");
    if (this.#descriptors.has(name)) throw new Error(`Tool already registered: ${name}`);
    if (!["read", "write", "execute", "control"].includes(descriptor?.risk)) {
      throw new Error(`Tool ${name} has an invalid risk classification.`);
    }
    const normalized = Object.freeze({ ...descriptor, name });
    this.#descriptors.set(name, normalized);
    this.#eventBus?.emit({ type: "tool.registered", tool: name, risk: normalized.risk, plugin: normalized.plugin || null });
    return normalized;
  }

  unregister(name) {
    const key = String(name || "");
    const descriptor = this.#descriptors.get(key);
    if (!descriptor) return false;
    this.#descriptors.delete(key);
    this.#eventBus?.emit({ type: "tool.unregistered", tool: key, plugin: descriptor.plugin || null });
    return true;
  }

  registerPluginTools(pluginTools = []) {
    const registered = [];
    for (const pluginTool of pluginTools) {
      if (!pluginTool?.definition) continue;
      registered.push(this.register(pluginTool));
    }
    return registered;
  }

  get(name) {
    return this.#descriptors.get(String(name || "")) || null;
  }

  createRegistry() {
    return new ToolRegistry([...this.#descriptors.values()]);
  }

  catalog(policy = { "*": "deny" }) {
    return [...this.#descriptors.values()].map((descriptor) => ({
      name: descriptor.name,
      risk: descriptor.risk,
      permission: getToolPermission(policy, descriptor.name),
      plugin: descriptor.plugin || null,
    }));
  }

  list() {
    return [...this.#descriptors.values()];
  }
}
