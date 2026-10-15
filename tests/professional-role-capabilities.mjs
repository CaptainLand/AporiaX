import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultRole, defaultRoleSettings, NATIVE_ROLE_TOOLS } from '../shared/professional-roles.js';
import { SUBAGENT_ROLE_CONFIG } from '../electron/runtime/subagent-model.js';
import { runHarness } from '../electron/agent-runtime-core.js';
import { createKnowledgeWorkspace } from '../electron/knowledge-projects.js';

for (const [role, tools] of Object.entries(NATIVE_ROLE_TOOLS)) assert.deepEqual([...SUBAGENT_ROLE_CONFIG[role].tools].sort(), [...tools].sort());
const root = await realpath(await mkdtemp(join(tmpdir(), 'aporia-role-capabilities-')));
const original = globalThis.fetch;
const call = (id, name, args) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\ndata: [DONE]\n\n`);
const answer = content => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
const serverCode = [
  "const {Server}=require('@modelcontextprotocol/sdk/server/index.js');",
  "const {StdioServerTransport}=require('@modelcontextprotocol/sdk/server/stdio.js');",
  "const {ListToolsRequestSchema,CallToolRequestSchema}=require('@modelcontextprotocol/sdk/types.js');",
  "const s=new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});",
  "s.setRequestHandler(ListToolsRequestSchema,async()=>({tools:Array.from({length:40},(_,i)=>({name:'tool_'+String(i).padStart(2,'0'),description:'Fixture lookup',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}))}));",
  "s.setRequestHandler(CallToolRequestSchema,async r=>({content:[{type:'text',text:'LOCAL_MCP_FIXTURE_OK'}]}));s.connect(new StdioServerTransport());",
].join('\n');
const server = { id: 'fixture', name: 'Fixture', enabled: true, transport: 'stdio', command: process.execPath, args: ['-e', serverCode], cwd: process.cwd(), env: {}, timeoutMs: 5000, autoApproveReadOnly: true };
try {
  const workspace = join(root, 'workspace'), skills = join(root, 'skills'), knowledge = join(root, 'knowledge');
  await mkdir(workspace); await mkdir(join(skills, 'selected'), { recursive: true });
  await writeFile(join(skills, 'selected', 'SKILL.md'), '---\nname: selected\ndescription: Fixture only\nauto: false\n---\nSELECTED_SKILL_CONTENT');
  const projects = await createKnowledgeWorkspace({ workspaceRoot: workspace, baseDirectory: knowledge });
  const project = (await projects.create({ name: 'Fixture' })).project;
  const store = await projects.open(project.id);
  await store.commit({ changes: [{ content: 'KNOWLEDGE_FIXTURE uses local tests', evidence: [{ type: 'user', reference: 'Synthetic fixture instruction' }] }] });
  for (const scenario of ['skills', 'knowledge', 'mcp', 'mcp-denied']) {
    let main = 0, child = 0, approvals = 0;
    const role = { ...defaultRole(scenario.startsWith('mcp') ? 'verify' : 'explore'), id: 'specialist', name: 'Specialist', maxRounds: 8,
      skills: ['selected'], knowledge: 'read', mcpTools: ['mcp__fixture__tool_39'] };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body), text = body.messages.map(item => item.content || '').join('\n');
      if (/You are the AporiaX (explore|verify) subagent\./.test(text)) {
        child++;
        const tools = body.tools.map(tool => tool.function.name), last = body.messages.filter(item => item.role === 'tool').at(-1);
        assert(!tools.includes('delegate_subagent'), 'no recursive delegation');
        if (scenario === 'skills') {
          assert(tools.includes('read_skill_resource')); assert(!tools.includes('project_knowledge'));
          if (child === 1) return call('unselected', 'read_skill_resource', { skill: 'not-selected', path: 'SKILL.md' });
          if (child === 2) { assert.match(last.content, /未授予/); return call('selected', 'read_skill_resource', { skill: 'selected', path: 'SKILL.md' }); }
          assert.match(last.content, /SELECTED_SKILL_CONTENT/); return answer('Selected workflow read.');
        }
        if (scenario === 'knowledge') {
          assert(tools.includes('project_knowledge'));
          if (child === 1) return call('cross-project', 'project_knowledge', { action: 'search', query: 'local', project_id: 'other' });
          if (child === 2) { assert.match(last.content, /不能切换/); return call('write-denied', 'project_knowledge', { action: 'save', content: 'not allowed' }); }
          if (child === 3) { assert.match(last.content, /不能切换|知识操作/); return call('read', 'project_knowledge', { action: 'search', query: 'local' }); }
          assert.match(last.content, /KNOWLEDGE_FIXTURE/); return answer('Bound knowledge read.');
        }
        if (scenario === 'mcp-denied') { assert(!tools.some(name => name.startsWith('mcp__'))); return answer('MCP unavailable for a narrowed scope.'); }
        assert(tools.includes('mcp__fixture__tool_39'), 'explicitly selected deferred schema is available');
        assert(!tools.includes('mcp__fixture__tool_00'), 'other parent tools are not exposed');
        if (child === 1) return call('mcp-read', 'mcp__fixture__tool_39', {});
        assert.match(last.content, /LOCAL_MCP_FIXTURE_OK/); return answer('Selected MCP lookup verified.');
      }
      if (++main === 1) return call('delegate', 'delegate_subagent', { role: 'specialist', task: 'Inspect only the synthetic fixtures', scope: scenario === 'mcp-denied' ? ['src'] : ['.'], background: false });
      if (main === 2 && scenario !== 'mcp-denied') return call('accept', 'review_subagent_result', { agent_id: `${scenario}-sub-1`, report_id: `${scenario}-sub-1:1`, decision: 'accepted', reason: 'Returned fixture evidence matches the request.', evidence_ids: scenario === 'mcp' ? [`${scenario}-sub-1:1:mcp-read`] : [] });
      return answer('Fixture inspection complete.');
    };
    try {
      const result = await runHarness({ runId: scenario, taskId: 'fixture', workspacePath: workspace, userSkillsDirectory: skills,
        understandingDirectory: knowledge, knowledgeEnabled: scenario === 'knowledge', knowledgeProjectId: scenario === 'knowledge' ? project.id : '',
        mcpServers: scenario.startsWith('mcp') ? [server] : [], roleSettings: { ...defaultRoleSettings(), profiles: [...defaultRoleSettings().profiles, role] },
        provider: { id: 'fixture', name: 'Fixture', vendor: 'openai', baseUrl: 'https://test.invalid/v1', apiKey: 'mock-only', models: [{ id: 'test', supportsTools: true, contextWindow: 128000 }] }, modelId: 'test',
        permission: scenario.startsWith('mcp') ? 'workspace-write' : 'read-only', approvalMode: 'manual', signal: controller.signal,
        requestApproval: async () => { approvals++; return { approved: true }; }, messages: [{ role: 'user', content: 'Inspect the synthetic fixtures without modifying files.' }] });
      assert.equal(result.status, scenario === 'mcp-denied' ? 'partial' : 'completed', result.content);
      if (scenario === 'mcp') assert(approvals >= 1, 'MCP must request explicit approval');
      assert.equal(result.subagents[0].profileId, 'specialist');
      console.log(`PASS role capabilities actual loop: ${scenario}`);
    } finally { clearTimeout(timer); controller.abort(); }
  }
} finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); }
