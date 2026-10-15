import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHarness } from '../electron/agent-runtime-core.js';
import { runHarness as runDesktopHarness } from '../electron/agent-runtime.js';
import { createRoleSettingsStore } from '../electron/harness/role-settings.js';

const root = await mkdtemp(join(tmpdir(), 'aporia-role-tools-loop-'));
const originalFetch = globalThis.fetch;
const sse = delta => new Response(`data: ${JSON.stringify({ choices: [{ delta }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
const call = (id, name, input) => sse({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
const provider = { id: 'fixture', name: 'Fixture', vendor: 'openai', baseUrl: 'https://test.invalid/v1', apiKey: 'mock-only', models: [{ id: 'fixture', supportsTools: true, contextWindow: 128000 }] };
try {
  await writeFile(join(root, 'notes.txt'), 'ROLE_TEST_EVIDENCE');
  for (const scenario of ['approved', 'denied', 'no-workspace', 'worker']) {
    const store = await createRoleSettingsStore(join(root, scenario));
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    let requests = 0, children = 0, approvals = 0;
    const events = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      const system = body.messages.map(message => message.content || '').join('\n');
      const names = body.tools?.map(tool => tool.function.name) || [];
      if (system.includes('You are the AporiaX review subagent.')) {
        children++;
        assert(!names.includes('manage_agent_role') && !names.includes('list_agent_roles'), 'worker never receives role management');
        if (!system.includes('ROLE_TEST_EVIDENCE')) return call('read-child', 'read_file', { path: 'notes.txt' });
        return sse({ content: 'ROLE_TEST_EVIDENCE checked.' });
      }
      requests++;
      if (scenario === 'worker') {
        assert(!names.includes('manage_agent_role') && !names.includes('list_agent_roles'));
        return sse({ content: 'No role tools are available to this worker.' });
      }
      assert(names.includes('manage_agent_role') && names.includes('list_agent_roles'));
      if (requests === 1) return call('list', 'list_agent_roles', {});
      if (requests === 2) return call('create', 'manage_agent_role', { action: 'create', role_id: 'ui-specialist', expected_revision: 0, reason: '用户要求添加界面审查角色', changes: { name: '界面审查', template: 'review' } });
      if (scenario === 'denied') {
        assert.equal(store.snapshot().profiles.length, 5);
        return sse({ content: '用户拒绝，配置未修改。' });
      }
      if (scenario === 'no-workspace') return sse({ content: '角色已保存。' });
      if (requests === 3) return call('delegate', 'delegate_subagent', { role: 'ui-specialist', task: 'Read notes.txt and report evidence.', scope: ['notes.txt'], background: false });
      if (requests === 4) return call('review', 'review_subagent_result', { agent_id: `${scenario}-sub-1`, report_id: `${scenario}-sub-1:1`, decision: 'accepted', reason: 'File evidence verified.', evidence_ids: [] });
      if (requests === 5) return call('update', 'manage_agent_role', { action: 'update', role_id: 'ui-specialist', expected_revision: 1, reason: '用户要求修改职责', changes: { description: 'Review accessibility' } });
      if (requests === 6) return call('delete', 'manage_agent_role', { action: 'delete', role_id: 'ui-specialist', expected_revision: 2, reason: '用户要求删除角色' });
      return sse({ content: '角色变更已按确认完成，历史工作记录仍保留。' });
    };
    try {
      const execute = scenario === 'approved' ? runDesktopHarness : runHarness;
      const result = await execute({ runId: scenario, taskId: 'task', workspacePath: scenario === 'no-workspace' ? '' : root,
        provider, modelId: 'fixture', permission: 'workspace-write', approvalMode: 'full-auto',
        ...(scenario === 'worker' ? { acceptanceScope: 'worker' } : {}),
        sandboxStatusResolver: async () => ({ available: false }),
        messages: [{ role: 'user', content: '管理我要求的自定义角色；必要时核对 notes.txt。' }], signal: controller.signal,
        roleSettings: store.snapshot(), roleManagement: { ownerRunId: scenario, store, overrides: {} },
        requestApproval: async details => { approvals++; assert.equal(details.kind, 'agent-role-change'); assert(details.description); return { approved: scenario !== 'denied' }; },
        onEvent: event => events.push(event),
      });
      assert.equal(result.status, 'completed', JSON.stringify({ status: result.status, content: result.content }));
      assert.equal(approvals, scenario === 'approved' ? 3 : scenario === 'worker' ? 0 : 1);
      assert.equal(store.snapshot().revision, scenario === 'approved' ? 3 : scenario === 'no-workspace' ? 1 : 0);
      if (scenario === 'approved') { assert.equal(children, 2); assert.equal(result.subagents[0].profileId, 'ui-specialist'); assert.equal(store.snapshot().profiles.length, 5); }
      assert.equal(events.filter(event => event.type === 'agent.roles.changed').length, store.snapshot().revision);
      console.log(`PASS mocked production loop: ${scenario}, full-auto confirms every mutation, created role usable immediately, workers isolated.`);
    } finally { clearTimeout(timer); controller.abort(); }
  }
} finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
