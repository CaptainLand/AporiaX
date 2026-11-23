// Actual grants intersect parent permissions, explicit profile choices and scopes.
export const DELEGATED_WRITE_TOOLS = Object.freeze(['write_file', 'delete_file', 'cleanup_temporary_check', 'apply_patch', 'create_word_document', 'create_presentation', 'create_spreadsheet']);
export const DELEGATED_COMMAND_TOOLS = Object.freeze(['run_command', 'verify_project', 'start_process', 'read_process', 'wait_process', 'write_stdin', 'kill_process']);
export const DELEGATED_NATIVE_TOOLS = Object.freeze([
  'task_brief', 'replan_strategy', 'list_directory', 'read_file', 'search_text', 'find_files', 'git_status', 'git_diff', 'git_log', 'inspect_office_file', 'verify_numeric_data', 'lsp',
  'web_search', 'web_fetch', 'browser_open', 'browser_snapshot', 'browser_screenshot', 'browser_console', 'browser_network', 'browser_close', 'browser_click', 'browser_fill', 'browser_press', 'browser_select', 'browser_upload',
  ...DELEGATED_WRITE_TOOLS, ...DELEGATED_COMMAND_TOOLS,
]);
