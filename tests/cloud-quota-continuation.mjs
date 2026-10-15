import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { completeLoopRequest } from '../electron/runtime/loop-recovery.js';
import { callModelProvider } from '../electron/runtime/provider-stream.js';
import { withDurableRun } from '../electron/runtime/durable-run.js';
import { createRunControl } from '../electron/runtime/run-control.js';
import { createAporiaCloudProvider } from '../electron/provider-config.js';
import { createWitnessMonitor } from '../electron/witness-monitor.js';
import { taskSuspensionLabel } from '../src/state/task-suspension.js';

const clone = v => JSON.parse(JSON.stringify(v));
const frame = v => 'data: ' + JSON.stringify(v) + '\n\n';
const cloud = createAporiaCloudProvider('https://fixture.invalid');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await delay(5); } assert.fail('condition timed out'); }
const history = () => [{ role: 'user', content: 'Keep the saved file' }, { role: 'assistant', tool_calls: [{ id: 'done', type: 'function', function: { name: 'write_file', arguments: '{"path":"mc.html"}' } }] }, { role: 'tool', tool_call_id: 'done', content: 'confirmed file receipt' }];
function fixture(code = 'WEEKLY_QUOTA_EXHAUSTED', extra = {}) {
  const id = randomUUID(), checkpoints = {}, contexts = {}, sent = [], events = [], control = createRunControl();
  let first = true, queries = 0, savedHistory = null;
  const receipt = { requestId: id, usageState: 'not-dispatched', billing: 'released', chargedMicros: 0 };
  const provider = { ...cloud, authenticatedFetch: async (path, init) => {
    if (path.startsWith('/v1/requests/')) { queries++; return Response.json(receipt); }
    sent.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) });
    if (first) { first = false; return Response.json({ error: { message: code }, request: { ...receipt, ...extra }, requestId: id }, { status: 402, headers: { 'x-aporia-request-id': id } }); }
    return new Response(frame({ choices: [{ delta: { content: 'continued' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + 'data: [DONE]\n\n', { headers: { 'x-aporia-request-id': randomUUID() } });
  } };
  const context = { control, checkpoint: cp => { checkpoints[cp.scopeId] = clone(cp); }, context: (scope, value) => { contexts[scope] = JSON.parse(value); } };
  const conversation = history();
  const run = (overrides = {}) => completeLoopRequest({ conversation, contextCheckpoints: [], accounting: {}, getBody: messages => ({ model: 'aporia-cloud-default', messages }),
    complete: (body, signal) => callModelProvider({ provider, body, signal }), persist: () => { savedHistory = clone(conversation); }, onEvent: e => events.push(e), ...overrides });
  return { id, control, checkpoints, contexts, context, provider, sent, events, conversation, run, get queries() { return queries; }, get savedHistory() { return savedHistory; } };
}

for (const code of ['WEEKLY_QUOTA_EXHAUSTED', 'INSUFFICIENT_CREDITS', 'APORIA_PROVIDER_DAILY_BUDGET_EXHAUSTED']) {
  test(code + ' pauses with history and no paid retry until explicit resume', async () => {
    const f = fixture(code), witness = createWitnessMonitor({ control: f.control, heartbeatMs: 0 });
    const reason = code.includes('DAILY') ? 'daily-budget' : 'quota';
    const work = withDurableRun(f.context, () => f.run());
    try {
      await until(() => f.control.paused); await f.control.flush();
      assert.equal(f.sent.length, 1); assert.deepEqual(f.savedHistory, history());
      assert.equal(f.checkpoints['cloud-request:main'].identity.quotaPause.reason, code.includes('DAILY') ? 'daily-budget' : 'quota');
      assert.equal(witness.snapshot().status, 'paused');
      assert.match(taskSuspensionLabel([reason]), /额度/);
      f.control.pause('user'); f.control.resume(reason); await delay(10);
      assert.equal(f.sent.length, 1, 'Quota resume cannot override manual pause');
      f.control.resume('user');
      const result = await work;
      assert.equal(result.message.content, 'continued'); assert.equal(f.queries, 1);
      assert.equal(f.sent.length, 2); assert.deepEqual(f.sent[1].body.messages, f.sent[0].body.messages);
      assert.notEqual(f.sent[0].headers.get('idempotency-key'), f.sent[1].headers.get('idempotency-key'));
      assert.equal(f.sent[1].headers.get('x-aporia-retry-of'), f.id);
      assert.equal(f.checkpoints['cloud-request:main'].identity.quotaPause, undefined);
    } finally { f.control.abort(); witness.dispose(); await work.catch(() => {}); }
  });
}

test('ambiguous accounting is never turned into a quota retry', async () => {
  const f = fixture('WEEKLY_QUOTA_EXHAUSTED', { usageState: 'pending', billing: 'unresolved', chargedMicros: null });
  await assert.rejects(withDurableRun(f.context, () => f.run()), e => e.code === 'WEEKLY_QUOTA_EXHAUSTED');
  assert.equal(f.control.paused, false); assert.equal(f.sent.length, 1); f.control.abort();
});

test('quota pause survives a stopped process and restores before any request', async () => {
  const f = fixture();
  const work = withDurableRun(f.context, () => f.run());
  const stopped = assert.rejects(work, { name: 'AbortError' });
  await until(() => f.control.paused); const saved = clone(f.checkpoints), savedHistory = clone(f.savedHistory);
  f.control.abort(); await stopped;
  const control = createRunControl();
  const resumed = withDurableRun({ ...f.context, control, requestCheckpoints: saved, recoveryContexts: f.contexts }, () => f.run({ conversation: savedHistory }));
  try {
    await until(() => control.paused); assert.equal(f.sent.length, 1);
    control.resume('quota'); assert.equal((await resumed).message.content, 'continued');
    assert.deepEqual(f.sent[1].body.messages, f.sent[0].body.messages); assert.equal(f.queries, 1);
  } finally { control.abort(); await resumed.catch(() => {}); }
});

for (const policy of ['legacy-cap', 'actual-usage-v1']) for (const tools of [false, true]) test('quota truncation preserves progress without doubling or partial tools: ' + policy + '/' + tools, async () => {
  const f = fixture(); let posts = 0;
  const normalFetch = f.provider.authenticatedFetch;
  f.provider.authenticatedFetch = async (path, init) => {
    if (++posts > 1) return normalFetch(path, init); // Replaced below before resume.
    f.sent.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) });
    const delta = tools ? { tool_calls: [{ index: 0, id: 'unsafe', function: { name: 'write_file', arguments: '{"path":' } }] } : { content: 'saved partial answer' };
    const billing = { requestId: f.id, billing: 'settled', usageState: 'provider', chargedMicros: 20,
      ...(policy === 'legacy-cap' ? { admission: { effectiveOutputTokens: 20, requestedOutputTokens: 65536, limitReason: 'quota' } }
        : { quota: { policy, remainingMicros: -10, exhausted: true, source: 'weekly' } }) };
    return new Response(frame({ choices: [{ delta, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 20 } }) + frame(billing) + 'data: [DONE]\n\n', { headers: { 'x-aporia-request-id': f.id } });
  };
  const work = withDurableRun(f.context, () => f.run());
  try {
    await until(() => f.control.paused); assert.equal(posts, 1);
    assert.equal(f.checkpoints['incomplete-response:main'].toolCallsExecuted, false);
    assert.equal(f.conversation.filter(m => m.tool_calls).length, 1);
    if (!tools) assert(f.conversation.some(m => m.content === 'saved partial answer'));
    f.provider.authenticatedFetch = async (_path, init) => {
      f.sent.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) });
      return new Response(frame({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    };
    f.control.resume('quota'); assert.equal((await work).message.content, 'done');
    assert.equal(f.sent.length, 2); assert.equal(f.sent[1].body.max_tokens, f.sent[0].body.max_tokens);
    assert.equal(f.sent[1].headers.get('x-aporia-retry-of'), f.id);
  } finally { f.control.abort(); await work.catch(() => {}); }
});

