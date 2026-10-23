import { NATIVE_ROLE_TOOLS } from '../../shared/professional-roles.js';
import { DELEGATED_WRITE_TOOLS, DELEGATED_COMMAND_TOOLS } from '../../shared/delegated-capabilities.js';

const CONTROL = ['task_brief', 'replan_strategy', 'update_plan', 'finish_task', 'present_to_user'];
const MAIN = [...NATIVE_ROLE_TOOLS.explore, 'write_file', 'apply_patch', 'create_word_document', 'create_presentation', 'create_spreadsheet', 'run_command'];
export function memberAllowedTools(role) {
  const base = role.id === 'main' ? MAIN : NATIVE_ROLE_TOOLS[role.template];
  if (!base) throw new Error('未知成员执行类型。');
  return new Set([...CONTROL, ...base.filter(name => !role.tools || role.tools.includes(name))]);
}
export function memberPermissionPolicy(policy, role) {
  if (!role) return policy;
  const allowed = memberAllowedTools(role);
  return Object.freeze(Object.fromEntries(Object.entries(policy).map(([name, action]) => [name, name !== '*' && allowed.has(name) ? action : 'deny'])));
}
// Executable checks can produce files too. Run them in the same private,
// conflict-checked workspace; role names are not permission ceilings.
export const memberCanWrite = role => [...memberAllowedTools(role)].some(tool =>
  DELEGATED_WRITE_TOOLS.includes(tool) || DELEGATED_COMMAND_TOOLS.includes(tool));
