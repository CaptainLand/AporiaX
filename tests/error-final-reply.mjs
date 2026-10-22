import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { runHarness } from '../electron/agent-runtime-core.js';
import { withDurableRun } from '../electron/runtime/durable-run.js';
import { canRequestErrorReply } from '../electron/runtime/error-final-reply.js';
import { preserveDeliveredReply } from '../shared/reply-delivery.js';
import { hasTaskReply } from '../src/state/task-outcome-view.js';
import { provider, call, tools, sse } from './goal-loop-fixtures.mjs';
import { createHarnessTaskRuntime } from '../electron/harness/task-runtime.js';
import { closeRunJournalStore } from '../electron/run-store.js';

const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'aporiax-final-reply-'));
const originalFetch = globalThis.fetch;
let sequence = 0;
async function run(responses, extra = {}) {
  const runId = `reply-${++sequence}`, workspace = join(root, runId), events = [], bodies = [];
  await mkdir(workspace);
  let saved;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    const response = responses[bodies.length - 1];
    assert.ok(response, 'Unexpected paid request');
    return typeof response === 'function' ? response(body) : response;
  };
  const result = await withDurableRun({ recoveryDirectory: join(root, 'recovery'), operation: async () => {},
    context: async (_scope, snapshot) => { saved = JSON.parse(snapshot); },
  }, () => runHarness({ runId, taskId: runId, workspacePath: workspace, permission: 'workspace-write', language: 'en',
    provider: { ...provider, models: [{ ...provider.models[0], contextWindow: 256000 }] }, modelId: 'fixture',
    messages: [{ role: 'user', content: 'Save a draft and explain what remains. Preserve KEEP_CONSTRAINT.' }],
    signal: AbortSignal.timeout(20000), requestApproval: async () => ({ approved: true }),
    onEvent: event => events.push(event), ...extra,
  }));
  return { result, events, bodies, workspace, saved };
}
function finalAnswer(body) {
  assert.equal(body.tools, undefined); assert.equal(body.tool_choice, undefined);
  assert.ok(body.messages.some(message => message.content.includes('KEEP_CONSTRAINT')));
  assert.ok(!body.messages.some(message => message.tool_calls || message.role === 'tool' || message.reasoning_content || message.aporiaNative));
  assert.match(body.messages.at(-2).content, /Do not call tools/);
  return sse({ content: 'The draft is saved; the remaining check could not finish.' });
}
function assertDelivered(run, requests) {
  assert.equal(run.bodies.length, requests);
  assert.equal(run.result.status, 'partial'); assert.equal(run.result.error, false);
  assert.equal(run.result.replyDelivered, true); assert.equal(hasTaskReply(run.result), true);
  assert.match(run.result.content, /remaining check/);
  assert.ok(run.result.runIssues.length);
  assert.ok(!run.events.some(event => event.type === 'turn.failed'));
  assert.ok(run.events.some(event => event.type === 'turn.completed' && event.replyDelivered));
  assert.equal(run.saved.finalReplyRecovery.attempted, true);
  assert.ok(run.saved.conversation.some(message => message.role === 'assistant' && message.content?.includes('remaining check')));
  assert.notEqual(run.result.selfCheck.verificationPassed, true);
}
try {
  let runResult = await run([sse({ content: '' }), finalAnswer]);
  assertDelivered(runResult, 2);
  runResult = await run([sse({ content: '' }), tools(call('optional-final-wrapper', 'finish_task', {
    summary: 'The remaining check needs another dependency.', details: 'More useful context.',
  }))]);
  assertDelivered(runResult, 2);
  assert.equal(runResult.result.deliveryDetails, 'More useful context.');
  const broken = () => sse({ tool_calls: [{ index: 0, id: 'bad', type: 'function', function: { name: 'write_file', arguments: '{"path":"never.txt",' } }] }, 'tool_calls');
  runResult = await run([broken(), broken(), finalAnswer]);
  assertDelivered(runResult, 3);
  assert.equal(runResult.result.changes.length, 0, 'Malformed calls never execute');

  runResult = await run([
    tools(call('plan', 'update_plan', { steps: [{ title: 'Save draft', status: 'in_progress' }, { title: 'Check draft', status: 'pending' }] })),
    tools(call('write', 'write_file', { path: 'draft.txt', content: 'CONFIRMED_DRAFT' })),
    () => { throw Object.assign(new Error('Fixture interrupted runtime path'), { code: 'FIXTURE_RUNTIME_ERROR' }); },
    finalAnswer,
  ]);
  assertDelivered(runResult, 4);
  assert.equal(await readFile(join(runResult.workspace, 'draft.txt'), 'utf8'), 'CONFIRMED_DRAFT');
  assert.equal(runResult.result.steps.filter(step => step.name === 'write_file').length, 1);
  assert.equal(runResult.result.plan.steps.filter(step => step.status === 'completed').length, 0, 'A reply does not complete remaining work');
  assert.equal(runResult.result.witness.status, 'partial');

  for (const status of [401, 403, 429]) {
    const response = new Response(JSON.stringify({ error: { message: 'Not permitted', code: status === 429 ? 'insufficient_quota' : 'denied' } }), { status });
    runResult = await run([response]);
    assert.equal(runResult.bodies.length, 1); assert.equal(runResult.result.replyDelivered, false);
  }
  for (const error of [{ noAutomaticRetry: true }, { safeToRepair: false }, { code: 'RUN_PERSISTENCE_FAILED' }, { code: 'CLOUD_REQUEST_RECONCILIATION_REQUIRED' }, { name: 'AbortError' }]) {
    assert.equal(canRequestErrorReply(error), false);
  }
  runResult = await run([sse({ content: '' }), sse({ content: '' })]);
  assert.equal(runResult.bodies.length, 2, 'Empty recovery never loops');
  assert.equal(runResult.result.replyDelivered, false);

  const controller = new AbortController();
  runResult = await run([sse({ content: '' }), () => { controller.abort(); controller.signal.throwIfAborted(); }], { signal: controller.signal });
  assert.equal(runResult.result.status, 'interrupted');

  let finalReceived = false;
  runResult = await run([() => { finalReceived = true; return sse({ content: 'The useful final answer.' }); }], {
    onContextCheckpoint: async () => { if (finalReceived) throw Object.assign(new Error('Fixture disk full'), { code: 'RUN_PERSISTENCE_FAILED' }); },
  });
  assert.equal(runResult.bodies.length, 1, 'An existing final answer is not regenerated');
  assert.equal(runResult.result.error, false); assert.equal(runResult.result.replyDelivered, true);
  assert.match(runResult.result.content, /useful final answer/); assert.match(runResult.result.content, /could not be saved/);
  assert.equal(runResult.result.persistence.failed, true);

  const kept = preserveDeliveredReply({ status: 'failed', error: true, replyDelivered: true, content: 'Actual final answer.' }, { code: 'SAVE_ERROR' }, 'Record could not be saved.');
  assert.equal(kept.error, false); assert.equal(kept.status, 'blocked'); assert.equal(hasTaskReply(kept), true);
  assert.equal(preserveDeliveredReply({ status: 'failed', error: true, replyDelivered: false, content: 'Raw error only.' }, {}), null);

  const journal = join(root, 'journal');
  let runtimeDirectory = journal;
  const runtime = createHarnessTaskRuntime({ dataDirectory: () => runtimeDirectory });
  try {
    const result = await runtime.start({ runId: 'storage-after-reply', taskId: 'storage-task', execute: async () => {
      runtimeDirectory = ''; // A final-journal failure, after a valid model reply already exists.
      return { status: 'partial', error: false, replyDelivered: true, content: 'The final answer survives journal failure.', changes: [] };
    } });
    assert.equal(result.error, false); assert.equal(result.replyDelivered, true);
    assert.equal(result.persistence.failed, true); assert.match(result.content, /survives journal failure/);
  } finally { await closeRunJournalStore(journal); }
  console.log('PASS reply-first recovery: empty/broken responses, one tools-disabled final answer, saved work, honest plans, auth/quota/billing boundaries, interruption, and final answer retained on storage failure.');
} finally {
  globalThis.fetch = originalFetch;
  const target = relative(parent, resolve(root));
  assert.ok(target.startsWith('aporiax-final-reply-') && !target.includes(sep));
  await rm(root, { recursive: true, force: true });
}
