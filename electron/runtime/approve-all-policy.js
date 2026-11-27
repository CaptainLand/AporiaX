import { classifyCommandPermission, hasShellComposition, isShellDeletion } from './execution-policy.js';
import { APPROVE_ALL_MODE } from '../../shared/approval-modes.js';

export const APPROVE_ALL_GUIDANCE = 'Always allow automatically runs ordinary workspace builds, tests, previews and packaging. Actions needing separate authorization are skipped; do not reroute them through the shell, MCP or another Agent. Use present_to_user on workspace HTML for a run-owned interactive preview; use standalone Compress-Archive for workspace ZIP/OSK in Direct/Safe and delete_file for recoverable deletion. Continue other work and report consequential skips.';

const PROTECTED_TOOLS = new Set([
  'manage_agent_role', 'install_workspace_skill', 'lsp_install', 'git_remote_add',
  'git_pull', 'git_push', 'github_repo_create', 'github_pr_create', 'browser_upload', 'write_stdin',
]);
const HOST_ONLY_TOOLS = new Set(['start_process', 'write_stdin', 'kill_process', 'lsp']);
export const AUTOMATIC_PREVIEW_TOOLS = new Set(['browser_click', 'browser_fill', 'browser_select', 'browser_press']);
export const isHandsFreeApproval = mode => mode === APPROVE_ALL_MODE || mode === 'full-auto';
const AUTO_APPROVABLE = new Set([
  'read_file', 'read_external_file', 'search_text', 'find_files', 'list_directory', 'inspect_office_file',
  'write_file', 'apply_patch', 'delete_file', 'cleanup_temporary_check',
  'create_word_document', 'create_presentation', 'create_spreadsheet',
  'run_command', 'start_process', 'git_init', 'git_stage', 'git_commit', 'git_create_branch', ...AUTOMATIC_PREVIEW_TOOLS,
]);

export function nativeBackendBlockReason(toolName, backend) {
  if (backend.osIsolation && (HOST_ONLY_TOOLS.has(toolName) || /^(?:git_|github_)/.test(toolName)))
    return 'This tool uses a host process and cannot run in the selected Docker isolation. Use a container command if available.';
  if (['run_command', 'start_process'].includes(toolName) && !backend.available)
    return 'The selected command execution environment is unavailable; no fallback is allowed.';
  return '';
}

export function approveAllNativeBlockReason(toolName, input, decision, { workspaceArchive, automaticPreviewAction, workspaceScript } = {}) {
  const backendReason = nativeBackendBlockReason(toolName, decision.backend);
  if (backendReason) return backendReason;
  if (PROTECTED_TOOLS.has(toolName)) return 'This action requires separate authorization.';
  if (AUTOMATIC_PREVIEW_TOOLS.has(toolName) && !automaticPreviewAction) return 'Browser interaction outside a preview created by this run requires separate authorization.';
  if (toolName === 'run_command' || toolName === 'start_process') {
    if (toolName === 'run_command' && workspaceArchive && !decision.backend.osIsolation) return '';
    if (isShellDeletion(input.command)) return 'Use delete_file for an exact workspace file with a recovery snapshot.';
    const policy = decision.commandPolicy || classifyCommandPermission(input.command, { executionMode: decision.backend.mode });
    if (!decision.backend.osIsolation && hasShellComposition(String(input.command || ''))) return 'Shell chaining or expansion requires separate authorization.';
    if (workspaceScript) return '';
    if (policy.action !== 'allow' && policy.category !== 'project-script') return policy.reason;
  }
  return '';
}

// Only the native dispatcher can issue this proof, after enforcing the task
// policy, backend and file bounds. An MCP's name is not proof of authority.
export const NATIVE_APPROVAL_PROOF = Symbol('scoped native approval');
export const SEPARATE_NATIVE_APPROVAL = Symbol('separate native approval');
export function approveAllApprovalCanPass(details) {
  return details[NATIVE_APPROVAL_PROOF] === true && AUTO_APPROVABLE.has(details.toolName);
}

export function approvalSkippedError(reason, reported = false) {
  return Object.assign(new Error(`APPROVE_ALL_SKIPPED: ${reason}`), { code: 'APPROVE_ALL_SKIPPED', retryable: false, approvalReason: reason, approvalReported: reported });
}
