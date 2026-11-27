import { lstat } from 'node:fs/promises';
import { getToolPermission } from "../agent-core.js";
import { executeDurableTool, markToolPreflightFailure, waitForRuntimeResume } from "./durable-run.js";
import { tryReadExternalDirectory } from "./external-read.js";
import { requireToolResult } from "./task-conversation.js";
import { projectScriptFingerprint } from "./project-script-trust.js";
import { assertLocalControlTool, currentLocalControlPolicy, localControlToolRequiresApproval } from "../control/policy.js";
import { assertNativeFileTool, nativeFilePath, nativeToolWritesOutsideWorkspace, verifyExternalFileTarget, verifyNativeFileTarget, withNativeFileScope, withWorkspaceOnlyFileAccess } from "./file-access-policy.js";
import { prepareFileDeletion } from './workspace-mutations.js';
import { verificationCommand } from './isolated-verification.js';
import { requestsBrowserPresentation } from '../workbench/preview-path.js';
import { fileDeletionGrant } from './approval-grants.js';
import { APPROVE_ALL_MODE } from '../../shared/approval-modes.js';
import { currentExecutionMode } from '../harness/agent-budget.js';
import { approvalSkippedError, approveAllNativeBlockReason, AUTOMATIC_PREVIEW_TOOLS, isHandsFreeApproval, nativeBackendBlockReason, NATIVE_APPROVAL_PROOF, SEPARATE_NATIVE_APPROVAL } from './approve-all-policy.js';
import { parseWorkspaceArchiveCommand } from './workspace-archive.js';
import { hasShellComposition } from './execution-policy.js';
import {
  buildToolApprovalRequest,
  resolveToolExecutionPermission,
} from "./tool-permissions.js";

function abortError() {
  const error = new Error("The run was interrupted.");
  error.name = "AbortError";
  return error;
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError();
}

/**
 * Authoritative boundary for native AporiaX tool authorization.
 *
 * The Agent loop supplies an already-registered tool and an implementation
 * callback. This module owns argument parsing, permission projection, approval,
 * and the handoff into the actual executor. The executor therefore never needs
 * to repeat permission logic.
 */
export function dispatchNativeTool(options = {}) {
  const dispatch = () => dispatchTool(options);
  return options.approvalMode === APPROVE_ALL_MODE ? withWorkspaceOnlyFileAccess(dispatch) : dispatch();
}

