import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { runHarness } from '../electron/agent-runtime-core.js';
import { withDurableRun } from '../electron/runtime/durable-run.js';
import { readTaskOutcome } from '../electron/runtime/task-outcome.js';
import { finishExecutionPlan } from '../electron/runtime/plan-lifecycle.js';
import { getLiveRunProgress } from '../src/conversation/witness-progress.js';
import { provider, call, tools, sse } from './goal-loop-fixtures.mjs';

const parent = resolve(tmpdir());
const root = await mkdtemp(join(parent, 'aporiax-task-ending-'));
const workspace = join(root, 'workspace');
await mkdir(workspace);
const originalFetch = globalThis.fetch;
let sequence = 0;
const plan = { steps: [
  { id: 'inspect', title: 'Inspect the workspace', status: 'in_progress' },
  { id: 'change', title: 'Write the result', status: 'pending' },
  { id: 'test', title: 'Check the result', status: 'pending' },
  { id: 'deliver', title: 'Present the result', status: 'pending' },
] };
const parser = tool => JSON.parse(tool.function.arguments);
const parse = (input, content = '') => readTaskOutcome({ content, tool_calls: [call('done', 'finish_task', input)] }, parser);
async function run(responses, overrides = {}) {
  const runId = `ending-${++sequence}`, events = [], bodies = [];
  let savedContext;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    const response = responses[bodies.length - 1];
    assert.ok(response, `Unexpected extra model request in ${runId}`);
    return typeof response === 'function' ? response(body) : response;
  };
  const result = await withDurableRun({ recoveryDirectory: join(root, 'recovery'), operation: async () => {},
    context: async (_scopeId, snapshot) => { savedContext = JSON.parse(snapshot); },
  }, () => runHarness({
    runId, taskId: runId, workspacePath: workspace, permission: 'read-only', language: 'en',
    provider: { ...provider, models: [{ ...provider.models[0], contextWindow: 256000 }] }, modelId: 'fixture',
    signal: AbortSignal.timeout(20000), requestApproval: async () => ({ approved: true }),
    onEvent: event => events.push(event), messages: [{ role: 'user', content: 'Complete this requested work and reply naturally.' }], ...overrides,
  }));
  return { result, events, bodies, savedContext };
}

