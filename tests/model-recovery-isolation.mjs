import assert from 'node:assert/strict';
import { createRunControl } from '../electron/runtime/run-control.js';
import { retryModelResponseRecovery, waitForModelRecovery } from '../electron/runtime/model-response-recovery.js';
import { completeLoopRequest } from '../electron/runtime/loop-recovery.js';
import { withDurableRun } from '../electron/runtime/durable-run.js';
import { createTokenAccounting } from '../electron/agent-context.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await delay(2); }
  assert.fail('Timed out waiting for recovery fixture');
}
let cases = 0;
async function test(name, run) { await run(); console.log('PASS', ++cases, name); }
const exhausted = responseId => ({ modelResponseRecovery: { attempt: 3, responseId } });
function recovery(control, scopeId, extra = {}) {
  const controller = new AbortController();
  const states = [];
  const pending = waitForModelRecovery({ control, scopeId, signal: controller.signal,
    error: exhausted(scopeId), intervalMs: 8, onState: state => states.push(state), ...extra });
  pending.catch(() => {});
  return { controller, states, pending };
}
async function stop(wait) { wait.controller.abort(); await assert.rejects(wait.pending, { name: 'AbortError' }); }

await test('restored exhausted worker waits locally; Main and healthy siblings continue without another paid dispatch', async () => {
  const control = createRunControl(), controller = new AbortController(), checkpoints = [], events = [];
  const scopeId = 'worker-stalled';
  let failedCalls = 0, settled = false;
  const run = { control, checkpoint: c => checkpoints.push(c), requestCheckpoints: {
    ['cloud-request:' + scopeId]: { identity: { clientRequestId: 'original', status: 'sent',
      modelResponseRecovery: { attempt: 3, responseId: 'original-response', receivedModelData: true } } },
  } };
  const args = { conversation: [{ role: 'user', content: 'Fixture' }], contextCheckpoints: [],
    accounting: createTokenAccounting(), contextWindowTokens: 1_000_000,
    getBody: messages => ({ model: 'fixture', messages }) };
  const pending = withDurableRun(run, () => completeLoopRequest({ ...args, scopeId, signal: controller.signal,
    onEvent: e => events.push(e), complete: async () => {
      failedCalls++;
      throw Object.assign(new Error('Original connection ended'), { code: 'CLOUD_REQUEST_RECONCILIATION_REQUIRED',
        partialMessage: { role: 'assistant', content: 'Retained partial output' } });
    },
  })).finally(() => { settled = true; });
  pending.catch(() => {});
  try {
    await until(() => events.some(e => e.state === 'waiting' && e.attempt === 3));
    assert.equal(control.paused, false);
    for (const healthyScope of ['main', 'healthy-worker']) {
      const result = await withDurableRun(run, () => completeLoopRequest({ ...args, scopeId: healthyScope,
        complete: async () => ({ message: { role: 'assistant', content: healthyScope + ' done' }, usage: null }),
      }));
      assert.equal(result.message.content, healthyScope + ' done');
    }
    await delay(30);
    assert.equal(settled, false); assert.equal(failedCalls, 1);
    assert(checkpoints.some(c => c.scopeId === 'incomplete-response:' + scopeId &&
      c.content === 'Retained partial output' && c.recovery.receivedModelData && c.toolCallsExecuted === false));
  } finally { controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); }
  assert.equal(control.paused, false);
  assert.equal(retryModelResponseRecovery(control, scopeId), false, 'cancelled worker removes its retry registration');
  control.abort();
});

await test('cancelled Main recovery clears only its own model pause, retaining user/sleep/network reasons', async () => {
  const control = createRunControl();
  const wait = recovery(control, 'main');
  await until(() => control.paused);
  control.pause('user'); control.suspend(); control.setOnline(false);
  await stop(wait);
  assert.deepEqual(control.snapshot().pauseReasons.sort(), ['network', 'sleep', 'user']);
  assert.equal(retryModelResponseRecovery(control, 'main'), false);
  control.abort();
});

await test('Main recovery does not remove an existing externally owned model-response pause', async () => {
  const control = createRunControl(); control.pause('model-response');
  const wait = recovery(control, 'main');
  await until(() => wait.states.length > 0); await delay(5);
  await stop(wait);
  assert.deepEqual(control.snapshot().pauseReasons, ['model-response']);
  control.abort();
});

