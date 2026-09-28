import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parsePatch } from "diff";

// This context is created only from a desktop-approved client grant. It is
// deliberately separate from model-authored arguments and project policies.
const storage = new AsyncLocalStorage();
const contexts = new WeakMap();
const NOOP = () => {};
const READ_TOOLS = new Set(["list_directory", "read_file", "search_text", "git_status", "git_diff", "git_log", "git_remote_list", "inspect_office_file"]);
const WRITE_TOOLS = new Set(["write_file", "apply_patch", "create_word_document", "create_presentation", "create_spreadsheet"]);
const COMMAND_TOOLS = new Set(["run_command", "start_process", "read_process", "wait_process", "write_stdin", "kill_process", "git_init", "git_stage", "git_commit", "git_create_branch", "git_remote_add", "git_pull", "git_push", "github_repo_create", "github_pr_create", "github_pr_view", "github_pr_checks", "github_auth_status", "lsp"]);
const BROWSER_TOOLS = new Set(["browser_open", "browser_snapshot", "browser_screenshot", "browser_console", "browser_network", "browser_close", "browser_click", "browser_fill", "browser_press"]);
export const LOCAL_CONTROL_SPECIAL_TOOLS = new Set(["request_user_input", "read_conversation_history", "finish_task", "finish_subagent", "task_brief", "replan_strategy", "delegate_subagent", "followup_subagent", "cancel_subagent", "collect_subagents", "review_subagent_result", "update_plan", "request_self_check", "complete_self_check", "remember_project_fact", "project_knowledge"]);
const DENIED_TOOLS = new Set(["read_external_file", "lsp_install", "read_skill_resource", "search_skills", "remember_project_fact", "project_knowledge"]);
const DEFAULT_LIMITS = Object.freeze({ maxModelCalls: 80, maxToolCalls: 400, maxParallelAgents: 2, maxSubagents: 12, maxDurationSeconds: 1800 });

function policyError(message, code = "LOCAL_CONTROL_FORBIDDEN") {
  return Object.assign(new Error(message), { code, retryable: false });
}

function boundedInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw policyError("Invalid external task limit.");
  return value;
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function dataFor(context = storage.getStore()) {
  return context ? contexts.get(context) : null;
}

export function currentLocalControlPolicy() {
  return storage.getStore() || null;
}

export function createLocalControlPolicy(options = {}) {
  if (!["read_only", "workspace_edit"].includes(options.permissionProfile)) throw policyError("An explicit external permission profile is required.");
  if (typeof options.workspaceRoot !== "string" || !isAbsolute(options.workspaceRoot)) throw policyError("An absolute external workspace is required.");
  const workspaceRoot = realpathSync(options.workspaceRoot);
  if (!statSync(workspaceRoot).isDirectory()) throw policyError("External workspace must be a directory.");
  const limits = Object.freeze(Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, fallback]) =>
    [key, boundedInteger(options.limits?.[key], fallback, key === "maxDurationSeconds" ? 86400 : key === "maxParallelAgents" ? 16 : 100000)])));
  const requestedDeadline = options.deadlineAt == null ? Date.now() + limits.maxDurationSeconds * 1000
    : typeof options.deadlineAt === "number" ? options.deadlineAt : Date.parse(options.deadlineAt);
  if (!Number.isFinite(requestedDeadline)) throw policyError("Invalid external task deadline.");
  const deadlineAt = Math.min(requestedDeadline, Date.now() + limits.maxDurationSeconds * 1000);
  const list = value => Object.freeze([...new Set((Array.isArray(value) ? value : []).filter(item => typeof item === "string" && item))]);
  const context = Object.freeze({
    clientId: String(options.clientId || ""), runId: String(options.runId || ""), workspaceRoot,
    permissionProfile: options.permissionProfile,
    capabilities: Object.freeze(Object.fromEntries(["commands", "browser", "mcp"].map(key => [key, options.capabilities?.[key] === true]))),
    allowedMcpServerIds: list(options.allowedMcpServerIds), allowedProviderIds: list(options.allowedProviderIds), allowedModelIds: list(options.allowedModelIds),
    limits, deadlineAt,
  });
  contexts.set(context, { context, workspaceRoot, state: {
    modelCalls: boundedInteger(options.usage?.modelCalls, 0, 100000),
    toolCalls: boundedInteger(options.usage?.toolCalls, 0, 100000),
    totalAgents: boundedInteger(options.usage?.totalAgents, 0, 100000), activeAgents: 0,
    seenAgents: new Set(Array.isArray(options.usage?.agentIds) ? options.usage.agentIds : []),
    failure: null,
    onUsage: typeof options.onUsage === "function" ? options.onUsage : null,
  } });
  return context;
}