function settledOverdraft(f, tools = false) {
  return async (_path, init) => {
    f.sent.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) });
    const delta = tools ? { tool_calls: [{ index: 0, id: 'next', function: { name: 'write_file', arguments: '{"path":"next.html"}' } }] } : { content: 'confirmed completed output' };
    return new Response(frame({ choices: [{ delta, finish_reason: tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } }) +
      frame({ requestId: f.id, billing: 'settled', usageState: 'provider', chargedMicros: 30,
        quota: { policy: 'actual-usage-v1', remainingMicros: -20, exhausted: true, source: 'credits' } }) + 'data: [DONE]\n\n',
      { headers: { 'x-aporia-request-id': f.id } });
  };
}
for (const tools of [false, true]) test('settled overdraft preserves response and pauses before tool delivery: ' + tools, async () => {
  const f = fixture(); f.provider.authenticatedFetch = settledOverdraft(f, tools);
  let delivered = false;
  const work = withDurableRun(f.context, () => f.run()).then(result => { delivered = true; return result; });
  try {
    await until(() => f.control.paused); await f.control.flush();
    assert.equal(delivered, false); assert.equal(f.sent.length, 1);
    assert.deepEqual(f.savedHistory, history()); assert.deepEqual(f.control.snapshot().pauseReasons, ['quota']);
    assert(f.contexts['cloud-response:main'].result.streamComplete);
    assert.equal(f.checkpoints['cloud-request:main'].identity.quotaPause.afterResponse, true);
    f.control.resume('quota'); const result = await work;
    assert.equal(f.sent.length, 1, 'Resume consumes the saved response, not another paid generation');
    assert.equal(f.checkpoints['cloud-request:main'].identity.quotaResponseAcknowledged, true);
    if (tools) assert.equal(result.message.tool_calls[0].id, 'next');
    else assert.equal(result.message.content, 'confirmed completed output');
  } finally { f.control.abort(); await work.catch(() => {}); }
});

