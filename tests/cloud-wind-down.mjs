import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarness } from '../electron/agent-runtime-core.js';
import { createWitnessMonitor } from '../electron/witness-monitor.js';
import { describeRouteRecord } from '../src/conversation/route-activity-model.js';
import { TOOL_REGISTRY } from '../electron/runtime/native-tool-catalog.js';
import { createPermissionPolicy } from '../electron/agent-core.js';
import { withDurableRun } from '../electron/runtime/durable-run.js';
import { callModelProvider } from '../electron/runtime/provider-stream.js';
import { completeLoopRequest } from '../electron/runtime/loop-recovery.js';
import { cloudRequestFingerprint, createLoopRequestIdentity, withLoopRequestIdentity } from '../electron/runtime/cloud-request-identity.js';
import { createAporiaCloudProvider } from '../electron/provider-config.js';
import { lowCloudQuota, lowCloudDailyBudget, observeCloudQuota, prepareCloudWindDown, CLOUD_WIND_DOWN_PROMPT, CLOUD_DAILY_WIND_DOWN_PROMPT } from '../electron/runtime/cloud-wind-down.js';
import { runSubagentTask } from '../electron/runtime/subagent-loop.js';

const cloud = createAporiaCloudProvider('https://fixture.invalid');
const quota = (remaining = 50, extra = {}) => ({ policy: 'actual-usage-v1', source: 'weekly', remainingMicros: remaining, limitMicros: 1000, exhausted: remaining <= 0, ...extra });
const daily = (extra = {}) => ({ policy: 'provider-daily-v1', currency: 'CNY', remainingMicros: 250_000, limitMicros: 5_000_000,
  sampledAt: new Date().toISOString(), resetsAt: new Date(Date.now() + 3600_000).toISOString(), ...extra });
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

test('4% → 90%: concurrent low receipts notify once and never change the request at either balance', async () => {
  const f = fixture(), original = body();
  await withDurableRun(f.context, async () => {
    await Promise.all(Array.from({length:6}, () => observeCloudQuota(quota(40), e => f.events.push(e))));
    assert.equal(await prepareCloudWindDown(cloud, original), original);
    await observeCloudQuota(quota(900), e => f.events.push(e));
    assert.equal(await prepareCloudWindDown(cloud, original), original);
    assert.deepEqual(f.events.map(e=>[e.source,e.mode]), [['weekly','advisory']]);
  });
});

test('shared daily warning uses fresh settled money, never temporary holds or stale days', () => {
  assert(lowCloudDailyBudget(daily()));
  for (const extra of [{remainingMicros:250001}, {remainingMicros:0}, {remainingMicros:1000000,availableMicros:1},
    {sampledAt:new Date(Date.now()-91_000).toISOString()}, {resetsAt:new Date(Date.now()-1).toISOString()},
    {sampledAt:new Date(Date.now()+31_000).toISOString()}, {remainingMicros:'1'}, {currency:'USD'}])
    assert.equal(Boolean(lowCloudDailyBudget(daily(extra))), false);
});

test('daily and weekly warnings deduplicate independently across restart without changing messages', async () => {
  const f = fixture(), both = quota(40,{dailyBudget:daily()});
  await withDurableRun(f.context, () => observeCloudQuota(both, e=>f.events.push(e)));
  assert.deepEqual(f.events.map(e=>e.source), ['weekly','daily']);
  await withDurableRun({recoveryContexts:f.contexts},async()=>{
    await observeCloudQuota(both,()=>assert.fail('duplicate'));
    assert(!hasPrompt(await prepareCloudWindDown(cloud,body(),{identity:{}})));
  });
});

test('Witness exposes a single visible global low-balance record without claiming task completion', () => {
  const witness = createWitnessMonitor({heartbeatMs:0});
  try {
    witness.observe({type:'turn.started'});
    witness.observe({type:'response.quota.low',source:'daily'});
    witness.observe({type:'subagent.response.quota.low',source:'daily'});
    const snapshot=witness.snapshot(),records=snapshot.records.filter(r=>r.eventType==='response.quota.low.daily');
    assert.equal(records.length,1); assert.equal(snapshot.status,'running');
    assert.match(describeRouteRecord(records[0],'zh-CN').title,/全站今日额度/);
    assert.match(describeRouteRecord(records[0],'en').title,/Shared daily/);
  } finally {witness.dispose();}
});