await test('multiple Main waiters retain the pause until the last owner is cancelled', async () => {
  const control = createRunControl(); let probes = 0;
  const extra = { error: { ...exhausted('shared-main'), recoverModelConnection: () => { probes++; } } };
  const first = recovery(control, 'main', extra), second = recovery(control, 'main', extra);
  await until(() => first.states.length > 0 && second.states.length > 0); await delay(5);
  await stop(first);
  assert.deepEqual(control.snapshot().pauseReasons, ['model-response']);
  await delay(25); assert.equal(probes, 0, 'cancelling one waiter is not permission to retry the other');
  await stop(second); assert.equal(control.paused, false);
  control.abort();
});

await test('explicit worker continuation rechecks only that worker and only a confirmed no-dispatch receipt can finish', async () => {
  const control = createRunControl(); let firstProbes = 0, secondProbes = 0;
  const first = recovery(control, 'first', { error: { ...exhausted('first-response'), recoverModelConnection: () => {
    firstProbes++; return { safeRetry: true, disposition: 'not-dispatched', requestId: 'first-receipt' };
  } } });
  const second = recovery(control, 'second', { error: { ...exhausted('second-response'), recoverModelConnection: () => { secondProbes++; } } });
  await until(() => first.states.length > 0 && second.states.length > 0); await delay(20);
  assert.equal(firstProbes + secondProbes, 0, 'third exhausted check never restarts automatically');
  assert.equal(retryModelResponseRecovery(control, 'first'), true);
  await until(() => firstProbes > 0);
  assert.equal((await first.pending).requestId, 'first-receipt');
  assert.equal(firstProbes, 1); assert.equal(secondProbes, 0); assert.equal(control.paused, false);
  assert.equal(retryModelResponseRecovery(control, 'first'), false);
  await stop(second); control.abort();
});

await test('local recovery still respects user pause, system sleep and actual network loss', async () => {
  const control = createRunControl(); let probes = 0;
  const wait = recovery(control, 'worker', { error: { ...exhausted('worker'), recoverModelConnection: () => {
    probes++; return { safeRetry: true, disposition: 'not-dispatched' };
  } } });
  await until(() => wait.states.length > 0); await delay(5);
  control.pause('user'); control.suspend(); control.setOnline(false);
  assert.equal(retryModelResponseRecovery(control, 'worker'), true);
  await delay(20); assert.equal(probes, 0);
  control.resume('user'); control.wake(false);
  await delay(20); assert.equal(probes, 0, 'network pause remains authoritative');
  control.setOnline(true);
  await until(() => probes > 0);
  await wait.pending; assert.equal(probes, 1);
  control.abort();
});

await test('partial worker output is not regenerated even when a later receipt contradicts it', async () => {
  const control = createRunControl(); let probes = 0, settled = false;
  const wait = recovery(control, 'partial-worker', { error: {
    modelResponseRecovery: { attempt: 2, receivedModelData: true }, partialMessage: { content: 'Keep me' },
    recoverModelConnection: () => { probes++; return { safeRetry: true, disposition: 'not-dispatched' }; },
  } });
  wait.pending.finally(() => { settled = true; }).catch(() => {});
  await until(() => probes === 1); await delay(20);
  assert.equal(settled, false); assert.equal(control.paused, false);
  await stop(wait); control.abort();
});

await test('cancelling a worker aborts its active recovery probe and ignores its late receipt', async () => {
  const control = createRunControl(); let release, probeSignal;
  const wait = recovery(control, 'cancelled-worker', { error: {
    modelResponseRecovery: { attempt: 2 }, recoverModelConnection: signal => {
      probeSignal = signal; return new Promise(resolve => { release = resolve; });
    },
  } });
  await until(() => release);
  await stop(wait); assert.equal(probeSignal.aborted, true);
  release({ safeRetry: true, disposition: 'not-dispatched' });
  await delay(10);
  assert.equal(control.paused, false);
  assert.equal(retryModelResponseRecovery(control, 'cancelled-worker'), false);
  control.abort();
});

console.log(`PASS ${cases} model recovery isolation cases; no network or real inference used.`);