export function withLocalControlPolicy(context, callback) {
  if (!context) return callback();
  if (!contexts.has(context)) throw policyError("External policy must be created from an approved grant.");
  return storage.run(context, callback);
}

// Only the trusted Builder workspace manager calls this after creating an
// isolated worktree. The child gets its own file root, never a new budget.
export function withLocalControlWorkspace(workspaceRoot, callback) {
  const parent = dataFor();
  if (!parent) return callback();
  assertLocalControlActive();
  if (parent.context.permissionProfile !== "workspace_edit") throw policyError("Read-only tasks cannot create Builder workspaces.");
  const canonical = realpathSync(workspaceRoot);
  if (!statSync(canonical).isDirectory()) throw policyError("Builder workspace must be a directory.");
  const context = Object.freeze({ ...parent.context, workspaceRoot: canonical });
  contexts.set(context, { ...parent, context, workspaceRoot: canonical });
  return storage.run(context, callback);
}

export function localControlPolicySnapshot(context = storage.getStore()) {
  const data = dataFor(context);
  if (!data) return null;
  return { modelCalls: data.state.modelCalls, toolCalls: data.state.toolCalls,
    activeAgents: data.state.activeAgents, totalAgents: data.state.totalAgents,
    agentIds: [...data.state.seenAgents], deadlineAt: data.context.deadlineAt, limits: { ...data.context.limits },
    ...(data.state.failure ? { stopped: data.state.failure.code } : {}) };
}

function changed(data) {
  // A failed persistence callback must stop execution before the next side
  // effect. Callers supply a synchronous checkpoint enqueue, never a prompt.
  try { data.state.onUsage?.(localControlPolicySnapshot(data.context)); }
  catch (error) {
    data.state.failure = Object.assign(new Error("External task budget checkpoint failed; execution stopped."), { code: "LOCAL_CONTROL_PERSISTENCE_FAILED", retryable: false, cause: error });
    throw data.state.failure;
  }
}

export function assertLocalControlActive() {
  const data = dataFor();
  if (!data) return;
  if (data.state.failure) throw data.state.failure;
  if (Date.now() >= data.context.deadlineAt) {
    data.state.failure = policyError("External task deadline reached; saved work is retained.", "LOCAL_CONTROL_DEADLINE_EXCEEDED");
    throw data.state.failure;
  }
}

function consume(counter, limit, description) {
  const data = dataFor();
  if (!data) return;
  assertLocalControlActive();
  if (data.state[counter] >= data.context.limits[limit]) {
    data.state.failure = policyError(`External task ${description} limit reached; saved work is retained.`, "LOCAL_CONTROL_BUDGET_EXCEEDED");
    throw data.state.failure;
  }
  data.state[counter] += 1;
  changed(data);
}

export function consumeLocalControlToolCall() {
  consume("toolCalls", "maxToolCalls", "tool call");
}

export function consumeLocalControlModelCall({ provider, body } = {}) {
  const data = dataFor();
  if (!data) return;
  assertLocalControlActive();
  if (data.context.allowedProviderIds.length && !data.context.allowedProviderIds.includes(provider?.id)) throw policyError("Provider is outside this client's grant.");
  if (data.context.allowedModelIds.length && !data.context.allowedModelIds.includes(body?.model)) throw policyError("Model is outside this client's grant.");
  consume("modelCalls", "maxModelCalls", "model request");
}

