import {
  defaultCapabilityPresentation,
  normalizeCapabilityPresentation,
  publicToolCapability,
} from "./capability-presentation.js";

const VALID_KINDS = new Set(["tool", "resource", "prompt", "agent", "skill"]);
const VALID_SOURCES = new Set(["native", "browser", "plugin", "mcp", "skill", "runtime"]);
const VALID_RISKS = new Set(["read", "write", "execute", "control", "none"]);

function normalizeString(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function normalizeCapability(input = {}) {
  const kind = normalizeString(input.kind, 40).toLowerCase();
  const source = normalizeString(input.source || "runtime", 40).toLowerCase();
  const name = normalizeString(input.name, 160);
  if (!VALID_KINDS.has(kind)) throw new Error(`Invalid capability kind: ${kind || "<empty>"}`);
  if (!VALID_SOURCES.has(source)) throw new Error(`Invalid capability source: ${source || "<empty>"}`);
  if (!name) throw new Error("Capability requires a name.");
  const risk = normalizeString(input.risk || "none", 40).toLowerCase();
  if (!VALID_RISKS.has(risk)) throw new Error(`Invalid capability risk: ${risk}`);
  const scopeId = normalizeString(input.scopeId, 180);
  const id = normalizeString(
    input.id || `${scopeId ? `${scopeId}:` : ""}${kind}:${source}:${name}`,
    500,
  );
  const title = normalizeString(input.title || name, 200);
  const presentation = normalizeCapabilityPresentation(input.presentation, {
    name,
    title,
    source,
    risk,
  });
  return Object.freeze({
    id,
    kind,
    source,
    name,
    title,
    description: normalizeString(input.description, 1_600),
    risk,
    scopeId: scopeId || null,
    provider: normalizeString(input.provider, 160) || null,
    plugin: normalizeString(input.plugin, 160) || null,
    serverId: normalizeString(input.serverId, 160) || null,
    readOnly: input.readOnly === true || risk === "read",
    observable: input.observable !== false,
    tags: Object.freeze(
      [...new Set((Array.isArray(input.tags) ? input.tags : []).map((tag) => normalizeString(tag, 80)).filter(Boolean))].slice(0, 20),
    ),
    presentation,
    metadata:
      input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
        ? Object.freeze({ ...input.metadata })
        : Object.freeze({}),
  });
}

export class HarnessCapabilityRegistry {
  #records = new Map();
  #eventBus;

  constructor({ eventBus = null } = {}) {
    this.#eventBus = eventBus;
  }

  register(input, { replace = false } = {}) {
    const record = normalizeCapability(input);
    if (this.#records.has(record.id) && !replace) {
      throw new Error(`Capability already registered: ${record.id}`);
    }
    this.#records.set(record.id, record);
    this.#eventBus?.emit({
      type: "capability.registered",
      capability: {
        id: record.id,
        kind: record.kind,
        source: record.source,
        name: record.name,
        risk: record.risk,
        scopeId: record.scopeId,
        presentation: record.presentation,
      },
    });
    return record;
  }

  upsert(input) {
    return this.register(input, { replace: true });
  }

  unregister(id) {
    const key = String(id || "");
    const record = this.#records.get(key);
    if (!record) return false;
    this.#records.delete(key);
    this.#eventBus?.emit({
      type: "capability.unregistered",
      capability: {
        id: record.id,
        kind: record.kind,
        source: record.source,
        name: record.name,
        scopeId: record.scopeId,
      },
    });
    return true;
  }

  unregisterScope(scopeId) {
    const normalized = normalizeString(scopeId, 180);
    if (!normalized) return 0;
    let removed = 0;
    for (const record of [...this.#records.values()]) {
      if (record.scopeId !== normalized) continue;
      if (this.unregister(record.id)) removed += 1;
    }
    return removed;
  }

  get(id) {
    return this.#records.get(String(id || "")) || null;
  }

  find({ kind = "", source = "", name = "", scopeId = "" } = {}) {
    return this.list({ kind, source, name, scopeId })[0] || null;
  }

  list({ kind = "", source = "", name = "", scopeId = "" } = {}) {
    const normalizedKind = normalizeString(kind, 40).toLowerCase();
    const normalizedSource = normalizeString(source, 40).toLowerCase();
    const normalizedName = normalizeString(name, 160);
    const normalizedScope = normalizeString(scopeId, 180);
    return [...this.#records.values()].filter((record) => {
      if (normalizedKind && record.kind !== normalizedKind) return false;
      if (normalizedSource && record.source !== normalizedSource) return false;
      if (normalizedName && record.name !== normalizedName) return false;
      if (normalizedScope && record.scopeId !== normalizedScope) return false;
      return true;
    });
  }

  describeTool(name, phase = "work") {
    const matches = this.list({ kind: "tool", name: String(name || "") });
    if (!matches.length) {
      const fallback = normalizeCapability({
        kind: "tool",
        source: "runtime",
        name: String(name || "tool"),
        title: String(name || "tool"),
        risk: "control",
        presentation: defaultCapabilityPresentation({
          name: String(name || "tool"),
          title: String(name || "tool"),
          source: "runtime",
          risk: "control",
        }),
      });
      return publicToolCapability(fallback, phase);
    }
    // Dynamic scoped capabilities (for example MCP) are appended after static
    // registrations. Prefer the most recently registered matching capability.
    return publicToolCapability(matches.at(-1), phase);
  }

  summary() {
    const records = this.list();
    const byKind = {};
    const bySource = {};
    for (const record of records) {
      byKind[record.kind] = (byKind[record.kind] || 0) + 1;
      bySource[record.source] = (bySource[record.source] || 0) + 1;
    }
    return {
      total: records.length,
      byKind,
      bySource,
    };
  }
}

export function createCapabilityRegistry(options) {
  return new HarnessCapabilityRegistry(options);
}

export function capabilityFromToolDescriptor(descriptor = {}) {
  const name = descriptor?.definition?.function?.name || descriptor?.name;
  const browser = String(name || "").startsWith("browser_");
  const source = descriptor.source || (descriptor.plugin ? "plugin" : browser ? "browser" : "native");
  const title = descriptor.title || name;
  const risk = descriptor.risk || "control";
  return {
    kind: "tool",
    source,
    name,
    title,
    description: descriptor?.definition?.function?.description || descriptor.description || "",
    risk,
    plugin: descriptor.plugin || null,
    provider: descriptor.provider || null,
    tags: descriptor.tags || [],
    presentation:
      descriptor.presentation ||
      defaultCapabilityPresentation({ name, title, source, risk }),
    metadata: {
      functionSchema: descriptor?.definition?.function?.parameters || null,
    },
  };
}