test('overdraft response and pause survive restart without recharging or losing the completed output', async () => {
  const f = fixture(); f.provider.authenticatedFetch = settledOverdraft(f);
  const work = withDurableRun(f.context, () => f.run()); const stopped = assert.rejects(work, { name: 'AbortError' });
  await until(() => f.control.paused); const saved = clone(f.checkpoints), contexts = clone(f.contexts), savedHistory = clone(f.savedHistory);
  f.control.abort(); await stopped;
  const control = createRunControl();
  f.provider.authenticatedFetch = async () => { assert.fail('Restart must reuse the paid, durable response'); };
  const resumed = withDurableRun({ ...f.context, control, requestCheckpoints: saved, recoveryContexts: contexts }, () => f.run({ conversation: savedHistory }));
  try {
    await until(() => control.paused); control.resume('quota');
    assert.equal((await resumed).message.content, 'confirmed completed output'); assert.equal(f.sent.length, 1);
  } finally { control.abort(); await resumed.catch(() => {}); }
});

test('provider-wide risk wait is distinct from personal quota and never starts an HTTP retry burst', async () => {
  const f = fixture('PROVIDER_BUDGET_TEMPORARILY_HELD'), work = withDurableRun(f.context, () => f.run());
  try {
    await until(() => f.control.paused); assert.deepEqual(f.control.snapshot().pauseReasons, ['provider-budget-wait']);
    assert.match(taskSuspensionLabel(['provider-budget-wait']), /全站/);
    assert.equal(f.sent.length, 1); f.control.resume('provider-budget-wait');
    assert.equal((await work).message.content, 'continued'); assert.equal(f.sent.length, 2);
  } finally { f.control.abort(); await work.catch(() => {}); }
});

test('a mismatched or unresolved receipt cannot trigger a settled-overdraft pause', async () => {
  for (const extra of [{ requestId: randomUUID() }, { billing: 'unresolved', usageState: 'pending' }]) {
    const f = fixture();
    f.provider.authenticatedFetch = async () => new Response(frame({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) +
      frame({ requestId: f.id, billing: 'settled', usageState: 'provider', ...extra,
        quota: { policy: 'actual-usage-v1', remainingMicros: -20, exhausted: true } }) + 'data: [DONE]\n\n', { headers: { 'x-aporia-request-id': f.id } });
    const result = await callModelProvider({ provider: f.provider, body: { model: 'aporia-cloud-default', messages: history() } });
    assert.equal(result.cloudQuota, undefined); f.control.abort();
  }
});

test('temporary occupied quota retries automatically after the wait, not an HTTP retry burst', { timeout: 40_000 }, async () => {
  const f = fixture('QUOTA_TEMPORARILY_HELD'); const work = withDurableRun(f.context, () => f.run());
  try {
    await until(() => f.control.paused); assert.deepEqual(f.control.snapshot().pauseReasons, ['quota-wait']);
    await delay(50); assert.equal(f.sent.length, 1);
    assert.equal((await work).message.content, 'continued'); assert.equal(f.sent.length, 2);
  } finally { f.control.abort(); await work.catch(() => {}); }
});