export function acquireLocalControlWorker({ agentId, role } = {}) {
  const data = dataFor();
  if (!data) return NOOP;
  assertLocalControlActive();
  if (role === "builder" && data.context.permissionProfile !== "workspace_edit") throw policyError("Read-only external tasks cannot delegate a Builder.");
  if (role === "curator") throw policyError("External tasks cannot curate global project knowledge.");
  if (data.state.activeAgents >= data.context.limits.maxParallelAgents) throw policyError("External task concurrent agent limit reached. Collect an existing worker before starting another.", "LOCAL_CONTROL_CONCURRENCY_LIMIT");
  const id = String(agentId || "");
  if (!id || !data.state.seenAgents.has(id)) {
    consume("totalAgents", "maxSubagents", "subagent");
    if (id) data.state.seenAgents.add(id);
  }
  data.state.activeAgents += 1;
  changed(data);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    data.state.activeAgents -= 1;
    changed(data);
  };
}

export async function withLocalControlWorker(options, callback) {
  const release = acquireLocalControlWorker(options);
  try { return await callback(); } finally { release(); }
}

function requireCapability(data, capability) {
  if (data.context.permissionProfile !== "workspace_edit" || !data.context.capabilities[capability]) throw policyError(`External task ${capability} capability was not granted.`);
}

function checkTool(data, toolName, input = {}) {
  if (DENIED_TOOLS.has(toolName)) throw policyError(`Tool is unavailable to external tasks: ${toolName}`);
  if (WRITE_TOOLS.has(toolName)) {
    if (data.context.permissionProfile !== "workspace_edit") throw policyError(`External task is read-only: ${toolName}`);
  } else if (COMMAND_TOOLS.has(toolName)) requireCapability(data, "commands");
  else if (BROWSER_TOOLS.has(toolName)) requireCapability(data, "browser");
  else if (toolName === "present_to_user") {
    if (input.url || input.show_browser) requireCapability(data, "browser");
    if (input.process_id) requireCapability(data, "commands");
  } else if (!READ_TOOLS.has(toolName) && !LOCAL_CONTROL_SPECIAL_TOOLS.has(toolName)) throw policyError(`Tool is outside the external API allowlist: ${toolName}`);
  if (toolName === "delegate_subagent" && input.role === "builder" && data.context.permissionProfile !== "workspace_edit") throw policyError("Read-only external tasks cannot delegate a Builder.");
  if (toolName === "delegate_subagent" && input.role === "curator") throw policyError("External tasks cannot curate global project knowledge.");
  if (toolName === "delegate_subagent" && (!data.context.limits.maxSubagents || !data.context.limits.maxParallelAgents)) throw policyError("External task delegation is disabled by its grant.");
  if (toolName === "request_self_check" && input.action !== "suggest" && input.action !== "skip" && input.verification?.length) requireCapability(data, "commands");
}

export function isLocalControlToolAvailable(toolName) {
  const data = dataFor();
  if (!data) return true;
  try { checkTool(data, String(toolName)); return true; } catch { return false; }
}

export function localControlToolRequiresApproval(toolName) {
  const data = dataFor();
  // Command/LSP/remote Git and browser authority is wider than workspace file
  // edits. A model cannot elevate it with project policy or automatic mode.
  return Boolean(data && COMMAND_TOOLS.has(toolName) && !["read_process", "wait_process", "github_pr_view", "github_pr_checks", "github_auth_status"].includes(toolName));
}

async function verifyPath(data, value, { writable = false } = {}) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw policyError("Invalid external task path.");
  // Treat both separator spellings as paths on every platform, and reject
  // Win32 device names / alternate data streams before filesystem access.
  const normalized = value.replaceAll("\\", "/");
  const withoutDrive = process.platform === "win32" ? normalized.replace(/^[A-Za-z]:\//, "/") : normalized;
  if (withoutDrive.includes(":") || normalized.startsWith("//")) throw policyError("Device paths and alternate data streams are unavailable.");
  const target = resolve(data.workspaceRoot, normalized);
  if (!inside(data.workspaceRoot, target)) throw policyError("Path is outside the external task workspace.");
  if (writable && relative(data.workspaceRoot, target).split(sep).some(part => [".git", ".aporiax"].includes(part.toLowerCase()))) throw policyError("External file tools cannot modify workspace control metadata.");
  let existing = target;
  while (true) {
    try {
      const canonical = await realpath(existing);
      if (!inside(data.workspaceRoot, canonical)) throw policyError("Resolved path escapes the external task workspace.");
      return;
    } catch (error) {
      if (error.code !== "ENOENT" || existing === data.workspaceRoot) throw error;
      existing = dirname(existing);
    }
  }
}