async function dispatchTool({
  toolCall,
  registry,
  permissionPolicy,
  approvalMode = "manual",
  requestApproval,
  sandboxStatus = null,
  executionMode = null,
  signal,
  parseArguments,
  executeAuthorized,
  executeContext = {},
} = {}) {
  assertNotAborted(signal);
  await waitForRuntimeResume(signal);
  const toolName = String(toolCall?.function?.name || "");
  const descriptor = registry?.get?.(toolName) || null;
  if (!descriptor) throw new Error(`Unsupported tool: ${toolName || "unknown"}`);
  if (typeof parseArguments !== "function") {
    throw new Error("Tool dispatcher requires an argument parser.");
  }
  if (typeof executeAuthorized !== "function") {
    throw new Error("Tool dispatcher requires an authorized executor.");
  }

  const input = parseArguments(toolCall);
  if (toolName === 'install_workspace_skill' && typeof executeContext.skillInstaller !== 'function') throw Error('技能安装仅限当前桌面主 Agent。');
  if (["list_aporiax_themes", "create_aporiax_theme"].includes(toolName) && typeof executeContext.appearanceTools !== 'function') throw new Error('外观工具仅限当前桌面主 Agent。');
  if (["list_agent_roles", "manage_agent_role"].includes(toolName) && typeof executeContext.roleTools !== 'function') throw new Error('角色管理仅限当前桌面主 Agent。');
  await assertLocalControlTool({ toolName, input, workspaceRoot: executeContext.workspaceRoot });
  await assertNativeFileTool({ toolName, input, workspaceRoot: executeContext.workspaceRoot });
  const configuredPermission = getToolPermission(permissionPolicy, toolName);
  const browserPresentation = toolName === 'present_to_user' && requestsBrowserPresentation(input);
  const browserPermission = browserPresentation ? getToolPermission(permissionPolicy, 'browser_open') : null;
  const browserPresentationAllowed = executeContext.browserPresentationAllowed !== false && browserPermission !== 'deny';
  const permissionAction = configuredPermission !== "deny" && (localControlToolRequiresApproval(toolName) ||
    (browserPresentationAllowed && browserPermission === 'ask')) ? "ask" : configuredPermission;
  const decision = resolveToolExecutionPermission({
    toolName,
    permissionAction,
    approvalMode,
    sandboxStatus,
    executionMode: executionMode || currentExecutionMode(),
    input,
  });
  if (decision.denied) {
    throw new Error(`Permission denied for tool: ${toolName}`);
  }
  const handsFree = isHandsFreeApproval(approvalMode);
  const backendBlock = nativeBackendBlockReason(toolName, decision.backend);
  if (backendBlock && (handsFree || decision.backend.osIsolation)) {
    if (approvalMode === APPROVE_ALL_MODE) throw approvalSkippedError(backendBlock);
    throw Object.assign(new Error(backendBlock), { code: 'EXECUTION_PROFILE_UNAVAILABLE', retryable: false });
  }
  const workspaceArchive = handsFree && toolName === 'run_command' && !decision.backend.osIsolation
    ? parseWorkspaceArchiveCommand(input.command) : null;
  const previewAction = handsFree && AUTOMATIC_PREVIEW_TOOLS.has(toolName) && executeContext.browserPresentationAllowed !== false
    ? executeContext.browserRuntime?.bindAutomaticPreviewAction?.(toolName) : null;
  const automaticPreviewAction = typeof previewAction === 'function' ? previewAction : null;
  let workspaceScript = null;
  if (handsFree && ['run_command', 'start_process'].includes(toolName) && !decision.backend.osIsolation && typeof input.command === 'string' && !hasShellComposition(input.command)) {
    const match = /^\s*(node|python(?:3)?)(?:\.exe)?\s+(?:"([^"$]+)"|'([^'$]+)'|([\p{L}\p{M}\p{N}_.\-/\\]+))(?:\s|$)/iu.exec(input.command);
    const script = match && (match[2] || (process.platform !== 'win32' && match[3]) || match[4]);
    const extension = match && (/^node$/i.test(match[1]) ? /\.(?:mjs|cjs|js)$/i : /\.py$/i);
    if (script && extension.test(script) && !/^[-/\\]|:/.test(script)) {
      workspaceScript = { path: script, cwd: input.cwd || '.' };
      await verifyWorkspaceScript();
    }
  }
  async function verifyWorkspaceScript() {
    if (!workspaceScript) return;
    await withWorkspaceOnlyFileAccess(async () => {
      const root = executeContext.workspaceRoot;
      const cwd = await verifyNativeFileTarget(root, workspaceScript.cwd);
      const target = await verifyNativeFileTarget(root, nativeFilePath(cwd, workspaceScript.path));
      if (!(await lstat(target)).isFile()) throw new Error('Expected a regular workspace script entry file.');
    });
  }
  const separateReason = handsFree
    ? (nativeToolWritesOutsideWorkspace(toolName, input, executeContext.workspaceRoot) && 'Writing outside the workspace requires separate authorization.') ||
      approveAllNativeBlockReason(toolName, input, decision, { workspaceArchive, automaticPreviewAction, workspaceScript }) : '';
  if (approvalMode === APPROVE_ALL_MODE && separateReason) throw approvalSkippedError(separateReason);
  let deletionGrant = null;
  let rememberedDeletion = false;
  const deletionScope = version => fileDeletionGrant(executeContext.workspaceRoot, version,
    nativeFilePath(executeContext.workspaceRoot, input.path), executeContext.durableScope || 'main');
  if (toolName === 'delete_file') {
    const version = await prepareFileDeletion(executeContext.workspaceRoot, input, { signal });
    input.expected_sha256 = version.sha256;
    if (decision.requiresApproval && !currentLocalControlPolicy()) deletionGrant = await deletionScope(version).catch(() => null);
  }

  // Role changes have their own mandatory, revision-bound approval containing
  // the full diff. Never replace it with a generic/rememberable tool grant.
  if ((decision.requiresApproval || separateReason) && !['manage_agent_role', 'install_workspace_skill'].includes(toolName)) {
    if (typeof requestApproval !== "function") {
      throw new Error(`Tool ${toolName} requires approval.`);
    }
    const projectTrust = decision.commandPolicy?.category === "project-script" &&
      ["smart-auto", "sandbox-auto"].includes(approvalMode) && !decision.backend.osIsolation && permissionAction !== "ask"
      ? await projectScriptFingerprint(executeContext.workspaceRoot, input).catch(() => null) : null;
    const approval = await requestApproval({
      ...buildToolApprovalRequest({
        toolName,
        descriptor,
        input,
        sandboxStatus,
        permissionDecision: decision,
      }),
      ...(deletionGrant ? { deletionGrant } : {}),
      ...(handsFree && !separateReason ? { [NATIVE_APPROVAL_PROOF]: true } : {}),
      ...(separateReason ? { [SEPARATE_NATIVE_APPROVAL]: separateReason } : {}),
      ...(decision.commandPolicy?.category === "project-script" ? {
        kind: "project-script-trust", canRememberForRun: Boolean(projectTrust),
        projectFingerprint: projectTrust?.fingerprint || null,
        title: "运行项目脚本（宿主权限）",
        reason: "脚本名不代表安全。仅信任你了解的项目；选择本任务允许后，脚本、锁文件或相关配置变化会重新询问。这不是系统隔离。",
      } : {}),
    });
    assertNotAborted(signal);
    if (!approval?.approved) {
      if (approval?.skipped) throw approvalSkippedError(approval.reason, true);
      throw new Error(`The user rejected tool: ${toolName}`);
    }
    rememberedDeletion = Boolean(approval.remembered && deletionGrant);
    if (projectTrust && (await projectScriptFingerprint(executeContext.workspaceRoot, input))?.fingerprint !== projectTrust.fingerprint) {
      throw new Error("PROJECT_SCRIPT_CHANGED: 项目脚本在审批期间发生变化，请重新确认后执行。");
    }
  }

  if (toolName === "read_external_file") {
    await waitForRuntimeResume(signal);
    await assertLocalControlTool({ toolName, input, workspaceRoot: executeContext.workspaceRoot, count: false });
    const directoryPath = await verifyExternalFileTarget(executeContext.workspaceRoot, input?.path);
    const directoryResult = await tryReadExternalDirectory(directoryPath, {
      signal,
    });
    if (directoryResult) {
      assertNotAborted(signal);
      return { modelResult: directoryResult };
    }
  }

  // Executable verification is an ordinary command, never an unapproved host
  // fallback. Re-enter the authoritative command boundary before any code runs.
  if (toolName === 'verify_project' && ['script', 'command'].includes(input.kind)) {
    const selected = await verificationCommand(executeContext.workspaceRoot, input);
    const result = await dispatchNativeTool({ registry, permissionPolicy, approvalMode, requestApproval, sandboxStatus, executionMode, signal,
      parseArguments, executeAuthorized, executeContext,
      toolCall: { id: `${toolCall.id}-check`, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: selected.command, cwd: input.cwd || '.', verification: true, ...(input.timeout_ms ? { timeout_ms: input.timeout_ms } : {}) }) } } });
    return { ...result, modelResult: { ...result.modelResult, verification: true, parseOnly: false } };
  }
  const result = await executeDurableTool(toolName, input, async () => {
    // Revalidate after human approval/durable reconciliation; neither can
    // broaden the client grant or authorize a newly redirected symlink.
    await assertLocalControlTool({ toolName, input, workspaceRoot: executeContext.workspaceRoot, count: false });
    await assertNativeFileTool({ toolName, input, workspaceRoot: executeContext.workspaceRoot });
    await verifyWorkspaceScript().catch(error => { throw markToolPreflightFailure(error); });
    if (rememberedDeletion) {
      const latest = await prepareFileDeletion(executeContext.workspaceRoot, input, { signal });
      if ((await deletionScope(latest).catch(() => null))?.id !== deletionGrant.id)
        throw new Error('DELETE_APPROVAL_SCOPE_CHANGED: 文件目录已变化，请重新核对后确认。');
    }
    return withNativeFileScope(toolName, executeContext.workspaceRoot, () => executeAuthorized({
    ...executeContext,
    toolCall,
    toolName,
    descriptor,
    input,
    signal,
    permissionDecision: decision,
    workspaceArchive,
    automaticPreviewAction,
    automaticPreview: handsFree,
    browserPresentationAllowed,
    }));
  }, requestApproval, { scope: executeContext.durableScope });
  assertNotAborted(signal);
  return requireToolResult(result, toolName);
}

