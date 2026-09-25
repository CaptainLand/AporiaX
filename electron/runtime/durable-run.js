import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

const storage = new AsyncLocalStorage();
export const withDurableRun = (context, fn) => storage.run(context, fn);
export const runtimeRequestTrace = () => storage.getStore()?.requestTrace || {};
export const runtimeRunControl = () => storage.getStore()?.control || null;
// Shared by async child workers, never by unrelated runs or accounts.
export function runtimeRunState(key, initialize) {
  const context = storage.getStore();
  if (!context) return null;
  context.runState ||= new Map();
  if (!context.runState.has(key)) context.runState.set(key, initialize());
  return context.runState.get(key);
}
export function runtimeRecoveryCheckpoint(scopeId) {
  const checkpoints = storage.getStore()?.requestCheckpoints;
  const value = checkpoints?.[scopeId];
  if (checkpoints) delete checkpoints[scopeId]; // Restore once; new loop requests need new identities.
  return value;
}
export const runtimeRecoveryContext = (scopeId) => storage.getStore()?.recoveryContexts?.[scopeId];
export async function waitForRuntimeResume(signal = storage.getStore()?.signal) {
  await runtimeRunControl()?.waitIfPaused(signal);
}
export const runtimeRecoveryDirectory = () => storage.getStore()?.recoveryDirectory || null;
export const runtimeEvidenceStore = () => storage.getStore()?.evidenceStore || null;
export async function saveRuntimeCheckpoint(checkpoint) {
  await storage.getStore()?.checkpoint?.(checkpoint);
}
export async function saveRuntimeContext(scopeId, state) {
  const context = storage.getStore();
  if (!context?.context) return;
  const snapshot = JSON.stringify(state);
  const previous = context.contextGate || Promise.resolve();
  context.contextGate = previous.then(() => context.context(scopeId, snapshot));
  await context.contextGate;
}
// Unknown tools, MCP calls and process tools are conservatively effectful.
const READ_ONLY = new Set(["read_skill_resource", "read_file", "read_external_file", "list_directory", "search_text", "git_status", "git_diff", "inspect_office_file", "browser_snapshot", "browser_screenshot", "read_process", "wait_process", "present_to_user", "read_conversation_history", "mcp_search_tools", "mcp_read_result", "task_brief", "replan_strategy"]);
export const isReadOnlyNativeTool = (name) => READ_ONLY.has(name);
function stableInput(value) {
  if (Array.isArray(value)) return value.map(stableInput);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableInput(value[key])]));
  return value;
}
// Navigation/closing can be retried without replaying a purchase, publish or
// file mutation. They remain journaled and keep normal tool permissions.
const REPLAY_SAFE = new Set(["browser_open", "browser_close"]);
export const isReplaySafeNativeTool = (name) => REPLAY_SAFE.has(name);
const FILE_MUTATIONS = new Set(["write_file", "apply_patch", "delete_file", "create_directory"]);
function sameTarget(previous, tool, input, context, scope) {
  if ((previous.scope || null) !== (scope || null)) return false;
  if (!FILE_MUTATIONS.has(previous.tool) || !FILE_MUTATIONS.has(tool) || !previous.target || !input?.path) return false;
  const normalize = (path, cwd) => {
    const value = resolve(context.workspacePath || process.cwd(), cwd || ".", path);
    return process.platform === "win32" ? value.toLowerCase() : value;
  };
  return normalize(previous.target, previous.cwd) === normalize(input.path, input.cwd);
}
function abortIfNeeded(context) {
  if (context.signal?.aborted) throw Object.assign(new Error("The run was interrupted."), { name: "AbortError" });
}
async function reconcile(context, tool, input, fingerprint, requestApproval, scope) {
  if (REPLAY_SAFE.has(tool)) return;
  const getMatches = async () => {
    const pending = (context.unresolved || []).filter((op) => !REPLAY_SAFE.has(op.tool) && (
      op.fingerprint === fingerprint || sameTarget(op, tool, input, context, scope) ||
      (!op.fingerprint && op.tool === tool && (op.scope || null) === (scope || null)) || op.tool === "legacy-run"
    ));
    const duplicate = context.findConfirmed
      ? await context.findConfirmed(fingerprint)
      : context.confirmed?.find((op) => op.fingerprint === fingerprint);
    return [...new Map([...pending, ...(duplicate ? [duplicate] : [])].map((op) => [op.operationId || op.fingerprint || op.tool, op])).values()];
  };
  // An unrelated agent must not wait behind somebody else's approval dialog.
  if (!(await getMatches()).length) return;
  // All agents share this gate, but tool execution itself remains concurrent.
  const previousGate = context.reconciliationGate || Promise.resolve();
  let release;
  context.reconciliationGate = new Promise((done) => { release = done; });
  await previousGate;
  try {
    abortIfNeeded(context);
    // Only operations from prior runs qualify as confirmed replays. Successful
    // operations from this run must not turn every repeated action into a prompt.
    const matches = await getMatches();
    if (!matches.length) return;
    const key = matches.map((op) => op.operationId || op.fingerprint || op.tool).sort().join("|");
    if (context.deniedReconciliations?.has(key)) throw new Error("RECOVERY_RECONCILIATION_REQUIRED: previous reconciliation was denied; inspect the outcome instead of retrying.");
    const approval = await requestApproval?.({
      kind: "recovery-reconciliation", tool, input, canRememberForRun: false,
      title: "恢复任务：核对此次操作的历史结果",
      reason: "仅核对与当前操作相关的历史记录。批准后保存核对结果，不会因同一条旧记录反复询问；不代表上次操作失败或已成功。",
      command: input?.command || input?.path || tool, cwd: input?.cwd || ".", unresolved: matches,
    });
    if (!approval?.approved) {
      (context.deniedReconciliations ||= new Set()).add(key);
      throw new Error("RECOVERY_RECONCILIATION_REQUIRED: inspect previous effects before continuing.");
    }
    abortIfNeeded(context);
    // Acknowledgement is NOT a successful operation receipt. Commit it before
    // continuing so a restart cannot resurrect the same warning.
    for (const op of matches) {
      await context.operation({ ...op, operationId: op.operationId || randomUUID(),
        recoveredFrom: op.recoveredFrom || op.operationId || "legacy-reconciliation",
        state: "reconciled", resolution: "user-acknowledged", reconciledAt: new Date().toISOString() });
    }
    context.unresolved = (context.unresolved || []).filter((op) => !matches.includes(op));
    context.confirmed = (context.confirmed || []).filter((op) => !matches.includes(op));
  } finally { release(); }
}
export async function executeDurableTool(tool, input, execute, requestApproval, { scope = null } = {}) {
  const context = storage.getStore();
  await context?.control?.waitIfPaused(context.signal);
  if (!context || READ_ONLY.has(tool)) return execute();
  const operationId = randomUUID();
  const fingerprint = createHash("sha256").update(JSON.stringify(scope ? [tool, stableInput(input), scope] : [tool, stableInput(input)])).digest("hex");
  await reconcile(context, tool, input, fingerprint, requestApproval, scope);
  abortIfNeeded(context);
  const target = typeof input?.path === "string" ? input.path : undefined;
  const intent = { operationId, tool, target, cwd: input?.cwd || ".", ...(scope ? { scope } : {}), fingerprint, state: "started" };
  await context.operation(intent);
  try { await context.control?.waitIfPaused(context.signal); }
  catch (error) {
    if (error?.name === "AbortError") await context.operation({ ...intent, state: "cancelled", resolution: "aborted-before-execution" });
    throw error;
  }
  if (context.signal?.aborted) {
    await context.operation({ ...intent, state: "cancelled", resolution: "aborted-before-execution" });
    abortIfNeeded(context);
  }
  let result;
  try { result = await execute(); }
  catch (error) {
    // An exception does not prove an external side effect did not happen.
    const uncertain = { ...intent, state: REPLAY_SAFE.has(tool) ? "failed" : "uncertain", error: String(error?.message || error).slice(0, 800) };
    await context.operation(uncertain);
    if (uncertain.state === "uncertain") (context.unresolved ||= []).push(uncertain);
    throw error;
  }
  const value = result?.modelResult ?? result;
  const receipt = { ...intent,
    state: value?.error || value?.timedOut ? (REPLAY_SAFE.has(tool) ? "failed" : "uncertain") : "confirmed",
    outcome: { path: value?.path, exitCode: value?.exitCode, error: value?.error, sha256: value?.sha256,
      processId: value?.processId, sessionId: value?.sessionId,
      summary: String(value?.summary || value?.message || value?.stdout || "").slice(0, 1000) },
  };
  await context.operation(receipt);
  if (receipt.state === "uncertain") (context.unresolved ||= []).push(receipt);
  return result;
}