export async function assertLocalControlTool({ toolName, input = {}, workspaceRoot, count = true } = {}) {
  const data = dataFor();
  if (!data) return;
  assertLocalControlActive();
  if (count) consumeLocalControlToolCall();
  checkTool(data, String(toolName), input);
  if (workspaceRoot && await realpath(workspaceRoot) !== data.workspaceRoot) throw policyError("Tool execution workspace does not match the external task grant.");
  if (input.path !== undefined) await verifyPath(data, input.path, { writable: WRITE_TOOLS.has(toolName) });
  if (input.cwd !== undefined) await verifyPath(data, input.cwd);
  for (const key of ["files", "paths", "scope", "write_scopes", "writeScopes", "focus"]) {
    for (const value of Array.isArray(input[key]) ? input[key] : []) await verifyPath(data, value, { writable: key.startsWith("write") || toolName === "git_stage" });
  }
  if (toolName === "create_word_document") {
    for (const block of input.blocks || []) if (block?.type === "image") await verifyPath(data, block.path);
  }
  if (toolName === "apply_patch" && typeof input.patch === "string" && input.patch.trim()) {
    for (const patch of parsePatch(input.patch)) {
      const file = patch.newFileName && patch.newFileName !== "/dev/null" ? patch.newFileName : patch.oldFileName;
      await verifyPath(data, String(file || "").replace(/^[ab][\\/]/, ""), { writable: true });
    }
  }
  if (toolName === "request_self_check") for (const candidate of input.verification || []) await verifyPath(data, candidate.cwd || ".");
  assertLocalControlActive();
}

function isLoopback(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || hostname === "0.0.0.0" || /^127\./.test(hostname) || hostname.startsWith("::ffff:127.") || /^::ffff:7f[0-9a-f]{2}:/.test(hostname);
  } catch { return false; }
}

export function assertLocalControlMcp({ server, toolName = "", operation = "call", serverVersion, count = false } = {}) {
  const data = dataFor();
  if (!data) return;
  assertLocalControlActive();
  if (count) consumeLocalControlToolCall();
  requireCapability(data, "mcp");
  if (server && !data.context.allowedMcpServerIds.includes(server.id)) throw policyError("MCP server is outside this client's explicit grant.");
  // Discovery is also gated: stdio initialization starts an external process.
  // Block our own adapter/identity, known control tools, and loopback HTTP
  // before any connection/tool invocation, even with an MCP capability grant.
  const identity = [server?.id, server?.name, server?.command, ...(server?.args || []), serverVersion?.name].filter(Boolean).join(" ");
  if (/aporiax|aporia[-_ ]?mcp/i.test(identity) || /^(?:aporiax|aporia)[_.-]/i.test(toolName) || isLoopback(server?.url)) throw policyError("Nested AporiaX control and loopback MCP are unavailable to external tasks.");
  if (!["connect", "refresh", "call", "resource", "prompt", "catalog"].includes(operation)) throw policyError("Unknown MCP control operation.");
}

export function localControlGitOptions(args = []) {
  if (!dataFor()) return { args };
  assertLocalControlActive();
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_(?:CONFIG|DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|EXTERNAL_DIFF|SSH|SSH_COMMAND)/i.test(key)) delete env[key];
  const nullFile = process.platform === "win32" ? "NUL" : "/dev/null";
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: nullFile, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });
  const command = args[0] === "diff" ? [args[0], "--no-textconv", ...args.slice(1)] : args;
  return { args: ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${nullFile}`, "-c", "core.pager=cat", ...command], env };
}
