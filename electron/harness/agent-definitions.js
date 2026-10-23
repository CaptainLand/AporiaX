import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DELEGATED_NATIVE_TOOLS } from '../../shared/delegated-capabilities.js';

const NAME_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const VALID_PERMISSION_ACTIONS = new Set(["allow", "ask", "deny"]);
const readPermissions = (extra = {}) => Object.freeze({
  "*": "deny",
  ...Object.fromEntries(["verify_numeric_data", "list_directory", "read_file", "search_text", "find_files", "git_status", "git_diff", "inspect_office_file", "task_brief", "replan_strategy"].map((name) => [name, "allow"])),
  ...extra,
});

const ROLE_RESPONSIBILITIES = Object.freeze({
  explore: Object.freeze({
    name: "explore",
    description:
      "Search and understand the codebase with exact evidence. Do not edit files.",
    tools: Object.freeze([
      'web_search', 'web_fetch',
      "task_brief", "replan_strategy",
      "list_directory",
      "read_file",
      "search_text",
      'find_files',
      "git_status",
      "git_diff",
      "inspect_office_file",
    ]),
    permissions: readPermissions({ web_search: 'allow', web_fetch: 'allow' }),
    maxRounds: null,
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
      'web_search', 'web_fetch',
      "task_brief", "replan_strategy",
      "list_directory",
      "read_file",
      "search_text",
      'find_files',
      "git_status",
      "git_diff",
      "inspect_office_file",
    ]),
    permissions: readPermissions({ web_search: 'allow', web_fetch: 'allow' }),
    maxRounds: null,
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
      'web_search', 'web_fetch',
      "task_brief", "replan_strategy",
      "list_directory",
      "read_file",
      "search_text",
      'find_files',
      "git_status",
      "git_diff",
      "inspect_office_file",
      "run_command",
      'verify_numeric_data',
    ]),
    permissions: readPermissions({ run_command: "ask", web_search: 'allow', web_fetch: 'allow' }),
    maxRounds: null,
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
      "task_brief", "replan_strategy",
      "list_directory",
      "read_file",
      "search_text",
      'find_files',
      "git_status",
      "git_diff",
      "inspect_office_file",
    ]),
    permissions: readPermissions(),
    maxRounds: null,
    background: true,
    triggers: Object.freeze(["task.completed"]),
    systemPrompt:
      "Store only reusable, evidence-backed project facts and never invent unsupported claims.",
  }),
  builder: Object.freeze({
    name: "builder",
    description:
      "Implement one delegated change inside an isolated worktree and explicit non-overlapping write scopes. Main/Verify owns command verification after integration.",
    tools: Object.freeze([
      "task_brief", "replan_strategy",
      "list_directory",
      "read_file",
      "search_text",
      'find_files',
      "git_status",
      "git_diff",
      "write_file",
      "delete_file",
      "apply_patch",
      "cleanup_temporary_check",
      "verify_project",
    ]),
    permissions: Object.freeze({
      "*": "deny",
      list_directory: "allow",
      read_file: "allow",
      search_text: "allow",
      find_files: 'allow',
      git_status: "allow",
      git_diff: "allow",
      write_file: "allow",
      delete_file: "ask",
      apply_patch: "allow",
      cleanup_temporary_check: "allow",
      verify_project: "allow",
      task_brief: "allow", replan_strategy: "allow",
    }),
    maxRounds: null,
    background: true,
    triggers: Object.freeze(["task.builder.ready"]),
    systemPrompt:
      "Implement and self-check within delegated write scopes. Use parent-authorized commands, browser checks and workflows as needed. A worktree is not OS isolation: normal backend approvals still apply. Do not recursively delegate or publish, broaden write scope or edit another worker's files. Report observed evidence accurately.",
  }),
});

const BUILTIN_AGENT_DEFINITIONS = Object.freeze(Object.fromEntries(Object.entries(ROLE_RESPONSIBILITIES).map(([name, definition]) => [name, Object.freeze({
  ...definition, tools: DELEGATED_NATIVE_TOOLS,
  permissions: Object.freeze({ '*': 'deny', ...Object.fromEntries(DELEGATED_NATIVE_TOOLS.map(tool => [tool, 'allow'])) }),
})])));

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
  return Object.freeze({
    name,
    extends: baseName || null,
    description: String(
      input?.description || base?.description || "",
    )
      .trim()
      .slice(0, 2_000),
    tools: Object.freeze(toStringArray(input?.tools, base?.tools || [])),
    permissions: normalizePermissions(
      input?.permissions,
      base?.permissions || {},
    ),
    model:
      String(input?.model || base?.model || "inherit").trim() || "inherit",
    maxRounds: null,
    background:
      typeof input?.background === "boolean"
        ? input.background
        : Boolean(base?.background),
    triggers: Object.freeze(
      toStringArray(input?.triggers, base?.triggers || []),
    ),
    systemPrompt: String(
      input?.systemPrompt ||
        input?.prompt ||
        base?.systemPrompt ||
        "",
    )
      .trim()
      .slice(0, 16_000),
    source: input?.source || "runtime",
  });
}

export class AgentDefinitionRegistry {
  #definitions = new Map();

  constructor({ includeBuiltins = true } = {}) {
    if (includeBuiltins) {
      for (const definition of Object.values(BUILTIN_AGENT_DEFINITIONS)) {
        this.#definitions.set(definition.name, definition);
      }
    }
  }

  register(input) {
    const definition = normalizeAgentDefinition(
      input,
      Object.fromEntries(this.#definitions),
    );
    this.#definitions.set(definition.name, definition);
    return definition;
  }

  get(name) {
    return this.#definitions.get(String(name || "")) || null;
  }

  has(name) {
    return this.#definitions.has(String(name || ""));
  }

  list() {
    return [...this.#definitions.values()];
  }

  resolve(name, overrides = {}) {
    const base = this.get(name);
    if (!base) return null;
    return normalizeAgentDefinition(
      { ...base, ...overrides, name: base.name },
      Object.fromEntries(this.#definitions),
    );
  }
}

export async function loadWorkspaceAgentDefinitions(
  workspaceRoot,
  {
    registry = new AgentDefinitionRegistry(),
    directory = ".aporiax/agents",
  } = {},
) {
  if (!workspaceRoot) return registry;
  const root = join(workspaceRoot, ...directory.split("/"));
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return registry;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
    const source = await readFile(join(root, entry.name), "utf8");
    const { metadata, body } = parseFrontmatter(source);
    registry.register({
      ...metadata,
      name: metadata.name || entry.name.replace(/\.md$/i, ""),
      systemPrompt: metadata.systemPrompt || metadata.prompt || body,
      source: `${directory}/${entry.name}`,
    });
  }
  return registry;
}

export function createAgentDefinitionRegistry(options) {
  return new AgentDefinitionRegistry(options);
}

export function builtinAgentDefinitions() {
  return Object.values(BUILTIN_AGENT_DEFINITIONS);
}

export { parseFrontmatter as parseAgentDefinitionFile };
