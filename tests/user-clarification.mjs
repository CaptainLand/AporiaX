import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClarificationSession, validateClarification, validateClarificationAnswer, clarificationScope, restoreClarificationConversation } from '../electron/runtime/user-clarification.js';
import { createRunControl } from '../electron/runtime/run-control.js';
import { createHarnessTaskRuntime } from '../electron/harness/task-runtime.js';
import { readClarificationLedger, writeClarificationLedger, closeRunJournalStore } from '../electron/run-store.js';
import { clarificationToastCopy } from '../electron/approval-toast-state.js';
import { createWitnessMonitor } from '../electron/witness-monitor.js';
const delay = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(fn) { for (let i = 0; i < 400; i++) { if (fn()) return; await delay(); } assert.fail('Condition timed out'); }
const input = (key = 'audience') => ({ question: 'Which audience? ' + key, reason: 'This changes the deliverable.', uncertainty_key: key,
  options: [{ label: 'Internal', recommended: true }, { label: 'Public' }] });
function fixture(options = {}) {
  let stored = null;
  const control = createRunControl(), abort = new AbortController(), events = [];
  const session = createClarificationSession({ control, signal: abort.signal, runId: 'r', taskId: 't', emit: event => events.push(event),
    persist: async state => { stored = structuredClone(state); }, ...options });
  return { session, control, abort, events, stored: () => stored };
}
let count = 0;
const test = async (name, fn) => { await fn(); console.log('PASS', ++count, name); };
await test('strict schema, meaningful options and explicit answer', async () => {
  const value = validateClarification(input());
  assert.equal(value.options[0].id, '1');
  for (const invalid of [{}, { ...input(), extra: true }, { ...input(), options: [{ label: 'Only' }] },
    { ...input(), options: [{ label: ' A ' }, { label: 'a' }] }, { ...input(), options: [{ label: 'A', recommended: true }, { label: 'B', recommended: true }] }]) {
    assert.throws(() => validateClarification(invalid), /CLARIFICATION_/);
  }
  assert.throws(() => validateClarificationAnswer(value, {}));
  assert.throws(() => validateClarificationAnswer(value, { optionId: 'not-real' }));
  assert.throws(() => validateClarificationAnswer(value, { optionId: '1', text: 'both' }));
  assert.throws(() => validateClarificationAnswer(value, { text: 'x'.repeat(4001) }));
  assert.equal(validateClarificationAnswer(value, { optionId: '1' }).text, 'Internal');
});
await test('persist-before-notify, same-call coalescing, concurrent question rejection and idempotent answer', async () => {
  const f = fixture(), first = f.session.request(input(), 'call'), duplicate = f.session.request(input(), 'call');
  await until(() => f.events.length > 0);
  assert.equal(f.stored().questions[0].status, 'pending');
  assert.equal(f.events.filter(e => e.type === 'clarification.required').length, 1);
  await assert.rejects(f.session.request(input('different'), 'other'), /ALREADY_PENDING/);
  const q = f.session.snapshot()[0];
  f.control.pause('user'); f.control.setOnline(false); f.control.suspend();
  await f.session.respond(q.id, { optionId: '1' });
  assert.equal((await first).answer.text, 'Internal'); assert.equal((await duplicate).answer.text, 'Internal');
  assert.deepEqual(f.control.snapshot().pauseReasons, ['user', 'network', 'sleep']);
  assert.equal((await f.session.respond(q.id, { optionId: '1' })).alreadyAnswered, true);
  await assert.rejects(f.session.request(input('another-topic'), 'call'), /CALL_CONFLICT/);
  await assert.rejects(f.session.respond(q.id, { text: 'different' }), /ALREADY_ANSWERED/);
  f.control.abort();
});
await test('duplicate questions, new-evidence gate and hard budget of two', async () => {
  const f = fixture();
  let request = f.session.request(input(), 'first');
  await until(() => f.session.snapshot().length);
  await f.session.respond(f.session.snapshot()[0].id, { text: 'Internal users' }); await request;
  await assert.rejects(f.session.request(input(), 'duplicate'), /DUPLICATE/);
  await assert.rejects(f.session.request(input('format'), 'second'), /NO_NEW_EVIDENCE/);
  f.session.observeProgress('read_file', { path: 'README.md' }, { error: 'denied' });
  await assert.rejects(f.session.request(input('format'), 'second'), /NO_NEW_EVIDENCE/);
  f.session.observeProgress('read_file', { path: 'README.md' }, { content: 'new evidence' });
  request = f.session.request(input('format'), 'second');
  await until(() => f.session.snapshot().length === 2);
  await f.session.respond(f.session.snapshot()[1].id, { optionId: '2' }); await request;
  f.session.observeProgress('read_file', { path: 'other.md' }, { content: 'more' });
  await assert.rejects(f.session.request(input('third'), 'third'), /LIMIT_REACHED/);
  const restored = fixture({ state: f.stored() });
  await assert.rejects(restored.session.request(input('third'), 'third'), /LIMIT_REACHED/);
  f.control.abort(); restored.control.abort();
});
await test('crash recovery retains pending question; receipt repair is idempotent and preserves human provenance', async () => {
  const f = fixture(), request = f.session.request(input(), 'call').catch(error => error);
  await until(() => f.session.snapshot().length);
  const state = f.stored(); f.abort.abort(); await request; f.control.abort();
  const restored = fixture({ state }), waiting = restored.session.restore();
  await until(() => restored.control.paused);
  assert.equal(restored.session.snapshot()[0].id, state.questions[0].id);
  await restored.session.respond(state.questions[0].id, { text: 'Keep it local' });
  const questions = await waiting;
  const original = [{ role: 'assistant', tool_calls: [{ id: 'call', type: 'function', function: { name: 'request_user_input', arguments: '{}' } }] }];
  const messages = restoreClarificationConversation(original, questions);
  assert.equal(messages[1].role, 'tool'); assert.match(messages[1].content, /Keep it local/);
  assert.equal(messages[2].aporiaSource, 'human'); assert.equal(messages[2].aporiaPinned, true);
  assert.deepEqual(restoreClarificationConversation(messages, questions), messages);
  assert.equal(original.length, 1); restored.control.abort();
});
await test('cancel rejects late answers; persistence failure never emits a usable question', async () => {
  const f = fixture(), request = f.session.request(input(), 'call').catch(error => error);
  await until(() => f.session.snapshot().length);
  await f.session.cancel(); f.abort.abort(); await request;
  await assert.rejects(f.session.respond(f.session.snapshot()[0].id, { text: 'late' }), { name: 'AbortError' });
  assert.equal(f.stored().questions[0].status, 'cancelled');
  const bad = fixture({ persist: async () => { throw new Error('disk full'); } });
  await assert.rejects(bad.session.request(input(), 'call'), /disk full/);
  assert.deepEqual(bad.events, []); assert.equal(bad.control.paused, false);
  f.control.abort(); bad.control.abort();
});
const root = await mkdtemp(join(tmpdir(), 'aporia-clarification-'));
try {
  await test('real SQLite reopen and CAS; original request, not run id, owns budget', async () => {
    const key = clarificationScope({ taskId: 't', sourceUserId: 'u', runId: 'r1' });
    assert.equal(key, clarificationScope({ taskId: 't', sourceUserId: 'u', runId: 'r2' }));
    assert.notEqual(key, clarificationScope({ taskId: 't', sourceUserId: 'new-user-message' }));
    const state = { version: 1, revision: 1, questions: [], progress: [], lastAnswerProgress: 0 };
    await writeClarificationLedger(root, key, state, 0);
    await assert.rejects(writeClarificationLedger(root, key, state, 0), /CONFLICT/);
    await closeRunJournalStore(root);
    assert.deepEqual(await readClarificationLedger(root, key), state);
  });
  await test('runtime IPC ownership, duplicate-run exclusion and retry shares ledger', async () => {
    const runtime = createHarnessTaskRuntime({ dataDirectory: root }); let question;
    const run = runtime.start({ runId: 'live', taskId: 'task', clientId: '10', metadata: { sourceUserId: 'original', assistantId: 'assistant' },
      onEvent: event => { if (event.type === 'clarification.required') question = event.questions[0]; },
      execute: async ({ clarification }) => { const result = await clarification.request(input(), 'live-call'); return { status: 'completed', content: result.answer.text }; } });
    await until(() => question);
    await assert.rejects(runtime.respondClarification('live', question.id, { text: 'wrong sender' }, { clientId: '11' }), /STALE/);
    await assert.rejects(runtime.start({ runId: 'double', taskId: 'task', metadata: { sourceUserId: 'original' }, execute: () => {} }), /already running/);
    await runtime.respondClarification('live', question.id, { text: 'Confirmed by owner' }, { clientId: '10' });
    assert.equal((await run).content, 'Confirmed by owner');
    await runtime.start({ runId: 'retry', taskId: 'task', metadata: { sourceUserId: 'original' }, execute: async ({ clarification }) => {
      assert.equal(clarification.snapshot().length, 1);
      assert.equal(clarification.snapshot()[0].answer.text, 'Confirmed by owner');
      return { status: 'completed' };
    } });
  });
  await test('Witness shows waiting question and answer; toast offers navigation, not approval', async () => {
    const monitor = createWitnessMonitor({ heartbeatMs: 0 });
    monitor.observe({ type: 'clarification.required', questions: [{ id: 'q', status: 'pending', question: 'Which scope?' }] });
    assert.equal(monitor.snapshot().records[0].status, 'waiting');
    monitor.observe({ type: 'clarification.updated', questions: [{ id: 'q', status: 'answered', question: 'Which scope?', answer: { text: 'Local only' } }] });
    assert.equal(monitor.snapshot().records.length, 1);
    assert.match(monitor.snapshot().records[0].detail, /Local only/); monitor.dispose();
    const copy = clarificationToastCopy({ question: 'x'.repeat(500) });
    assert.equal(copy.approve, '去回答'); assert.equal(copy.deny, '稍后'); assert.equal(copy.body.length, 160);
  });
  await test('reopened runtime restores pending before execution and preserves question identity', async () => {
    const key = clarificationScope({ taskId: 'recovery-task', sourceUserId: 'recovery-user' });
    const old = fixture({ persist: (state, revision) => writeClarificationLedger(root, key, state, revision) });
    const lost = old.session.request(input(), 'recover-call').catch(error => error);
    await until(() => old.events.length);
    const originalId = old.session.snapshot()[0].id;
    old.abort.abort(); old.control.abort(); await lost; await closeRunJournalStore(root);
    let restoredQuestion, executed = false;
    const runtime = createHarnessTaskRuntime({ dataDirectory: root });
    const resumed = runtime.start({ runId: 'recovered', taskId: 'recovery-task', metadata: { sourceUserId: 'recovery-user', assistantId: 'reply' },
      onEvent: event => { if (event.type === 'clarification.required') restoredQuestion = event.questions[0]; },
      execute: async ({ clarification }) => { executed = true; assert.equal(clarification.snapshot()[0].answer.text, 'Persistent answer'); return { status: 'completed' }; } });
    await until(() => restoredQuestion);
    assert.equal(restoredQuestion.id, originalId); assert.equal(executed, false);
    const visible = await runtime.listRecoverableRuns();
    assert.equal(visible.find(run => run.runId === 'recovered').clarifications[0].id, originalId);
    await runtime.respondClarification('recovered', originalId, { text: 'Persistent answer' });
    await resumed; assert.equal(executed, true);
  });
} finally { await closeRunJournalStore(root); await rm(root, { recursive: true, force: true }); }
console.log('Clarification lifecycle:', count, 'checks passed.');
