import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { runHarness } from '../electron/agent-runtime-core.js';
import { createHarnessTaskRuntime } from '../electron/harness/task-runtime.js';
import { closeRunJournalStore } from '../electron/run-store.js';
import { loadTaskContinuation } from '../electron/runtime/retry-continuation.js';
import { taskContinuationRequest } from '../src/state/run-retry-core.js';
import { provider, call, tools, sse } from './goal-loop-fixtures.mjs';

const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'aporiax-continue-retry-'));
const fetch = globalThis.fetch;
try {
  const base = { runId: 'new', taskId: 'task', sourceUserId: 'user', workspacePath: root, recoveryRunId: 'old', retryMode: 'continue' };
  const record = { runId: 'old', taskId: 'task', sourceUserId: 'user', workspacePath: root, status: 'failed' };
  assert.equal(await loadTaskContinuation({}, async () => { throw Error('Not a retry'); }), null);
  await assert.rejects(loadTaskContinuation({ retryMode: 'continue' }, async () => record), /缺少/);
  for (const changed of [{ taskId: 'other' }, { sourceUserId: 'other' }, { workspacePath: join(root, 'other') }]) {
    await assert.rejects(loadTaskContinuation(base, async () => ({ ...record, ...changed })), /另一个|另一条/);
  }
  await assert.rejects(loadTaskContinuation(base, async () => { throw Error('RUN_CONTEXT_CORRUPT'); }), /RUN_CONTEXT_CORRUPT/);
  await assert.rejects(loadTaskContinuation(base, async () => ({ ...record, resumedByRunId: 'old' })), /循环/);
  await assert.rejects(loadTaskContinuation(base, async () => ({ ...record, status: 'completed' })), /已经完成/);
  const latest = await loadTaskContinuation(base, async id => id === 'old' ? { ...record, resumedByRunId: 'latest' } : { ...record, runId: id });
  assert.equal(latest.runId, 'latest');

  for (const externallyChanged of [false, true]) {
    const label = externallyChanged ? 'external' : 'normal';
    const directory = join(root, label), workspace = join(directory, 'workspace');
    await mkdir(workspace, { recursive: true });
    const runtime = createHarnessTaskRuntime({ dataDirectory: directory });
    const taskId = label, user = { id: 'original-user', role: 'user', content: 'Create a game. Preserve FIRST_PHASE_SAVED and finish the remaining interaction only.' };
    const metadata = { workspacePath: workspace, sourceUserId: user.id, assistantId: 'first-answer' };
    let requests = 0;
    globalThis.fetch = async () => {
      switch (++requests) {
        case 1: return tools(call('plan', 'update_plan', { steps: [{ id: 'save', title: 'Save draft', status: 'in_progress' }, { id: 'finish', title: 'Finish remaining interaction', status: 'pending' }] }));
        case 2: return tools(call('write', 'write_file', { path: 'game.html', content: 'FIRST_PHASE_SAVED\n' }));
        case 3: return tools(call('plan2', 'update_plan', { steps: [{ id: 'save', title: 'Save draft', status: 'completed' }, { id: 'finish', title: 'Finish remaining interaction', status: 'in_progress' }] }));
        case 4: return new Response(JSON.stringify({ error: { message: 'Insufficient Balance' } }), { status: 402 });
        default: throw Error('Unexpected provider retry');
      }
    };
    const execute = (runId, recoveryContext, events = []) => ({ signal, control, emit, requestApproval }) => runHarness({
      runId, taskId, provider, modelId: 'fixture', workspacePath: workspace, permission: 'workspace-write', language: 'en',
      messages: [user], recoveryContext, signal, control, requestApproval,
      onEvent: event => { events.push(event); emit(event); },
    });
    const first = await runtime.start({ runId: 'first', taskId, metadata, execute: execute('first') });
    assert.equal(requests, 4); assert.equal(first.status, 'partial');
    const request = { ...taskContinuationRequest({ id: taskId }, { id: 'first-answer', runId: 'first', sourceUserId: user.id }),
      runId: 'continued', sourceUserId: user.id, workspacePath: workspace };
    const recovery = await loadTaskContinuation(request, id => runtime.recoveryContext(id));
    const saved = recovery.contexts.first;
    assert.equal(saved.plan.steps[0].status, 'completed');
    assert(saved.steps.some(step => step.name === 'write_file'));
    assert(saved.conversation.some(message => message.role === 'tool'));
    if (externallyChanged) await writeFile(join(workspace, 'game.html'), 'USER_EDIT_MUST_SURVIVE\n');
    let resumedRequests = 0;
    const events = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      const text = body.messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n');
      assert.match(text, /continuation, NOT a restart/);
      assert.match(text, /perform only the remaining work/);
      assert.match(text, /FIRST_PHASE_SAVED/);
      assert.match(text, /Continuation preflight/);
      assert.match(text, /Save draft/);
      if (++resumedRequests === 1) {
        if (externallyChanged) assert.match(text, /File changed since the saved run/);
        return tools(call('inspect-current', 'read_file', { path: 'game.html' }));
      }
      if (externallyChanged) {
        assert.match(text, /USER_EDIT_MUST_SURVIVE/);
        return sse({ content: 'Existing user edits are preserved. Confirm the changed design before finishing.' });
      }
      if (resumedRequests === 2) return tools(call('remaining-only', 'apply_patch', { patch: '*** Begin Patch\n*** Update File: game.html\n@@\n FIRST_PHASE_SAVED\n+REMAINING_INTERACTION_DONE\n*** End Patch' }));
      return sse({ content: 'Finished the remaining interaction without recreating the game.' });
    };
    const continued = await runtime.start({ runId: 'continued', taskId, metadata: { ...metadata, assistantId: 'continued-answer' }, recoveryContext: recovery,
      execute: execute('continued', recovery, events) });
    assert.equal(continued.error, undefined);
    assert.equal(continued.steps.filter(step => step.name === 'write_file').length, 1, 'Only the inherited write exists; retry must not recreate the output');
    assert(events.some(event => event.type === 'plan.updated' && event.reason === 'task-resumed' && event.plan.steps[0].status === 'completed'));
    assert(!events.some(event => event.type === 'turn.failed'));
    if (externallyChanged) {
      assert.equal(await readFile(join(workspace, 'game.html'), 'utf8'), 'USER_EDIT_MUST_SURVIVE\n');
      assert.equal(continued.changes.length, 0, 'Do not claim the user edit as a restored change');
    } else {
      assert.equal(await readFile(join(workspace, 'game.html'), 'utf8'), 'FIRST_PHASE_SAVED\nREMAINING_INTERACTION_DONE\n');
      assert.equal(continued.changes[0].beforeMissing, true, 'Keep original undo baseline across continuation');
      assert.equal(continued.changes[0].beforeContent, '');
      assert(continued.steps.some(step => step.name === 'write_file' && step.inheritedFromRunId === 'first'));
    }
    await closeRunJournalStore(directory);
  }
  console.log('PASS retry continues durable work: normal failure without restart, saved tool receipts/steps/plan, file preflight, remaining-only patch, original undo baseline, preserved user edits, scoped lineage and no silent restart.');
} finally {
  globalThis.fetch = fetch;
  for (const label of ['normal', 'external']) await closeRunJournalStore(join(root, label));
  const target = relative(parent, resolve(root));
  assert(target.startsWith('aporiax-continue-retry-') && !target.includes(sep));
  await rm(root, { recursive: true, force: true });
}
