import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSubagentTask } from '../electron/runtime/subagent-loop.js';
import { captureDelegationContext } from '../electron/runtime/subagent-contract.js';
import { TOOL_REGISTRY } from '../electron/runtime/native-tool-catalog.js';
import { createPermissionPolicy } from '../electron/agent-core.js';
import { runHarness } from '../electron/agent-runtime-core.js';
import { createAgentActivityTracker } from '../electron/harness/agent-activity.js';
import { planAgentBudget, runWithAgentBudget, withAgentBudgetAdmission, enforceAgentBudgetEvent } from '../electron/harness/agent-budget.js';
import { createProjectUnderstandingStore } from '../electron/project-understanding.js';

const root = await mkdtemp(join(tmpdir(), 'aporia-worker-lifecycle-'));
const originalFetch = globalThis.fetch;
const tool = (id, name, input) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(input) } });
const finish = (status = 'completed') => ({ message: { tool_calls: [tool('done', 'finish_subagent', { status, summary: 'Updated requirements respected; tests were not run.' })] } });
try {
  for (const boundary of ['model', 'tools']) {
    let context = captureDelegationContext([{ role: 'user', content: 'Check the project.' }]);
    const update = () => { context = captureDelegationContext([{ role: 'user', content: 'Do not run any more commands; report only.' }]); };
    let round = 0, executed = 0;
    const events = [], session = {};
    const options = {
      agentId: `steered-${boundary}`, input: { role: 'verify', task: 'Check the project', scope: ['.'], maxRounds: 4 },
      provider: { id: 'mock', supportsTools: true, async complete({ body }) {
        if (++round === 1) {
          if (boundary === 'model') update();
          return { message: { tool_calls: [tool('first', 'run_command', { command: 'echo first', cwd: '.' }),
            ...(boundary === 'tools' ? [tool('second', 'run_command', { command: 'echo second', cwd: '.' })] : [])] } };
        }
        assert(body.messages.some((m) => String(m.content).includes('Do not run any more commands')), `${boundary}: ${JSON.stringify(body.messages.filter((m) => m.role === 'tool'))}`);
        return finish('partial');
      } }, modelId: 'mock', modelConfig: { contextWindow: 32000 }, workspaceRoot: root,
      parentPermissionPolicy: { ...createPermissionPolicy('workspace-write'), run_command: 'allow' }, approvalMode: 'sandbox-auto',
      requestApproval: async () => { throw new Error('No extra manual approval expected'); },
      signal: new AbortController().signal, sandboxStatus: { available: true, localAvailable: true, autoApprovalSafe: true },
      toolRegistry: TOOL_REGISTRY, parseToolArguments: (call) => JSON.parse(call.function.arguments),
      getDelegationContext: () => context, session, emit: (e) => events.push(e), language: 'en',
      executeAuthorizedTool: async () => { executed++; update(); return { modelResult: { exitCode: 0, stdout: 'mocked command, not executed' } }; },
    };
    const result = await runSubagentTask(options);
    assert.equal(result.status, 'partial', result.summary);
    assert.equal(result.acceptance.status, 'pending');
    assert.equal(executed, boundary === 'model' ? 0 : 1, 'A stale action must not execute after user requirements changed');
    if (boundary === 'tools') assert(result.evidence.some((item) => /GUIDANCE_CHANGED/.test(item.error)));
    const again = await runSubagentTask({ ...options, provider: { id: 'mock', supportsTools: true, complete: async () => finish() } });
    assert.equal(again.reportId, `steered-${boundary}:2`);
    assert.equal(session.activationSequence, 2, 'Follow-up activation is distinct from model rounds');
  }

  // Refusing/forgetting to accept a required report must not create an infinite
  // loop, false success or a manual-approval storm.
  let mainRounds = 0;
  const sse = (delta) => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (String(body.messages[0].content).includes('explore subagent')) return sse({ content: 'An unverified report.' });
    if (++mainRounds === 1) return sse({ tool_calls: [{ index: 0, ...tool('delegate', 'delegate_subagent', { role: 'explore', task: 'Inspect the workspace', scope: ['.'], background: false }) }] });
    assert(mainRounds <= 3, 'Acceptance reminder must be bounded');
    return sse({ content: 'Claiming completion without reviewing the report.' });
  };
  const result = await runHarness({ runId: 'missing-acceptance', workspacePath: root, permission: 'read-only', language: 'en',
    provider: { id: 'mock', name: 'Mock', vendor: 'openai', baseUrl: 'https://test.invalid/v1', apiKey: 'mock', models: [{ id: 'mock', supportsTools: true, contextWindow: 32000 }] }, modelId: 'mock',
    messages: [{ role: 'user', content: 'Delegate a focused workspace exploration.' }],
    requestApproval: async () => { throw new Error('No manual approval expected'); } });
  assert.equal(result.status, 'partial', result.content);
  assert.equal(mainRounds, 3);
  assert.equal(result.subagents[0].acceptance.status, 'pending');
  assert.match(result.content, /still need acceptance/);

  const understandingDirectory = join(root, 'knowledge-fixture');
  const store = await createProjectUnderstandingStore({ baseDirectory: understandingDirectory, workspaceRoot: root });
  await store.setSettings({ autoCurate: true, useForContext: true });
  let releaseCurator, curatorFinished, curatorRequested = false, delivered = false, main = 0;
  const release = new Promise((resolve) => { releaseCurator = resolve; });
  const finished = new Promise((resolve) => { curatorFinished = resolve; });
  const deadline = setTimeout(() => releaseCurator(), 5000);
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (String(body.messages[0].content).includes('curator subagent')) {
      curatorRequested = true;
      await release;
      assert(delivered, 'Main delivery must not wait for the Curator model');
      return sse({ content: JSON.stringify({ summary: 'No durable changes', changes: [] }) });
    }
    if (++main === 1) return sse({ tool_calls: [{ index: 0, ...tool('write-config', 'write_file', { path: 'package.json', content: '{"name":"fixture","private":true}' }) }] });
    return sse({ content: 'Project metadata written, not tested.' });
  };
  try {
    const deferred = await runHarness({ runId: 'deferred-curator', workspacePath: root, permission: 'workspace-write', language: 'en',
      provider: { id: 'mock', name: 'Mock', vendor: 'openai', baseUrl: 'https://test.invalid/v1', apiKey: 'mock', models: [{ id: 'mock', supportsTools: true, contextWindow: 32000 }] }, modelId: 'mock',
      knowledgeEnabled: true, knowledgeProjectId: 'legacy', understandingDirectory, deferUnderstandingCuration: true,
      messages: [{ role: 'user', content: 'Create minimal project metadata in package.json.' }],
      onEvent: (event) => { if (['understanding.skipped', 'understanding.updated', 'understanding.failed'].includes(event.type)) curatorFinished(); } });
    delivered = true;
    assert.equal(deferred.status, 'completed', deferred.content);
    assert.equal(deferred.witness.agentActivity.roles.curator.activations, 1, 'Deferred Curator start is captured before final snapshot');
    releaseCurator(); await finished;
    assert(curatorRequested);
  } finally { clearTimeout(deadline); releaseCurator(); }

  // Check telemetry against real admission, not a hard-coded UI cap.
  for (const limit of [1, 4, 6]) {
    const tracker = createAgentActivityTracker();
    const plan = planAgentBudget({ workspacePath: root, permission: 'workspace-write', builderLimit: limit, prompt: 'Modify a project' });
    tracker.observe({ type: 'turn.started', agentBudget: plan });
    let running = 0, peak = 0;
    await runWithAgentBudget(plan, { onEvent: (event) => tracker.observe(event) }, async () => {
      await Promise.all(Array.from({ length: 8 }, (_, index) => withAgentBudgetAdmission({ role: 'builder' }, async () => {
        const start = { type: 'subagent.started', role: 'builder', agentId: `b${index}`, activationId: `b${index}:1` };
        enforceAgentBudgetEvent(start); tracker.observe(start);
        peak = Math.max(peak, ++running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running--;
        const end = { ...start, type: 'subagent.completed' };
        enforceAgentBudgetEvent(end); tracker.observe(end);
      })));
    });
    const stats = tracker.snapshot();
    assert.equal(peak, limit); assert.equal(stats.builder.peak, limit);
    assert.equal(stats.builder.limit, limit); assert.equal(stats.builder.running, 0); assert.equal(stats.builder.queued, 0);
    assert.equal(stats.roles.builder.activations, 8);
  }
} finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
console.log('Subagent lifecycle: mid-model and mid-batch steering, continuation, bounded acceptance, and real Builder concurrency 1/4/6: PASS');
