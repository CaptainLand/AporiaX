import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createCloudModelQueue } from '../electron/account/cloud-model-queue.js';
import { createAporiaCloudProvider } from '../electron/provider-config.js';
import { compileProviderWire } from '../electron/runtime/native-provider-codec.js';
import { completeLoopRequest } from '../electron/runtime/loop-recovery.js';
import { callModelProvider } from '../electron/runtime/provider-stream.js';
import { modelOutputBudget } from '../electron/runtime/output-budget.js';
import { withDurableRun } from '../electron/runtime/durable-run.js';
import { createWitnessMonitor } from '../electron/witness-monitor.js';
import { describeRouteRecord, activityRecordStatus } from '../src/conversation/route-activity-model.js';
const cloud = createAporiaCloudProvider('https://fixture.invalid');
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const response = (delta, reason = 'stop', done = true) => new Response(frame({ choices: [{ delta, finish_reason: reason }], usage: { prompt_tokens: 100, completion_tokens: 20 } }) + (done ? 'data: [DONE]\n\n' : ''), { headers: { 'x-aporia-request-id': randomUUID() } });
const conversation = () => [{ role: 'user', content: 'Keep confirmed work' }, { role: 'assistant', reasoning_content: 'retained protocol state', tool_calls: [{ id: 'confirmed', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }, { role: 'tool', tool_call_id: 'confirmed', content: 'confirmed evidence' }];
const messages = conversation();
const body = { model: 'aporia-cloud-default', messages, reasoning_effort: 'high' };
const run = (provider, options = {}) => completeLoopRequest({ conversation: conversation(), contextCheckpoints: [], accounting: {}, getBody: messages => ({ ...body, messages }), complete: (body, signal) => callModelProvider({ provider, body, signal }), ...options });

test('managed Cloud preserves DeepSeek tool reasoning exactly; other protocols strip it', () => {
  assert.equal(compileProviderWire(cloud, body).body.messages[1].reasoning_content, 'retained protocol state');
  assert.equal(compileProviderWire({ ...cloud, kind: 'custom', vendor: 'openai' }, body).body.messages[1].reasoning_content, undefined);
  assert.equal(compileProviderWire(cloud, { ...body, model: 'unrelated' }).body.messages[1].reasoning_content, undefined);
  assert.equal(compileProviderWire({ ...cloud, kind: 'custom', vendor: 'deepseek' }, body).body.messages[1].reasoning_content, 'retained protocol state');
});
test('mode defaults match direct API; explicit ceilings remain ceilings', () => {
  assert.equal(modelOutputBudget(cloud, { ...body, reasoning_effort: 'none' }).limit, 8192);
  assert.equal(modelOutputBudget(cloud, body).limit, 65536);
  assert.equal(modelOutputBudget(cloud, { ...body, reasoning_effort: 'max' }).limit, 131072);
  assert.equal(modelOutputBudget(cloud, { ...body, max_tokens: 1234 }).maximum, 1234);
});
for (const delta of [{ reasoning_content: 'reasoning only' }, { tool_calls: [{ index: 0, id: 'broken', function: { name: 'write_file', arguments: '{"path":' } }] }]) {
  test(`one safe repair for ${delta.tool_calls ? 'truncated tools' : 'reasoning-only truncation'} retains confirmed history`, async () => {
    const sent = [], failedUsage = [];
    const provider = { ...cloud, authenticatedFetch: async (_, init) => {
      sent.push({ headers: new Headers(init.headers), body: JSON.parse(init.body) });
      return sent.length === 1 ? response(delta, 'length') : response({ content: 'done' });
    } };
    const result = await run(provider, { onFailedUsage: usage => failedUsage.push(usage) });
    assert.equal(result.message.content, 'done'); assert.equal(sent.length, 2);
    assert.equal(sent[1].body.max_tokens, 131072);
    assert.notEqual(sent[0].headers.get('idempotency-key'), sent[1].headers.get('idempotency-key'));
    assert.match(sent[1].headers.get('x-aporia-retry-of'), /^[0-9a-f-]{36}$/);
    assert.equal(sent[1].body.messages.filter(m => m.tool_calls).length, 1);
    assert.equal(sent[1].body.messages.find(m => m.tool_calls)?.tool_calls[0].id, 'confirmed');
    assert(sent[1].body.messages.some(m => m.content === 'confirmed evidence'));
    assert.equal(failedUsage.length, 1); assert.equal(failedUsage[0].completion_tokens, 20);
  });
}
test('second truncation fails without a third paid call', async () => {
  let posts = 0;
  await assert.rejects(run({ ...cloud, authenticatedFetch: async () => { posts++; return response({ reasoning_content: 'still thinking' }, 'length'); } }), e => e.code === 'PROVIDER_FINISH_LENGTH');
  assert.equal(posts, 2);
});
test('Cloud EOF without settled DONE is never repaired', async () => {
  let posts = 0;
  await assert.rejects(run({ ...cloud, authenticatedFetch: async () => { posts++; return response({ reasoning_content: 'partial' }, 'length', false); } }), e => e.code === 'PROVIDER_STREAM_INCOMPLETE');
  assert.equal(posts, 1);
});
test('consumed repair budget survives restart before the repair request', async () => {
  const saved = {}, conv = conversation(); let posts = 0, interrupted = false;
  const provider = { ...cloud, authenticatedFetch: async () => { posts++; return response({ reasoning_content: 'partial' }, 'length'); } };
  const result = await withDurableRun({ checkpoint: async c => { saved[c.scopeId] = structuredClone(c); } }, () => run(provider, {
    conversation: conv, persist: async () => { interrupted = true; }, shouldYield: () => interrupted,
  }));
  assert.equal(result.interrupted, true); assert.equal(posts, 1);
  assert.equal(saved['cloud-request:main'].identity.repairCount, 1);
  await assert.rejects(withDurableRun({ requestCheckpoints: structuredClone(saved), checkpoint: async () => {} }, () => run(provider, { conversation: conv })), e => e.code === 'PROVIDER_FINISH_LENGTH');
  assert.equal(posts, 2);
});
test('released upstream tool-protocol error repairs once using confirmed receipts', async () => {
  let posts = 0; const id = randomUUID();
  const provider = { ...cloud, authenticatedFetch: async () => {
    posts++;
    return posts === 1 ? new Response(JSON.stringify({ error: { message: 'APORIA_TOOL_PROTOCOL_INVALID' }, request: { requestId: id, usageState: 'not-dispatched', billing: 'released', chargedMicros: 0 } }), { status: 400, headers: { 'x-aporia-request-id': id } }) : response({ content: 'done' });
  } };
  assert.equal((await run(provider)).message.content, 'done'); assert.equal(posts, 2);
});
test('queue holds slots through body consumption and maintains FIFO for six requests', async () => {
  const queue = createCloudModelQueue(), started = [], events = [];
  const calls = Array.from({ length: 6 }, (_, i) => queue.run(async () => { started.push(i); return new Response('ok'); }, { getLimits: () => ({ perUser: 2, perDevice: 2, global: 4 }), onQueue: e => events.push(e) }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1]); assert.deepEqual(queue.snapshot(), { active: 2, queued: 4 });
  for (let i = 0; i < calls.length; i++) assert.equal(await (await calls[i]).text(), 'ok');
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]); assert.deepEqual(queue.snapshot(), { active: 0, queued: 0 });
  assert.equal(events.filter(e => e.state === 'queued').length, 4);
});
test('queue cancellation never calls fetch and cancellation/error releases slots', async () => {
  const queue = createCloudModelQueue(), signal = new AbortController(); let calls = 0;
  const options = { getLimits: () => ({ perUser: 1 }) };
  const first = await queue.run(async () => new Response('held'), options);
  const second = queue.run(async () => { calls++; return new Response('wrong'); }, { ...options, signal: signal.signal });
  signal.abort(); await assert.rejects(second, { name: 'AbortError' }); assert.equal(calls, 0);
  await first.body.cancel(); assert.equal(queue.snapshot().active, 0);
  await assert.rejects(queue.run(async () => { throw new Error('network'); }, options), /network/);
  assert.equal(queue.snapshot().active, 0);
});
test('upstream queue frames become explicit Witness records, not thinking or approvals', async () => {
  const monitor = createWitnessMonitor({ heartbeatMs: 0 }), events = [];
  monitor.observe({ type: 'turn.started' }); monitor.observe({ type: 'response.reset' });
  const provider = { ...cloud, authenticatedFetch: async () => new Response(frame({ aporiaQueue: { state: 'queued', perUser: 2 } }) + frame({ aporiaQueue: { state: 'admitted', waitedMs: 20 } }) + frame({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n') };
  await callModelProvider({ provider, body, onEvent: e => {
    events.push(e); monitor.observe(e);
    if (e.type === 'response.cloud.queued') {
      const record = monitor.snapshot().records.find(r => r.kind === 'queue');
      assert.equal(activityRecordStatus(record), '排队中'); assert.equal(describeRouteRecord(record).title, '等待 Cloud 模型槽位');
    }
  } });
  assert.equal(events.filter(e => e.type === 'response.cloud.queued').length, 1);
  assert.equal(monitor.snapshot().records.find(r => r.kind === 'queue').status, 'completed'); monitor.dispose();
});