export function projectNativeToolCatalog({
  catalog = [],
  approvalMode = "manual",
  sandboxStatus = null,
  executionMode = null,
} = {}) {
  return (catalog || []).map((tool) => {
    if (tool?.name !== "run_command" || tool.permission === "deny") return tool;
    const decision = resolveToolExecutionPermission({
      toolName: "run_command",
      permissionAction: tool.permission,
      approvalMode,
      sandboxStatus,
      executionMode,
      input: {},
    });
    const backend = decision.backend;
    return {
      ...tool,
      permission: decision.requiresApproval ? "ask" : "allow",
      executionMode: decision.executionMode,
      warning:
        isHandsFreeApproval(approvalMode)
          ? 'Ordinary workspace commands are automatic; protected operations ' + (approvalMode === APPROVE_ALL_MODE ? 'are skipped.' : 'require confirmation.')
          : backend.mode === "direct"
          ? "Direct execution uses the real workspace and host authority. Only recognized low-risk commands may auto-run; unknown commands require approval."
          : backend.mode === "isolated"
            ? backend.available
              ? "Commands use the Docker isolation profile. Explicit destructive, dependency-mutating, and remote-write commands still require approval."
              : "Docker isolation was selected but is not ready. Command execution remains behind an approval boundary until the isolated backend is available."
            : "Safe execution protects workspace mutations with a temporary copy, but still uses host process and network authority. Unknown commands require approval.",
    };
  });
}