try {
  assert.equal(parse({ summary: 'Done.' }).status, 'completed');
  assert.equal(parse({ status: 'success', summary: 'Done.' }).status, 'completed');
  assert.equal(parse({ status: 'failed', summary: 'One issue remains.' }).status, 'partial');
  assert.equal(parse({ status: 'unexpected', summary: 'Here is the answer.' }).summary, 'Here is the answer.');
  for (const status of ['constructor', '__proto__', 'toString']) {
    assert.equal(parse({ status, summary: 'Still a normal answer.' }).status, 'completed');
  }
  assert.equal(parse({ answer: 'Direct answer.' }).summary, 'Direct answer.');
  assert.equal(parse({}, 'Normal model reply.').summary, 'Normal model reply.');
  const malformed = readTaskOutcome({ content: 'Usable reply.', tool_calls: [{ id: 'bad', function: { name: 'finish_task', arguments: '{invalid' } }] }, parser);
  assert.equal(malformed.summary, 'Usable reply.');
  assert.ok(malformed.normalization.issues.includes('arguments_not_json'));
  const badOption = parse({ summary: 'Still usable.', warnings: {}, details: ['More information.'] });
  assert.equal(badOption.summary, 'Still usable.'); assert.equal(badOption.details, 'More information.');
  assert.equal(badOption.warnings, undefined);

  let scenario = await run([sse({ content: 'The requested answer.' })]);
  assert.equal(scenario.result.status, 'completed');
  assert.equal(scenario.result.content, 'The requested answer.');
  assert.equal(scenario.bodies.length, 1);
  assert.equal(scenario.result.plan, null, 'Simple replies do not create plans');
  for (const input of [{ summary: 'Here is the result.' }, { status: 'success', answer: 'Here is the result.' }, { status: '???', summary: 'Here is the result.', details: {} }]) {
    scenario = await run([tools(call('done', 'finish_task', input))]);
    assert.equal(scenario.result.status, 'completed');
    assert.equal(scenario.result.content, 'Here is the result.');
    assert.equal(scenario.bodies.length, 1, 'A usable reply needs no formatting repair round');
    assert.ok(scenario.events.some(event => event.type === 'completion.normalized'));
    assert.ok(!scenario.events.some(event => event.type === 'turn.failed'));
  }

  scenario = await run([
    tools(call('plan', 'update_plan', plan)),
    tools(call('finish-empty', 'finish_task', { status: 'completed' })),
    body => { assert.equal(body.tools, undefined, 'The fallback requests a normal answer without tools'); return sse({ content: 'The result is ready for you to inspect.' }); },
  ]);
  assert.equal(scenario.result.status, 'completed');
  assert.equal(scenario.result.content, 'The result is ready for you to inspect.');
  assert.equal(scenario.bodies.length, 3);
  assert.equal(scenario.result.plan.steps.filter(step => step.status === 'completed').length, 4);
  assert.ok(scenario.result.plan.finishedAt);
  assert.equal(scenario.result.witness.plan.steps.filter(step => step.status === 'completed').length, 4);
  const progress = getLiveRunProgress({ status: scenario.result.status, plan: scenario.result.plan, witness: scenario.result.witness });
  assert.equal(progress.completedCount, 4); assert.equal(progress.totalCount, 4);
  assert.ok(scenario.events.some(event => event.type === 'plan.updated' && event.reason === 'task-ended'));
  assert.deepEqual(scenario.savedContext.plan, scenario.result.plan, 'Recovery keeps the terminal plan, not the stale initial plan');
  assert.equal(scenario.savedContext.plainReplyRequest, null);
  assert.ok(scenario.events.findLastIndex(event => event.type === 'plan.updated') < scenario.events.findIndex(event => event.type === 'turn.completed'));
  assert.notEqual(scenario.result.selfCheck.verificationPassed, true, 'Closing the plan does not invent verification evidence');

  scenario = await run([tools(call('finish-1', 'finish_task', {})), tools(call('finish-2', 'finish_task', {}))]);
  assert.equal(scenario.result.status, 'partial');
  assert.match(scenario.result.content, /model did not provide a final reply/);
  assert.equal(scenario.bodies.length, 2, 'A provider ignoring the plain-reply request cannot cause an endless repair loop');
  assert.ok(!scenario.events.some(event => event.type === 'turn.failed'));

  scenario = await run([
    tools(call('finish-empty', 'finish_task', { status: 'completed' })),
    tools(call('finish-partial', 'finish_task', { status: 'partial', summary: 'The saved draft still needs a missing dependency.' })),
  ]);
  assert.equal(scenario.result.status, 'partial', 'A genuine remaining issue in the reply is not overwritten by earlier metadata');
  assert.match(scenario.result.content, /missing dependency/);

  scenario = await run([
    tools(call('finish-mixed', 'finish_task', { summary: 'Premature reply.' }), call('write', 'write_file', { path: 'result.txt', content: 'Preserved result.' })),
    sse({ content: 'Saved result.txt.' }),
  ], { permission: 'workspace-write', messages: [{ role: 'user', content: 'Create result.txt with Preserved result. and tell me when it is saved.' }] });
  assert.equal(scenario.result.status, 'completed');
  assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'Preserved result.');
  assert.equal(scenario.result.content, 'Saved result.txt.');
  assert.ok(scenario.events.some(event => event.type === 'tool.completed' && event.tool === 'write_file' && event.success));
  assert.ok(!scenario.events.some(event => event.type === 'turn.failed'));

  scenario = await run([
    tools(call('plan', 'update_plan', plan)),
    tools(call('done', 'finish_task', { status: 'partial', summary: 'The draft is available; the remaining checks need your input.' })),
  ]);
  assert.equal(scenario.result.status, 'partial');
  assert.equal(scenario.result.plan.steps.filter(step => step.status === 'completed').length, 0);
  assert.equal(scenario.result.plan.steps.filter(step => step.status === 'in_progress').length, 0);
  assert.equal(scenario.result.plan.status, 'partial');
  const progressPlan = { steps: plan.steps.map((step, index) => ({ ...step, status: index === 0 ? 'completed' : index === 1 ? 'in_progress' : 'pending' })) };
  scenario = await run([
    tools(call('initial-plan', 'update_plan', plan)),
    tools(call('progress-plan', 'update_plan', progressPlan)),
    sse({ content: 'The requested result is ready.' }),
  ]);
  const updates = scenario.events.filter(event => event.type === 'plan.updated');
  assert.equal(updates[1].plan.steps[0].status, 'completed');
  assert.equal(updates[1].plan.steps[1].status, 'in_progress');
  assert.equal(scenario.result.plan.steps.filter(step => step.status === 'completed').length, 4);

  for (const status of ['failed', 'interrupted']) {
    const controller = new AbortController();
    scenario = await run([
      tools(call('initial-plan', 'update_plan', progressPlan)),
      () => {
        if (status === 'interrupted') { controller.abort(); controller.signal.throwIfAborted(); }
        throw Object.assign(new Error('Fixture authorization failure'), { status: 401 });
      },
    ], { signal: controller.signal });
    assert.equal(scenario.result.status, status);
    assert.equal(scenario.result.plan.steps.filter(step => step.status === 'completed').length, 1);
    assert.ok(scenario.result.plan.steps.every(step => step.status !== 'in_progress'));
    assert.deepEqual(scenario.savedContext.plan, scenario.result.plan);
    assert.deepEqual(scenario.result.witness.plan, scenario.result.plan);
  }
  for (const status of ['failed', 'interrupted', 'blocked', 'needs_input']) {
    const ended = finishExecutionPlan({ ...plan, steps: [{ ...plan.steps[0], status: 'completed' }, ...plan.steps.slice(1), { id: 'active', title: 'Remaining work', status: 'in_progress' }] }, status);
    assert.equal(ended.steps.filter(step => step.status === 'completed').length, 1);
    assert.equal(ended.steps.filter(step => step.status === 'in_progress').length, 0);
  }
  const blocked = finishExecutionPlan({ steps: [{ id: 'check', title: 'Check', status: 'blocked' }] }, 'completed');
  assert.equal(blocked.steps[0].status, 'blocked');
  console.log('PASS tolerant task ending: plain answers, optional/malformed finish metadata, one text-only fallback, mixed operations, real saved file, plan/Witness synchronization, and unfinished/blocked/interrupted honesty. No live model requests.');
} finally {
  globalThis.fetch = originalFetch;
  const target = relative(parent, resolve(root));
  assert.ok(target.startsWith('aporiax-task-ending-') && !target.includes(sep));
  await rm(root, { recursive: true, force: true });
}
