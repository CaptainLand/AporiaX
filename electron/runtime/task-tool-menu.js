import { classifyTaskRequest } from './simple-request-context.js';

// A presentation choice, never an authorization or execution policy. Be
// conservative on ambiguity; loading the rest costs no extra classifier call.
const loader = {type:'function',function:{name:'enable_task_tools',
  description:'If more capabilities are needed, enable one or more allowed tool groups for the next step. Does not execute tools or grant permission.',
  parameters:{type:'object',properties:{groups:{type:'array',items:{type:'string',enum:['workspace','web','agents','extensions','all']}}},
    required:['groups'],additionalProperties:false}}};
const groups = new Set(loader.function.parameters.properties.groups.items.enum);
export const simpleQuestion = messages => classifyTaskRequest(messages) === 'standalone-question';

const detail = {
  workspace_read: 'find/read files and navigate code',
  workspace_write: 'edit files and manage temporary checks',
  terminal: 'commands and processes',
  git: 'version control and GitHub',
  web_search: 'public search and text retrieval',
  browser: 'browser interaction and visual evidence',
  office: 'Office artifacts',
  agents: 'delegation and reviews',
  verify: 'verification and numeric checks',
  planning: 'plan, review decisions or finish',
  delivery: 'present rendered HTML, Markdown or other user-facing previews',
  extensions: 'skills, configured integrations, knowledge and appearance',
};
export function taskCapability(name) {
  if (name === 'mcp_read_result') return 'workspace_read';
  if (/^(?:git_|github_)/.test(name)) return 'git';
  if (/^browser_/.test(name)) return 'browser';
  if (/^web_/.test(name)) return 'web_search';
  if (/^(?:create_(?:word_document|presentation|spreadsheet)|inspect_office_file)$/.test(name)) return 'office';
  if (/subagent|agent_role/.test(name)) return 'agents';
  if (/^mcp_|skill|theme|appearance|project_knowledge|remember_project_fact/.test(name)) return 'extensions';
  if (/^(?:run_command|start_process|wait_process|read_process|write_stdin|kill_process)$/.test(name)) return 'terminal';
  if (/^(?:delete_file|write_file|apply_patch|cleanup_temporary_check|lsp_install)$/.test(name)) return 'workspace_write';
  if (/self_check|^verify_/.test(name)) return 'verify';
  if (name === 'present_to_user') return 'delivery';
  if (/^(?:update_plan|task_brief|replan_strategy|finish_task|request_user_input)$/.test(name)) return 'planning';
  return 'workspace_read';
}
const base = new Set(['read_conversation_history']);
function adaptiveLoader(defs) {
  const allowed = [...new Set(defs.filter(d=>!base.has(d.function.name)).map(d=>taskCapability(d.function.name)))];
  if (!allowed.length && !defs.some(d=>d.function.name === 'read_conversation_history')) return null;
  const choices = allowed.map(x=>x+': '+detail[x]).join('; ');
  const properties = {};
  if (allowed.length) properties.groups = {type:'array',items:{type:'string',enum:allowed},minItems:1,uniqueItems:true};
  const history = defs.find(d=>d.function.name === 'read_conversation_history');
  if (history) properties.history = history.function.parameters;
  return {type:'function',function:{name:loader.function.name,description:
    'Load only what is missing in one call. Optionally retrieve a conversation page/search with history in the same call. Does not execute actions or grant permissions. '+choices,
    parameters:{type:'object',properties,additionalProperties:false}}};
}
function group(name) {
  if (/^(browser_|web_)/.test(name)) return 'web';
  if (/subagent|agent_role/.test(name)) return 'agents';
  if (/^mcp_|skill|theme|appearance/.test(name)) return 'extensions';
  return 'workspace';
}
export function taskToolMenu(compact, saved, {adaptive=false}={}) {
  const active = new Set(saved?.groups?.filter(x=>adaptive ? Object.hasOwn(detail,x) : groups.has(x)) || []);
  let light = saved ? saved.compact === true : compact;
  return {
    snapshot:()=>({compact:light,groups:[...active]}),
    full:()=>{light=false;},
    project(defs) {
      if (adaptive) {
        const discover = adaptiveLoader(defs);
        return [...(discover ? [discover] : []),...defs.filter(d=>base.has(d.function.name)||active.has(taskCapability(d.function.name)))];
      }
      if (!light || active.has('all') || !defs.length) return defs;
      return [loader,...defs.filter(d=>d.function.name==='read_conversation_history' || active.has(group(d.function.name)))];
    },
    enable(input, defs) {
      if (adaptive) {
        if (!input || Object.keys(input).some(k=>k!=='groups'&&k!=='history') ||
            (input.groups!==undefined && (!Array.isArray(input.groups)||!input.groups.length))) throw Error('Invalid discovery request.');
        const requested=input.groups ?? [];
        const permitted=new Set(defs.filter(d=>!base.has(d.function.name)).map(d=>taskCapability(d.function.name)));
        if ((!requested.length && input.history===undefined) || requested.some(x=>!permitted.has(x))) throw Error('Requested tool group is not available for this task.');
        const newGroups=[...new Set(requested.filter(x=>!active.has(x)))];
        for (const x of newGroups) active.add(x);
        return {enabled:newGroups, alreadyAvailable:requested.filter(x=>!newGroups.includes(x))};
      }
      if (!light || !Array.isArray(input?.groups) || !input.groups.length || input.groups.some(x=>!groups.has(x))) throw Error('Invalid tool group.');
      for (const x of input.groups) active.add(x);
      return {enabled:defs.filter(d=>active.has('all')||active.has(group(d.function.name))).map(d=>d.function.name)};
    }
  };
}
