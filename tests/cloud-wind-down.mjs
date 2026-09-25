import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarness } from '../electron/agent-runtime-core.js';
import { TOOL_REGISTRY } from '../electron/runtime/native-tool-catalog.js';
import { createPermissionPolicy } from '../electron/agent-core.js';
import { withDurableRun } from '../electron/runtime/durable-run.js';
import { callModelProvider } from '../electron/runtime/provider-stream.js';
import { completeLoopRequest } from '../electron/runtime/loop-recovery.js';
import { createAporiaCloudProvider } from '../electron/provider-config.js';
import { lowCloudQuota, observeCloudQuota, prepareCloudWindDown, cloudWindDownActive, cloudWorkerDeferral, CLOUD_WIND_DOWN_PROMPT } from '../electron/runtime/cloud-wind-down.js';
import { runSubagentTask } from '../electron/runtime/subagent-loop.js';
import { planAgentBudget, runWithAgentBudget, withAgentBudgetAdmission } from '../electron/harness/agent-budget.js';

const cloud = createAporiaCloudProvider('https://fixture.invalid');
const quota = (remaining = 50, extra = {}) => ({ policy: 'actual-usage-v1', source: 'weekly', remainingMicros: remaining, limitMicros: 1000, exhausted: remaining <= 0, ...extra });
const body = () => ({ model: 'aporia-cloud-default', messages: [{ role: 'system', content: 'Normal task rules.' }, { role: 'user', content: 'Save existing work' }] });
const clone = v => JSON.parse(JSON.stringify(v));
const frame = v => 'data: ' + JSON.stringify(v) + '\n\n';
const hasPrompt = b => JSON.stringify(b.messages).includes('[Aporia Cloud low-quota wind-down]');
function fixture() {
  const contexts = {}, checkpoints = {}, events = [], sent = [];
  const context = { context: (scope, value) => { contexts[scope] = JSON.parse(value); }, checkpoint: cp => { checkpoints[cp.scopeId] = clone(cp); } };
  return { context, contexts, checkpoints, events, sent };
}
const response = (id, q, extra = {}, finishReason = 'stop') => new Response(
  frame({ choices: [{ delta: { content: 'saved work' }, finish_reason: finishReason }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) +
  frame({ requestId: id, billing: 'settled', usageState: 'provider', quota: q, ...extra }) + 'data: [DONE]\n\n',
  { headers: { 'x-aporia-request-id': id } });
function provider(f, q = quota()) {
  return { ...cloud, authenticatedFetch: async (_path, init) => {
    f.sent.push(JSON.parse(init.body)); return response(randomUUID(), q);
  } };
}
const infer = (p, messages = body().messages) => completeLoopRequest({ conversation: messages, contextCheckpoints: [], accounting: {},
  getBody: messages => ({ ...body(), messages }), complete: (body, signal) => callModelProvider({ provider: p, body, signal }) });

test('5% is inclusive and uses settled integer amounts, not rounding or reservations', () => {
  assert(lowCloudQuota(quota(50))); assert(lowCloudQuota(quota(1)));
  for (const value of [quota(51), quota(0), quota(-1), quota(50, { limitMicros: 999 }), quota(50, { limitMicros: 0 }),
    quota(50, { limitMicros: undefined }), quota(50, { exhausted: true }), quota(50, { source: 'credits' }),
    quota(50, { policy: 'legacy' }), quota('50'), null]) assert.equal(Boolean(lowCloudQuota(value)), false);
  assert.equal(lowCloudQuota(quota(100, { availableRatio: 0.01, reservedMicros: 99 })), false);
});

test('parallel settlements latch once and stay active even after quota improves', async () => {
  const f = fixture();
  await withDurableRun(f.context, async () => {
    await Promise.all(Array.from({ length: 6 }, () => observeCloudQuota(quota(), e => f.events.push(e))));
    await observeCloudQuota(quota(1000), e => f.events.push(e));
    assert.equal(f.events.length, 1); assert(cloudWindDownActive(cloud));
  });
  assert.equal(f.contexts['cloud-quota-wind-down'].active, true);
  await withDurableRun({}, () => assert.equal(cloudWindDownActive(cloud), false));
});

test('settled receipt warns the next existing call without adding a paid request or modifying history', async () => {
  const f = fixture(), p = provider(f), messages = body().messages;
  await withDurableRun(f.context, async () => {
    await infer(p, messages); await infer(p, messages); await infer(p, messages);
  });
  assert.equal(f.sent.length, 3); assert.equal(hasPrompt(f.sent[0]), false);
  for (const sent of f.sent.slice(1)) {
    assert(hasPrompt(sent)); assert.equal(JSON.stringify(sent).split('[Aporia Cloud low-quota wind-down]').length, 2);
  }
  assert.deepEqual(messages, body().messages); assert.equal(f.sent[1].max_tokens, f.sent[0].max_tokens);
});

test('initial authenticated quota is read once and applies before the first call', async () => {
  const f = fixture(); let reads = 0;
  const p = { ...provider(f), getCloudQuota: async () => { reads++; return quota(); } };
  await withDurableRun(f.context, async () => { await infer(p); await infer(p); });
  assert.equal(reads, 1); assert.equal(f.sent.length, 2); assert(f.sent.every(hasPrompt));
});

test('failed or legacy initial metadata does not block work or invent a low-quota warning', async () => {
  for (const read of [async () => { throw new Error('offline advisory read'); }, async () => ({ remainingRatio: 0.01 })]) {
    const f = fixture(), p = { ...provider(f, undefined), getCloudQuota: read };
    await withDurableRun(f.context, () => infer(p)); assert.equal(hasPrompt(f.sent[0]), false);
  }
});

test('mismatched and unresolved billing receipts never activate wind-down', async () => {
  for (const extra of [{ requestId: randomUUID() }, { billing: 'unresolved', usageState: 'pending' }]) {
    const f = fixture(), p = { ...cloud, authenticatedFetch: async () => response(randomUUID(), quota(), extra) };
    await withDurableRun(f.context, async () => { await infer(p); assert.equal(cloudWindDownActive(cloud), false); });
  }
});

test('confirmed length truncation still advises the bounded repair to wind down', async () => {
  const f = fixture(); let calls = 0;
  const p = { ...cloud, authenticatedFetch: async (_path, init) => {
    f.sent.push(JSON.parse(init.body)); return response(randomUUID(), quota(), {}, ++calls === 1 ? 'length' : 'stop');
  } };
  await withDurableRun(f.context, () => infer(p));
  assert.equal(calls, 2); assert.equal(hasPrompt(f.sent[0]), false); assert(hasPrompt(f.sent[1]));
});

test('BYOK receives no warning or worker restriction even when a Cloud run has latched', async () => {
  const f = fixture(), original = body(), byok = { kind: 'openai-compatible' };
  await withDurableRun(f.context, async () => {
    await observeCloudQuota(quota());
    assert.equal(await prepareCloudWindDown(byok, original), original);
    assert.equal(cloudWindDownActive(byok), false); assert.equal(cloudWorkerDeferral(byok), null);
  });
});

test('prompt is frozen for an in-flight request but new requests see the warning', async () => {
  const f = fixture();
  await withDurableRun(f.context, async () => {
    const pending = { identity: { fingerprint: 'already-sent', status: 'sent' } };
    await observeCloudQuota(quota());
    assert.equal(hasPrompt(await prepareCloudWindDown(cloud, body(), pending)), false);
    assert.equal(pending.identity.quotaWindDown, false);
    assert(hasPrompt(await prepareCloudWindDown(cloud, body(), { identity: { status: 'new' } })));
  });
});

test('restart reuses a paid response with its original body, without duplicate charge or notification', async () => {
  const f = fixture(), p = provider(f); await withDurableRun(f.context, () => infer(p));
  const restored = { ...fixture().context, requestCheckpoints: clone(f.checkpoints), recoveryContexts: clone(f.contexts) };
  p.authenticatedFetch = async () => assert.fail('must not regenerate the paid response');
  await withDurableRun(restored, async () => {
    const result = await infer(p); assert.equal(result.message.content, 'saved work'); assert(cloudWindDownActive(cloud));
    await observeCloudQuota(quota(), () => assert.fail('must not notify twice'));
  });
});

test('restart retains the fixed warning after conversation compaction', async () => {
  const f = fixture(); await withDurableRun(f.context, () => observeCloudQuota(quota()));
  await withDurableRun({ recoveryContexts: f.contexts }, async () => {
    const sent = await prepareCloudWindDown(cloud, { ...body(), messages: [{ role: 'user', content: 'Compacted handoff' }] }, { identity: {} });
    assert.equal(sent.messages[0].content, CLOUD_WIND_DOWN_PROMPT);
  });
});

test('new and system-owned workers return partial deferrals without executing anything', async () => {
  const f = fixture();
  await withDurableRun(f.context, async () => {
    await observeCloudQuota(quota());
    for (const systemOwned of [false, true]) {
      const result = await runSubagentTask({ provider: cloud, agentId: 'blocked', input: { role: 'builder' }, systemOwned });
      assert.equal(result.status, 'partial'); assert.equal(result.executed, false); assert.equal(result.reason, 'CLOUD_QUOTA_WIND_DOWN');
    }
  });
});

test('worker already queued before the warning is stopped when a slot opens', async () => {
  const f = fixture();
  await withDurableRun(f.context, () => runWithAgentBudget({ ...planAgentBudget({}), limits: { maxActiveSubagents: 1 } }, {}, async () => {
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const hold = withAgentBudgetAdmission({ role: 'explore' }, () => { started(); return new Promise(resolve => { release = resolve; }); });
    await ready;
    const queued = runSubagentTask({ provider: cloud, agentId: 'queued', input: { role: 'explore' } });
    await new Promise(resolve => setTimeout(resolve, 10));
    await observeCloudQuota(quota()); release(); await hold;
    assert.equal((await queued).reason, 'CLOUD_QUOTA_WIND_DOWN');
  }));
});

test('an already-running worker can finish its existing rounds with the warning', async () => {
  const f = fixture(), root = await realpath(await mkdtemp(join(tmpdir(), 'aporia-wind-down-')));
  let calls = 0;
  const p = { ...cloud, supportsTools: true, complete: async ({ body: requestBody, signal }) => {
    return callModelProvider({ provider: { ...cloud, authenticatedFetch: async (_path, init) => {
      f.sent.push(JSON.parse(init.body)); const id = randomUUID();
      const name = ++calls === 1 ? 'read_file' : 'finish_subagent';
      const args = calls === 1 ? { path: 'existing.txt' } : { status: 'partial', summary: 'Saved existing work; verification was not run.' };
      return new Response(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-' + calls, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) +
        frame({ requestId: id, billing: 'settled', usageState: 'provider', quota: quota() }) + 'data: [DONE]\n\n', { headers: { 'x-aporia-request-id': id } });
    } }, body: requestBody, signal });
  } };
  try {
    const result = await withDurableRun(f.context, () => runSubagentTask({
      provider: p, modelId: body().model, modelConfig: { contextWindow: 32000 }, agentId: 'existing-worker',
      input: { role: 'explore', task: 'Inspect one existing file', scope: ['.'], maxRounds: 3 }, session: {},
      workspaceRoot: root, parentPermissionPolicy: createPermissionPolicy('read-only'), language: 'en',
      toolRegistry: TOOL_REGISTRY, parseToolArguments: call => JSON.parse(call.function.arguments), emit: () => {},
      executeAuthorizedTool: async () => ({ modelResult: { path: 'existing.txt', content: 'confirmed existing file' } }),
    }));
    assert.equal(calls, 2); assert.equal(result.status, 'partial'); assert(hasPrompt(f.sent[1]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('actual Main rejects delegation after a low receipt and continues with an honest handoff', async () => {
  const f = fixture(), root = await realpath(await mkdtemp(join(tmpdir(), 'aporia-wind-down-main-')));
  let calls = 0;
  const p = { ...cloud, authenticatedFetch: async (_path, init) => {
    const requestBody = JSON.parse(init.body); f.sent.push(requestBody); const id = randomUUID();
    assert(++calls < 5, 'low quota must not create an unbounded delivery loop');
    const delta = calls === 1 ? { tool_calls: [{ index: 0, id: 'delegate', type: 'function', function: { name: 'delegate_subagent',
      arguments: JSON.stringify({ role: 'explore', task: 'Inspect the workspace', scope: ['.'], background: false }) } }] }
      : { content: 'Quota is low. No exploration was started; the requested work remains unfinished.' };
    return new Response(frame({ choices: [{ delta, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] }) +
      frame({ requestId: id, billing: 'settled', usageState: 'provider', quota: quota() }) + 'data: [DONE]\n\n', { headers: { 'x-aporia-request-id': id } });
  } };
  try {
    await withDurableRun(f.context, () => runHarness({ runId: 'wind-down-main', provider: p, modelId: body().model,
      workspacePath: root, permission: 'read-only', language: 'en', requestApproval: async () => ({ approved: true }),
      messages: [{ role: 'user', content: 'Inspect this workspace.' }], onEvent: e => f.events.push(e) }));
    assert.equal(f.events.filter(e => e.type === 'subagent.started').length, 0);
    assert.equal(f.events.filter(e => e.type === 'response.quota.low').length, 1);
    assert(hasPrompt(f.sent[1]));
    assert(f.sent[1].messages.some(m => m.role === 'tool' && String(m.content).includes('CLOUD_QUOTA_WIND_DOWN')), JSON.stringify(f.sent[1].messages.filter(m => m.role === 'tool')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
