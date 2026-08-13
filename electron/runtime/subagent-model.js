import { getToolPermission } from "../agent-core.js";

export const DEFAULT_SUBAGENT_ROUNDS = 8;
export const MAX_SUBAGENT_ROUNDS = 20;
export const MAX_SUBAGENT_TASK_CHARS = 4_000;
export const MAX_SUBAGENT_RESULT_CHARS = 24_000;
const MAX_SUBAGENT_EVIDENCE_CHARS = 24_000;

const LOW_COMPUTE_ROLES = new Set(["explore", "verify", "curator"]);

export function resolveSubagentReasoningPolicy({
  role,
  thinking = false,
  effort = "high",
} = {}) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (LOW_COMPUTE_ROLES.has(normalizedRole)) {
    return {
      thinking: false,
      effort: "low",
      source: "role-default",
    };
  }
  return {
    thinking: Boolean(thinking),
    effort: String(effort || "high"),
    source: "parent",
  };
}

export const SUBAGENT_ROLE_CONFIG = Object.freeze({
  explore: Object.freeze({
    description:
      "Search and understand the codebase. Return concise findings with exact file and line evidence. Do not edit files.",
    tools: new Set([
      "list_directory",
      "read_file",
      "search_text",
      "git_status",
      "git_diff",
      "inspect_office_file",
    ]),
  }),
  review: Object.freeze({
    description:
      "Review existing code or artifacts for correctness, security, completeness, maintainability, and regressions. Report actionable findings with evidence. Do not edit files.",
    tools: new Set([
      "list_directory",
      "read_file",
      "search_text",
      "git_status",
      "git_diff",
      "inspect_office_file",
    ]),
  }),
  verify: Object.freeze({
    description:
      "Verify a focused claim using repository inspection and relevant project commands. Do not edit source files. Report the exact command, exit code, evidence, and remaining uncertainty.",
    tools: new Set([
      "list_directory",
      "read_file",
      "search_text",
      "git_status",
      "git_diff",
      "inspect_office_file",
      "run_command",
    ]),
  }),
  curator: Object.freeze({
    description:
      "Extract durable, reusable project understanding from verified task changes. Read the supporting files and return only the requested JSON proposal. Do not edit files or invent unsupported facts.",
    tools: new Set([
      "list_directory",
      "read_file",
      "search_text",
      "git_status",
      "git_diff",
      "inspect_office_file",
    ]),
  }),
});

export function normalizeWorkspaceScope(values) {
  const input = Array.isArray(values) && values.length ? values : ["."];
  const normalized = [];
  for (const item of input.slice(0, 12)) {
    const value =
      String(item || ".")
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .replace(/\/{2,}/g, "/")
        .replace(/\/$/, "") || ".";
    if (
      value.startsWith("/") ||
      /^[a-zA-Z]:\//.test(value) ||
      value.split("/").includes("..") ||
      value.includes("\0")
    ) {
      throw new Error("Subagent scope must stay inside the workspace.");
    }
    if (!normalized.includes(value)) normalized.push(value);
  }
  return normalized.length ? normalized : ["."];
}

export function normalizeSubagentInput(input) {
  const role = String(input?.role || "").trim();
  if (!SUBAGENT_ROLE_CONFIG[role]) {
    throw new Error("Subagent role must be explore, review, verify, or curator.");
  }
  const task = String(input?.task || "").trim();
  if (!task || task.length > MAX_SUBAGENT_TASK_CHARS) {
    throw new Error(
      `Subagent task must be between 1 and ${MAX_SUBAGENT_TASK_CHARS} characters.`,
    );
  }
  const requestedRounds = Number(input?.max_rounds);
  const maxRounds = Number.isInteger(requestedRounds)
    ? Math.min(MAX_SUBAGENT_ROUNDS, Math.max(2, requestedRounds))
    : DEFAULT_SUBAGENT_ROUNDS;
  return {
    role,
    task,
    scope: normalizeWorkspaceScope(input?.scope),
    background: Boolean(input?.background),
    maxRounds,
  };
}