test('settled receipt warns the next existing call without adding instructions or a paid request or modifying history', async () => {
  const f = fixture(), p = provider(f), messages = body().messages;
  await withDurableRun(f.context, async () => {
    await infer(p, messages); await infer(p, messages); await infer(p, messages);
  });
  assert.equal(f.sent.length, 3); assert.equal(hasPrompt(f.sent[0]), false);
  for (const sent of f.sent.slice(1)) {
    assert(!hasPrompt(sent));
  }
  assert.deepEqual(messages, body().messages); assert.equal(f.sent[1].max_tokens, f.sent[0].max_tokens);
});

test('initial authenticated quota is read once and applies before the first call', async () => {
  const f = fixture(); let reads = 0;
  const p = { ...provider(f), getCloudQuota: async () => { reads++; return quota(); } };
  await withDurableRun(f.context, async () => { await infer(p); await infer(p); });
  assert.equal(reads, 1); assert.equal(f.sent.length, 2); assert(!f.sent.some(hasPrompt));
});

test('daily receipt does not change the next model request even with full personal quota', async () => {
  const f=fixture(),p=provider(f,quota(1000,{dailyBudget:daily()}));
  await withDurableRun(f.context,async()=>{await infer(p);await infer(p);});
  assert.equal(hasPrompt(f.sent[0]),false);
  assert(!hasPrompt(f.sent[1]));
});

test('new inference after a saved complete response has no forced handoff and reuses its result', async () => {
  const f=fixture(),p={...provider(f,quota(1000,{dailyBudget:daily()})),getCloudQuota:async()=>quota(1000,{dailyBudget:daily()})};
  await withDurableRun(f.context,async()=>{
    const identity=createLoopRequestIdentity('main');
    const call=request=>withLoopRequestIdentity(identity,()=>callModelProvider({provider:p,body:request}));
    await call(body());
    const changed={...body(),messages:[{role:'user',content:'Confirmed history has advanced'}]};
    await call(changed);assert.equal(identity.identity.quotaWindDownReason,undefined);
    await call(changed);assert.equal(f.sent.length,2,'same durable response must not cause a third paid generation');
    assert(!f.sent.some(hasPrompt));
  });
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
    await withDurableRun(f.context, async () => { await infer(p); assert.equal(f.contexts['cloud-quota-wind-down'],undefined); });
  }
});

test('confirmed length truncation repairs without a quota prompt', async () => {
  const f = fixture(); let calls = 0;
  const p = { ...cloud, authenticatedFetch: async (_path, init) => {
    f.sent.push(JSON.parse(init.body)); return response(randomUUID(), quota(), {}, ++calls === 1 ? 'length' : 'stop');
  } };
  await withDurableRun(f.context, () => infer(p));
  assert.equal(calls, 2); assert.equal(hasPrompt(f.sent[0]), false); assert(!hasPrompt(f.sent[1]));
});

test('BYOK receives no warning or worker restriction even when a Cloud run has latched', async () => {
  const f = fixture(), original = body(), byok = { kind: 'openai-compatible' };
  await withDurableRun(f.context, async () => {
    await observeCloudQuota(quota());
    assert.equal(await prepareCloudWindDown(byok, original), original);
  });
});

test('replay pre-upgrade weekly/daily requests byte-for-byte, never apply old instructions to changed history',async()=>{
  const f=fixture(); await withDurableRun(f.context,async()=>{
    for(const [reason,prompt] of [['daily',CLOUD_DAILY_WIND_DOWN_PROMPT],['weekly',CLOUD_WIND_DOWN_PROMPT]]){
      const original=body(),legacy=body(); legacy.messages[0].content+='\n\n'+prompt;
      const identity={identity:{quotaWindDown:true,quotaWindDownReason:reason,fingerprint:cloudRequestFingerprint(cloud,legacy)}};
      assert.deepEqual(await prepareCloudWindDown(cloud,original,identity),legacy);
      original.messages.push({role:'user',content:'Next request'});
      assert.equal(await prepareCloudWindDown(cloud,original,identity),original);
    }
  });
});

