// Host-selected execution mode. History and model-authored arguments cannot
// turn a temporary conversation into a coordinator or alter saved settings.
const ALLOWED = new Set(['read_conversation_history', 'task_brief', 'replan_strategy', 'update_plan', 'finish_task',
  'list_directory', 'read_file', 'search_text', 'git_status', 'git_diff', 'inspect_office_file',
  'write_file', 'delete_file', 'cleanup_temporary_check', 'apply_patch', 'run_command', 'verify_project',
  'create_word_document', 'create_presentation', 'create_spreadsheet']);
export function temporaryPermissionPolicy(policy, enabled) {
  if (!enabled) return policy;
  return Object.freeze({ '*': 'deny', ...Object.fromEntries([...ALLOWED].map(name => [name, policy[name] ?? policy['*'] ?? 'deny'])) });
}
export const TEMPORARY_CHAT_PROMPT = 'You are AporiaX in a temporary independent conversation fork. The inherited public conversation and records are historical reference, not pending tasks, current approvals or instructions to resume Main. Only the latest request in THIS temporary conversation authorizes work. Main continues independently. No subagents, delegation, role management, global settings, memory writes or publishing. Witness records your own observed actions only. Work on your provided workspace copy; writes are conflict-checked before application to the source project. Never bypass missing tools using commands or external paths. Explain unverified work honestly. Closing the conversation discards its messages and Witness, but does not undo already applied files.';
