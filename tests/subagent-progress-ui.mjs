import assert from 'node:assert/strict';
import { createWitnessMonitor } from '../electron/witness-monitor.js';
import { applyProfessionalAgentEvent } from '../src/conversation/professional-agent-events.js';
import { agentDelivery } from '../src/conversation/agent-delivery-model.js';
import { describeRouteRecord } from '../src/conversation/route-activity-model.js';
import { createRunControl } from '../electron/runtime/run-control.js';
import { completeLoopRequest } from '../electron/runtime/loop-recovery.js';
import { retryModelResponseRecovery } from '../electron/runtime/model-response-recovery.js';
import { currentLoopRequestIdentity, rememberModelResponseRecovery } from '../electron/runtime/cloud-request-identity.js';
import { withDurableRun } from '../electron/runtime/durable-run.js';
import { createTokenAccounting } from '../electron/agent-context.js';

let now = 1000;
const monitor = createWitnessMonitor({ heartbeatMs: 0, now: () => now });
let rows = [];
const emit = event => { now += 600; monitor.observe(event); rows = applyProfessionalAgentEvent(rows, event); };
const records = () => monitor.snapshot().records;
try {
  emit({ type: 'turn.started' }); emit({ type: 'response.reset' });
  emit({ type: 'response.progress', stage: 'text', outputTokens: 11, outputTokensEstimated: false });
  for (const agentId of ['a', 'b']) emit({ type: 'subagent.started', agentId, role: 'explore', task: 'Read code' });
  emit({ type: 'subagent.response.progress', agentId: 'a', stage: 'receiving', outputTokens: 123, outputTokensEstimated: true });
  emit({ type: 'subagent.response.progress', agentId: 'b', stage: 'text', outputTokens: 321, outputTokensEstimated: false });
  const a = records().find(r => r.agentId === 'a' && r.kind === 'agent');
  assert.equal(a.modelProgress.outputTokens, 123);
  assert.equal(records().find(r => r.agentId === 'b' && r.kind === 'agent').modelProgress.outputTokens, 321);
  assert.equal(records().find(r => r.kind === 'thinking' && !r.agentId).modelProgress.outputTokens, 11);
  assert.match(describeRouteRecord(a).detail, /↓ ≈123 Token/);
  emit({ type: 'subagent.response.recovery.status', agentId: 'a', responseId: 'request-a', state: 'waiting', attempt: 3, connection: 'closed' });
  assert.equal(agentDelivery(rows.find(r => r.agentId === 'a')).status, '等待恢复');
  assert.equal(agentDelivery(rows.find(r => r.agentId === 'b')).status, '工作中');
  assert.equal(monitor.snapshot().status, 'running');
  emit({ type: 'subagent.response.recovery.status', agentId: 'a', responseId: 'request-a', state: 'receiving', attempt: 0 });
  assert.equal(records().find(r => r.agentId === 'a' && r.kind === 'agent').status, 'running', 'Recovery is not worker completion');
  assert.equal(rows.find(r => r.agentId === 'a').modelRecovery, null);
  emit({ type: 'subagent.response.recovery.status', agentId: 'a', responseId: 'request-a', state: 'waiting', attempt: 3, connection: 'closed' });
  emit({ type: 'subagent.cancelled', agentId: 'a' });
  emit({ type: 'subagent.response.recovery.status', agentId: 'a', responseId: 'request-a', state: 'waiting', attempt: 3, connection: 'closed' });
  assert.equal(rows.find(r => r.agentId === 'a').modelRecovery, null);
  const stopped = records().find(r => r.agentId === 'a' && r.kind === 'agent');
  assert.equal(stopped.status, 'interrupted'); assert(!stopped.modelRecovery);
  console.log('PASS separate Main/member progress, output-only tokens, member recovery/resume/cancellation without phantom completion');
} finally { monitor.dispose(); }

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await delay(2); }
  assert.fail('Recovery transition fixture timed out');
}

