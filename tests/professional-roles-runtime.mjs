import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHarness } from '../electron/agent-runtime-core.js';
import { defaultRole, defaultRoleSettings } from '../shared/professional-roles.js';
import { controlWorker } from '../electron/runtime/worker-controls.js';
import { createKernelAgentRuntimeBroker, setDefaultAgentRuntimeBroker, clearDefaultAgentRuntimeBroker } from '../electron/harness/agent-runtime-broker.js';
import { createAgentDefinitionRegistry } from '../electron/harness/agent-definitions.js';
import { HarnessSessionStore } from '../electron/harness/session.js';
import { HarnessScheduler } from '../electron/harness/scheduler.js';

const root = await mkdtemp(join(tmpdir(), 'aporia-roles-runtime-'));
const original = globalThis.fetch;
const sse = delta => new Response(`data: ${JSON.stringify({ choices: [{ delta }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
const call = (id, name, input) => sse({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
const provider = { id: 'fixture', name: 'Fixture', vendor: 'openai', baseUrl: 'https://test.invalid/v1', apiKey: 'mock-only', models: [{ id: 'parent', supportsTools: true, contextWindow: 128000 }, { id: 'specialist', supportsTools: true, contextWindow: 128000 }] };
const profile = { ...defaultRole('explore'), id: 'researcher', name: 'Researcher', instructions: 'ROLE_INSTRUCTIONS_FIXTURE', model: 'specialist' };
const base = { taskId: 'task', workspacePath: root, provider, modelId: 'parent', permission: 'read-only', approvalMode: 'manual', language: 'en', messages: [{ role: 'user', content: 'Inspect notes and explain the evidence.' }],
  roleSettings: { ...defaultRoleSettings(), maxActive: 1, profiles: [...defaultRoleSettings().profiles, profile] } };
const accept = (run, id, report = 1) => call(`accept-${id}`, 'review_subagent_result', { agent_id: `${run}-sub-${id}`, report_id: `${run}-sub-${id}:${report}`, decision: 'accepted', reason: 'The observed notes answer the question.', evidence_ids: [] });
try {
  await writeFile(join(root, 'notes.txt'), 'FIXTURE_FILE_EVIDENCE');
  for (const scenario of ['dependencies', 'guidance', 'budget', 'stop']) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12000);
    const events = []; let main = 0, children = 0, sawGuidance = false;
    const kernel = { agents: createAgentDefinitionRegistry(), sessions: new HarnessSessionStore(), scheduler: new HarnessScheduler({ concurrency: 2 }) };
    setDefaultAgentRuntimeBroker(createKernelAgentRuntimeBroker({ kernel }));
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body), text = body.messages.map(item => item.content || '').join('\n');
      if (text.includes('You are the AporiaX explore subagent.')) {
        children++;
        assert(text.includes('ROLE_INSTRUCTIONS_FIXTURE'));
        assert.equal(body.model, 'specialist');
        assert(!body.tools.some(tool => ['write_file', 'run_command', 'project_knowledge', 'read_skill_resource'].includes(tool.function.name)));
        if (scenario === 'stop') {
          await controlWorker('stop', { runId: scenario, taskId: 'task', agentId: `${scenario}-sub-1` });
          throw Object.assign(new Error('stopped'), { name: 'AbortError' });
        }
        if (scenario === 'guidance' && children === 1) {
          const receipt = await controlWorker('steer', { runId: scenario, taskId: 'task', agentId: `${scenario}-sub-1`, task: 'GUIDANCE_FIXTURE: include the file evidence.' });
          assert.equal(receipt.status, 'guidance_queued');
          return call('stale-read', 'read_file', { path: 'notes.txt' });
        }
        if (scenario === 'guidance') sawGuidance ||= text.includes('GUIDANCE_FIXTURE');
        if (scenario === 'dependencies' && children === 3) {
          assert(events.some(event => event.type === 'subagent.reviewed' && event.agentId === `${scenario}-sub-1`), 'dependent worker cannot start before acceptance');
        }
        if (!text.includes('FIXTURE_FILE_EVIDENCE')) return call(`read-${children}`, 'read_file', { path: 'notes.txt' });
        return sse({ content: 'Evidence inspected.' });
      }
      main++;
      assert(text.includes('researcher'), 'Main discovers configured profiles');
      if (main === 1) return call('delegate', 'delegate_subagent', { role: 'researcher', task: 'Inspect notes.txt', scope: ['notes.txt'], background: false, required_for_completion: !['budget', 'stop'].includes(scenario) });
      if (scenario === 'dependencies') {
        if (main === 2) return call('dependent', 'delegate_subagent', { role: 'researcher', task: 'Independently check the accepted evidence', scope: ['notes.txt'], depends_on: [`${scenario}-sub-1`] });
        if (main === 3) return accept(scenario, 1);
        if (main === 4) return call('collect', 'collect_subagents', { wait: true });
        if (main === 5) return accept(scenario, 2);
      } else if (scenario === 'guidance' && main === 2) return accept(scenario, 1);
      return sse({ content: 'Inspection finished.' });
    };
    try {
      const result = await runHarness({ ...base, runId: scenario, signal: controller.signal, onEvent: event => events.push(event),
        roleSettings: { ...base.roleSettings, profiles: base.roleSettings.profiles.map(item => item.id === 'researcher' && scenario === 'budget' ? { ...item, maxRequests: 1 } : item) } });
      assert.equal(result.status, ['budget', 'stop'].includes(scenario) ? 'partial' : 'completed', JSON.stringify({ status: result.status, content: result.content }));
      assert.equal(result.subagents.length, scenario === 'dependencies' ? 2 : 1);
      const worker = result.subagents[0]; assert.equal(worker.profileId, 'researcher');
      assert.equal(worker.configuration.model, 'specialist');
      assert.equal(worker.budget.requests, scenario === 'guidance' ? 3 : ['budget', 'stop'].includes(scenario) ? 1 : 2);
      assert.equal(kernel.sessions.get(`${scenario}-sub-1`).metadata.definitionSource, 'professional-roles');
      if (scenario === 'guidance') { assert(sawGuidance); assert(!events.some(event => event.type === 'subagent.tool.completed' && event.callId === 'stale-read' && event.success)); }
      if (scenario === 'budget') { assert.equal(worker.status, 'budget_exhausted'); assert.equal(children, 1); }
      if (scenario === 'stop') assert.equal(worker.status, 'interrupted');
      await assert.rejects(controlWorker('list', { taskId: 'task', runId: scenario }), /已结束/);
      console.log(`PASS professional role real mocked loop: ${scenario}`);
    } finally { clearTimeout(timer); controller.abort(); clearDefaultAgentRuntimeBroker(); }
  }
} finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); }