export function subagentToolPaths(toolName, input = {}) {
  if (toolName === "run_command") return [input.cwd || "."];
  if (toolName === "git_diff") return input.path ? [input.path] : ["."];
  if (
    [
      "list_directory",
      "read_file",
      "search_text",
      "inspect_office_file",
    ].includes(toolName)
  ) {
    return [input.path || "."];
  }
  return ["."];
}

export function pathIsInsideScope(path, scope = []) {
  const normalized =
    String(path || ".")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/$/, "") || ".";
  return scope.some(
    (allowed) =>
      allowed === "." ||
      normalized === allowed ||
      normalized.startsWith(`${allowed}/`),
  );
}

export function assertSubagentScope(toolName, input, scope) {
  if (toolName === "run_command" && !scope.includes(".")) {
    throw new Error(
      'run_command requires repository-wide scope (".") because an arbitrary command cannot be reliably confined to a narrower path scope.',
    );
  }
  if (
    (toolName === "git_status" && scope.includes(".")) ||
    (toolName === "git_diff" && !input.path && scope.includes("."))
  ) {
    return;
  }
  if (toolName === "git_status") {
    throw new Error(
      'git_status requires repository-wide scope (".") because it exposes the whole workspace.',
    );
  }
  for (const path of subagentToolPaths(toolName, input)) {
    if (!pathIsInsideScope(path, scope)) {
      throw new Error(`Subagent path is outside its delegated scope: ${path}`);
    }
  }
}

export function createSubagentPermissionPolicy(parentPolicy, role) {
  const allowed = SUBAGENT_ROLE_CONFIG[role]?.tools;
  if (!allowed) throw new Error(`Unknown subagent role: ${role}`);
  const policy = { "*": "deny" };
  for (const toolName of allowed) {
    policy[toolName] = getToolPermission(parentPolicy, toolName);
  }
  return Object.freeze(policy);
}

export function compactSubagentModelResult(modelResult) {
  const result =
    modelResult && typeof modelResult === "object"
      ? { ...modelResult }
      : { value: modelResult };
  if (typeof result.content === "string" && result.content.length > 16_000) {
    result.content = `${result.content.slice(0, 16_000)}\n[truncated]`;
    result.truncated = true;
  }
  if (typeof result.diff === "string" && result.diff.length > 16_000) {
    result.diff = `${result.diff.slice(0, 16_000)}\n[truncated]`;
    result.truncated = true;
  }
  if (typeof result.stdout === "string" && result.stdout.length > 12_000) {
    result.stdout = `${result.stdout.slice(0, 12_000)}\n[truncated]`;
    result.truncated = true;
  }
  if (typeof result.stderr === "string" && result.stderr.length > 8_000) {
    result.stderr = `${result.stderr.slice(0, 8_000)}\n[truncated]`;
    result.truncated = true;
  }
  return result;
}

export function subagentEvidence(toolName, result) {
  const value = compactSubagentModelResult(result);
  return {
    tool: toolName,
    path: value.path || null,
    command: value.command || null,
    cwd: value.cwd || null,
    query: value.query || null,
    exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
    error: value.error ? String(value.error).slice(0, 500) : null,
    preview: String(
      value.content ||
        value.diff ||
        value.stdout ||
        value.reason ||
        "",
    )
      .replace(/\s+/g, " ")
      .slice(0, 1_200),
  };
}

export function compactSubagentEvidence(items) {
  const output = [];
  let characters = 0;
  for (const item of (items || []).slice(-40).reverse()) {
    const compact = {
      ...item,
      preview: String(item?.preview || "").slice(0, 800),
    };
    const size = JSON.stringify(compact).length;
    if (output.length && characters + size > MAX_SUBAGENT_EVIDENCE_CHARS) {
      break;
    }
    output.unshift(compact);
    characters += size;
  }
  return output;
}

export function subagentToolsAreParallel(toolCalls) {
  return (
    toolCalls.length > 1 &&
    toolCalls.every((call) =>
      [
        "list_directory",
        "read_file",
        "search_text",
        "git_status",
        "git_diff",
        "inspect_office_file",
      ].includes(call?.function?.name),
    )
  );
}
