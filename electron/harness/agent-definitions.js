import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const NAME_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const VALID_PERMISSION_ACTIONS = new Set(["allow", "ask", "deny"]);

const BUILTIN_AGENT_DEFINITIONS = Object.freeze({
  explore: Object.freeze({
    name: "explore",
    description:
      "Search and understand the codebase with exact evidence. Do not edit files.",
    tools: Object.freeze([
      "list_directory",
      "read_file",
      "search_text",
      "git_status",
      "git_diff",
      "inspect_office_file",
    ]),
    permissions: Object.freeze({ "*": "deny" }),
    maxRounds: 8,
    background: false,
    triggers: Object.freeze([]),
    systemPrompt:
      "Return concise, evidence-backed findings to the parent agent.",
  }),
  review: Object.freeze({
    name: "review",
    description:
      "Review current code or artifacts for correctness, security, completeness, maintainability, and regressions. Do not edit files.",
    tools: Object.freeze([
      "list_directory",
      "read_file",
      "search_text",
      "git_status",
      "git_diff",
      "inspect_office_file",
    ]),
    permissions: Object.freeze({ "*": "deny" }),
    maxRounds: 6,
    background: true,
    triggers: Object.freeze(["plan.step.completed", "changes.batch.ready"]),
    systemPrompt:
      "Review only current file versions and return actionable findings with evidence.",
  }),
  verify: Object.freeze({
    name: "verify",
    description:
      "Verify focused claims using repository evidence and project commands. Do not edit source files.",
    tools: Object.freeze([
      "list_directory",
      "read_file",
      "search_text",
      "git_status",
      "git_diff",
      "inspect_office_file",
      "run_command",
    ]),
    permissions: Object.freeze({ "*": "deny", run_command: "ask" }),
    maxRounds: 4,
    background: true,
    triggers: Object.freeze(["verification.requested"]),
    systemPrompt:
      "Report exact commands, exit codes, evidence, and remaining uncertainty.",
  }),
  curator: Object.freeze({
    name: "curator",
    description:
      "Extract durable, reusable Project Understanding from verified task changes.",
    tools: Object.freeze([
      "list_directory",
      "read_file",
      "search_text",
      "git_status",
      "git_diff",
      "inspect_office_file",
    ]),
    permissions: Object.freeze({ "*": "deny" }),
    maxRounds: 6,
    background: true,
    triggers: Object.freeze(["task.completed"]),
    systemPrompt:
      "Store only reusable, evidence-backed project facts and never invent unsupported claims.",
  }),
  builder: Object.freeze({
    name: "builder",
    description:
      "Implement and verify one delegated change inside an isolated worktree and explicit non-overlapping write scopes.",
    tools: Object.freeze([
      "list_directory",
      "read_file",
      "search_text",
      "git_status",
      "git_diff",
      "write_file",
      "apply_patch",
      "run_command",
      "complete_self_check",
    ]),
    permissions: Object.freeze({
      "*": "deny",
      list_directory: "allow",
      read_file: "allow",
      search_text: "allow",
      git_status: "allow",
      git_diff: "allow",
      write_file: "allow",
      apply_patch: "allow",
      run_command: "allow",
      complete_self_check: "allow",
    }),
    maxRounds: 8,
    background: true,
    triggers: Object.freeze(["task.builder.ready"]),
    systemPrompt:
      "Modify only the delegated write scopes. You may run relevant build, test, lint, or typecheck commands inside your isolated worktree to verify the implementation. Never broaden the scope, access unrelated external systems, or edit files owned by another Builder.",
  }),
});

function parseScalar(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (
    (text.startsWith("[") && text.endsWith("]")) ||
    (text.startsWith("{") && text.endsWith("}"))
  ) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text.replace(/^['"]|['"]$/g, "");
}

function parseFrontmatter(content) {
  const source = String(content || "");
  if (!source.startsWith("---")) {
    return { metadata: {}, body: source.trim() };
  }
  const end = source.indexOf("\n---", 3);
  if (end < 0) return { metadata: {}, body: source.trim() };
  const header = source.slice(3, end).trim();
  const body = source.slice(end + 4).replace(/^\r?\n/, "").trim();
  const metadata = {};
  for (const rawLine of header.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = parseScalar(line.slice(separator + 1));
    metadata[key] = value;
  }
  return { metadata, body };
}

function toStringArray(value, fallback = []) {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value.map((item) => String(item || "").trim()).filter(Boolean),
      ),
    ];
  }
  if (typeof value === "string" && value.trim()) {
    return [
      ...new Set(
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
  }
  return [...fallback];
}

function normalizePermissions(value, fallback = {}) {
  const input =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const output = { ...fallback };
  for (const [name, action] of Object.entries(input)) {
    const normalized = String(action || "").trim();
    if (VALID_PERMISSION_ACTIONS.has(normalized)) {
      output[name] = normalized;
    }
  }
  return Object.freeze(output);
}

function normalizeAgentDefinition(
  input,
  builtins = BUILTIN_AGENT_DEFINITIONS,
) {
  const name = String(input?.name || "").trim();
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Invalid agent definition name: ${name || "<empty>"}`);
  }
  const baseName = String(input?.extends || "").trim();
  const base = baseName ? builtins[baseName] : null;
  if (baseName && !base) {
    throw new Error(`Agent ${name} extends unknown definition: ${baseName}`);
  }
  const maxRounds = Math.max(
    2,
    Math.min(
      20,
      Number(
        input?.maxRounds ?? input?.max_rounds ?? base?.maxRounds ?? 8,
      ) || 8,
    ),
  );
  return Object.freeze({
    name,
    extends: baseName || null,
    description: String(
      input?.description || base?.description || "",
    )
      .trim()
      .slice(0, 1_000),
    tools: Object.freeze(
      toStringArray(input?.tools, base?.tools || []),
    ),
    permissions: normalizePermissions(
      input?.permissions,
      base?.permissions || { "*": "deny" },
    ),
    maxRounds,
    background:
      input?.background === undefined
        ? Boolean(base?.background)
        : Boolean(input.background),
    triggers: Object.freeze(
      toStringArray(input?.triggers, base?.triggers || []),
    ),
    systemPrompt: String(
      input?.systemPrompt ||
        input?.system_prompt ||
        base?.systemPrompt ||
        "",
    )
      .trim()
      .slice(0, 4_000),
  });
}

export class AgentDefinitionRegistry {
  #definitions = new Map();

  constructor() {
    for (const definition of Object.values(BUILTIN_AGENT_DEFINITIONS)) {
      this.#definitions.set(definition.name, definition);
    }
  }

  get(name) {
    return this.#definitions.get(String(name || "").trim()) || null;
  }

  list() {
    return [...this.#definitions.values()];
  }

  register(input, { source = "runtime" } = {}) {
    const normalized = normalizeAgentDefinition(input);
    const record = Object.freeze({ ...normalized, source });
    this.#definitions.set(record.name, record);
    return record;
  }

  async discover(directoryPath) {
    if (!directoryPath) return [];
    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const discovered = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".agent.md")) continue;
      const content = await readFile(join(directoryPath, entry.name), "utf8");
      const { metadata, body } = parseFrontmatter(content);
      const name = String(
        metadata.name || entry.name.replace(/\.agent\.md$/, ""),
      ).trim();
      discovered.push(
        this.register(
          {
            ...metadata,
            name,
            systemPrompt: body || metadata.systemPrompt || "",
          },
          { source: entry.name },
        ),
      );
    }
    return discovered;
  }
}

export function createAgentDefinitionRegistry() {
  return new AgentDefinitionRegistry();
}