test('restart reuses a paid response with its original body, without duplicate charge or notification', async () => {
  const f = fixture(), p = provider(f); await withDurableRun(f.context, () => infer(p));
  const restored = { ...fixture().context, requestCheckpoints: clone(f.checkpoints), recoveryContexts: clone(f.contexts) };
  p.authenticatedFetch = async () => assert.fail('must not regenerate the paid response');
  await withDurableRun(restored, async () => {
    const result = await infer(p); assert.equal(result.message.content, 'saved work'); assert.equal(result.streamComplete,true);
    await observeCloudQuota(quota(), () => assert.fail('must not notify twice'));
  });
});

test('compaction and an old run latch do not reintroduce the restriction',async()=>{
  const f=fixture(); await withDurableRun({recoveryContexts:{'cloud-quota-wind-down':{active:true,reason:'weekly'}}},async()=>{
    const original={...body(),messages:[{role:'user',content:'Compacted handoff'}]};
    assert.equal(await prepareCloudWindDown(cloud,original,{identity:{}}),original);
    await observeCloudQuota(quota(),()=>assert.fail('duplicate legacy notification'));
  });
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
    assert.equal(calls, 2); assert.equal(result.status, 'partial'); assert(!hasPrompt(f.sent[1]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('actual Main dispatches and reviews a worker at 4% and continues on a 90% receipt', async () => {
  const f = fixture(), root = await realpath(await mkdtemp(join(tmpdir(), 'aporia-wind-down-main-')));
  let calls = 0;
  const p = { ...cloud, authenticatedFetch: async (_path, init) => {
    const requestBody = JSON.parse(init.body); f.sent.push(requestBody); const id = randomUUID();
    assert(++calls <= 5, 'expected discovery, Main, worker, review, answer');
    const names = requestBody.tools.map(t => t.function.name);
    if (calls === 1) assert.deepEqual(names, ['enable_task_tools', 'read_conversation_history']);
    if (calls === 2) assert(names.includes('delegate_subagent') && !names.includes('run_command'));
    const delta = calls === 1 ? { tool_calls: [{ index:0,id:'discover',type:'function',function:{ name:'enable_task_tools',arguments:'{"groups":["agents"]}' } }] }
      : calls === 2 ? { tool_calls: [{ index: 0, id: 'delegate', type: 'function', function: { name: 'delegate_subagent',
      arguments: JSON.stringify({ role: 'explore', task: 'Inspect the workspace', scope: ['.'], background: false }) } }] }
      : calls === 4 ? { tool_calls: [{index:0,id:'review',type:'function',function:{name:'review_subagent_result',arguments:JSON.stringify({
        agent_id:'wind-down-main-sub-1',report_id:'wind-down-main-sub-1:1',decision:'accepted',reason:'Reviewed the read-only inspection.',evidence_ids:[]})}}] }
      : { content: calls === 3 ? 'Read-only inspection returned.' : 'Inspection complete.' };
    return new Response(frame({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) +
      frame({ requestId: id, billing: 'settled', usageState: 'provider', quota: quota(calls < 4 ? 40 : 900) }) + 'data: [DONE]\n\n', { headers: { 'x-aporia-request-id': id } });
  } };
  try {
    await withDurableRun(f.context, () => runHarness({ runId: 'wind-down-main', provider: p, modelId: body().model,
      workspacePath: root, permission: 'read-only', language: 'en', requestApproval: async () => ({ approved: true }),
      messages: [{ role: 'user', content: 'Inspect this workspace.' }], onEvent: e => f.events.push(e) }));
    assert.equal(f.events.filter(e => e.type === 'subagent.started').length, 1);
    assert.equal(f.events.filter(e => e.type === 'response.quota.low').length, 1);
    assert.equal(calls,5); assert(!f.sent.some(hasPrompt));
  } finally { await rm(root, { recursive: true, force: true }); }
});