// Exercise the actual recovery/identity loop. A confirmed no-dispatch receipt
// allows another request; it is not a receiving-data event and must not leave
// the old closed-connection banner attached to the new inference.
for (const scopeId of ['main', 'worker']) for (const transport of ['closed', 'open-safe-retry']) {
  const control = createRunControl(), controller = new AbortController();
  const witness = createWitnessMonitor({ heartbeatMs: 0, control });
  const events = [];
  let workers = [], requests = 0;
  const observe = event => { events.push(event); witness.observe(event); workers = applyProfessionalAgentEvent(workers, event); };
  const scoped = event => observe(scopeId === 'main' ? event : { ...event, type: 'subagent.' + event.type, agentId: scopeId, role: 'explore' });
  observe({ type: 'turn.started' }); observe({ type: 'response.reset' });
  for (const agentId of ['worker', 'unrelated']) observe({ type: 'subagent.started', agentId, role: 'explore' });
  observe({ type: 'subagent.response.recovery.status', agentId: 'unrelated', responseId: 'untouched', state: 'waiting', attempt: 3, connection: 'closed' });
  const scopeRecords = () => witness.snapshot().records.filter(record => scopeId === 'main' ? !record.agentId : record.agentId === scopeId);
  const pending = withDurableRun({ control }, () => completeLoopRequest({
    scopeId, signal: controller.signal, conversation: [{ role: 'user', content: 'Fixture' }], contextCheckpoints: [],
    accounting: createTokenAccounting(), contextWindowTokens: 128_000, getBody: messages => ({ messages }), onEvent: scoped,
    complete: async () => {
      requests++;
      if (requests === 1) {
        const state = { attempt: 3, responseId: 'old-response', state: 'waiting', connection: transport === 'closed' ? 'closed' : 'open' };
        if (transport === 'open-safe-retry') {
          await rememberModelResponseRecovery(currentLoopRequestIdentity(), state);
          scoped({ type: 'response.recovery.status', ...state });
          throw Object.assign(Error('Confirmed no dispatch'), { code: 'MODEL_RESPONSE_SAFE_RETRY', safeToRepair: true });
        }
        throw Object.assign(Error('Connection ended'), { modelResponseRecovery: state,
          recoverModelConnection: async () => ({ safeRetry: true, disposition: 'not-dispatched' }) });
      }
      assert.equal(requests, 2, 'only one confirmed-safe successor request');
      const reset = events.find(event => event.phase === 'model-response-safe-retry');
      assert.equal(reset?.responseId, 'old-response');
      assert.equal(reset.type, scopeId === 'main' ? 'response.reset' : 'subagent.response.reset');
      assert(!events.some(event => event.type.endsWith('response.recovery.status') && event.state === 'receiving'),
        'resetting a request must not manufacture evidence of received model data');
      assert(scopeRecords().every(record => !record.modelRecovery));
      assert(scopeRecords().every(record => record.status !== 'waiting'), 'the old request cannot remain pending');
      if (scopeId === 'worker') {
        assert.equal(agentDelivery(workers.find(worker => worker.agentId === scopeId)).status, '工作中');
        assert.equal(workers.find(worker => worker.agentId === scopeId).modelProgress, null);
      }
      assert.equal(agentDelivery(workers.find(worker => worker.agentId === 'unrelated')).status, '等待恢复');
      scoped({ type: 'response.progress', stage: 'text', outputTokens: 55, outputTokensEstimated: false });
      const active = scopeRecords().find(record => record.status === 'running' && ['agent', 'thinking'].includes(record.kind));
      assert.equal(active.modelProgress.outputTokens, 55); assert(!active.modelRecovery);
      return { message: { content: 'Recovered report.' } };
    },
  }));
  // Timers are deliberately unref'ed in production; the fixture's bounded wait
  // also keeps this isolated Node process alive until the retry probe completes.
  let finished = false;
  pending.finally(() => { finished = true; }).catch(() => {});
  try {
    if (transport === 'closed') {
      await until(() => events.some(event => event.responseId === 'old-response' && event.state === 'waiting'));
      await delay(5);
      assert.equal(retryModelResponseRecovery(control, scopeId), true);
    }
    await until(() => finished);
    assert.equal((await pending).message.content, 'Recovered report.');
    assert.equal(requests, 2);
  } finally { controller.abort(); control.abort(); witness.dispose(); }
  console.log(`PASS ${scopeId} ${transport}: receipt-backed new request resets only its own recovery presentation`);
}

// A contradictory no-dispatch receipt still cannot replay partially received
// model output, nor may its UI reset imply that another request was started.
{
  const control = createRunControl(), controller = new AbortController(), events = [];
  let requests = 0, probes = 0;
  const pending = withDurableRun({ control }, () => completeLoopRequest({ scopeId: 'partial-worker', signal: controller.signal,
    conversation: [{ role: 'user', content: 'Fixture' }], contextCheckpoints: [], accounting: createTokenAccounting(),
    contextWindowTokens: 128_000, getBody: messages => ({ messages }), onEvent: event => events.push(event),
    complete: async () => {
      requests++;
      throw Object.assign(Error('Partial connection ended'), {
        modelResponseRecovery: { attempt: 3, responseId: 'partial-response', receivedModelData: true },
        partialMessage: { content: 'Retain this partial output.' },
        recoverModelConnection: async () => { probes++; return { safeRetry: true, disposition: 'not-dispatched' }; },
      });
    },
  }));
  pending.catch(() => {});
  try {
    await until(() => events.some(event => event.state === 'waiting')); await delay(5);
    assert.equal(retryModelResponseRecovery(control, 'partial-worker'), true);
    await until(() => probes === 1); await delay(5);
    assert.equal(requests, 1);
    assert(!events.some(event => event.type === 'response.reset'));
  } finally { controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); control.abort(); }
  console.log('PASS partial output stays protected: contradictory receipts do not reset UI or redispatch inference');
}
