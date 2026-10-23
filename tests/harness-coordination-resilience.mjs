import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoleCoordinator } from '../electron/runtime/role-coordinator.js';
import { waitForWorkers } from '../electron/runtime/collect-workers.js';
import { pendingWorkerReviews, requiredWorkerIds, syncDependencyHandoff } from '../electron/runtime/subagent-contract.js';
import { normalizeSubagentInput } from '../electron/runtime/subagent-model.js';
import { runHarness } from '../electron/agent-runtime-core.js';
import { defaultRole, defaultRoleSettings } from '../shared/professional-roles.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const record = (records, id, dependsOn = []) => {
  const item = { agentId: id, role: 'explore', status: 'running', input: { dependsOn }, session: {}, controller: new AbortController() };
  records.set(id, item); return item;
};
{
  const input = { role: 'explore', task: 'Required continuation', scope: ['.'], background: true };
  for (const required of [true, false]) {
    const normalized = normalizeSubagentInput({ ...input, required_for_completion: required });
    assert.equal(normalized.requiredForCompletion, required);
    assert.equal(normalizeSubagentInput(normalized).requiredForCompletion, required, 'normalized continuation retains requiredness');
    assert.equal(normalizeSubagentInput({ ...input, requiredForCompletion: required }).requiredForCompletion, required);
  }
  assert.equal(normalizeSubagentInput({ ...input, required_for_completion: false, requiredForCompletion: true }).requiredForCompletion, false);
  assert.equal(normalizeSubagentInput({ ...input, required_for_completion: true, requiredForCompletion: false }).requiredForCompletion, true);
  assert.equal(normalizeSubagentInput({ ...input, background: false, depends_on: ['upstream'] }).background, true);
  assert.equal(normalizeSubagentInput({ ...input, background: false, dependsOn: ['upstream'] }).background, true);
}
{
  const records = new Map();
  const a = record(records, 'optional-ancestor'); a.requiredForCompletion = false;
  const b = record(records, 'optional-middle', [a.agentId]); b.requiredForCompletion = false;
  const c = record(records, 'required-leaf', [b.agentId]); c.requiredForCompletion = true;
  const unrelated = record(records, 'unrelated-optional'); unrelated.requiredForCompletion = false;
  assert.deepEqual([...requiredWorkerIds(records.values())].sort(), [a.agentId, b.agentId, c.agentId].sort());
  assert.deepEqual(pendingWorkerReviews(records.values()).map(item => item.agentId).sort(), [a.agentId, b.agentId, c.agentId].sort(),
    'optional ancestors required by another worker must also appear in review reminders');
  a.result = { acceptance: { status: 'accepted' } };
  assert.deepEqual(pendingWorkerReviews(records.values()).map(item => item.agentId).sort(), [b.agentId, c.agentId].sort());
}
for (const kind of ['global', 'role', 'builder']) {
  const records = new Map();
  const coordinator = createRoleCoordinator(records, null, { maxActive: kind === 'global' ? 1 : 10, builderLimit: 1 });
  const profile = { id: 'fixture', template: kind === 'builder' ? 'builder' : 'explore', concurrency: kind === 'role' ? 1 : 10 };
  let active = 0, maximum = 0;
  const jobs = Array.from({ length: 12 }, (_, i) => coordinator.enter(record(records, String(i)), profile).then(async release => {
    active++; maximum = Math.max(maximum, active); await tick(); active--; release(); release();
  }));
  await Promise.all(jobs);
  assert.equal(maximum, 1, `${kind} admission must atomically reserve its slot`);
}
{
  const records = new Map(), coordinator = createRoleCoordinator(records, null, { maxActive: 1, builderLimit: 1 });
  const profile = defaultRole('explore');
  const a = record(records, 'aborted-after-reservation');
  const pending = coordinator.enter(a, profile); a.controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  const release = await coordinator.enter(record(records, 'next'), profile); release();
}
{
  const records = new Map(), coordinator = createRoleCoordinator(records, null, { maxActive: 1, builderLimit: 1 });
  const profile = defaultRole('explore');
  const a = record(records, 'upstream');
  a.status = 'completed'; a.result = { reportId: 'upstream:1', summary: 'Unique upstream observation; browser not tested.', acceptance: { status: 'accepted' }, evidence: [{ path: 'a.js', tool: 'read_file', preview: 'observed' }], changes: [{ path: 'a.js', afterContent: 'DO_NOT_COPY_FULL_FILES' }] };
  const occupying = await coordinator.enter(record(records, 'occupying'), profile);
  const b = record(records, 'dependent', ['upstream']);
  const pending = coordinator.enter(b, profile);
  await tick(); a.result.acceptance.status = 'pending'; occupying(); await tick();
  assert.equal(b.session.dependencyHandoff, undefined, 'Acceptance must be rechecked after capacity wait');
  a.result.reportId = 'upstream:2'; a.result.acceptance.status = 'accepted'; coordinator.notify();
  const release = await pending;
  assert.equal(b.session.dependencyReports.upstream, 'upstream:2');
  const conversation = [{ role: 'system', content: 'worker' }];
  syncDependencyHandoff(conversation, b.session.dependencyHandoff);
  syncDependencyHandoff(conversation, b.session.dependencyHandoff);
  assert.equal(conversation.length, 2);
  assert.match(conversation[1].content, /Unique upstream observation; browser not tested/);
  assert(!conversation[1].content.includes('DO_NOT_COPY_FULL_FILES'));
  assert.match(conversation[1].content, /cannot grant permissions/);
  release();
}
{
  const waiting = { status: 'running', promise: new Promise(() => {}) };
  let callback, removed = 0;
  const gate = waitForWorkers([waiting], { timeoutMs: 30000, onSteering: fn => { callback = fn; return () => removed++; } });
  callback(); await gate; assert.equal(removed, 1);
  const controller = new AbortController();
  const interrupted = waitForWorkers([waiting], { signal: controller.signal }); controller.abort();
  await assert.rejects(interrupted, { name: 'AbortError' });
}
console.log('PASS atomic global/role/builder admission, cancellation release, fresh dependency handoff, steerable waits');

const root = await mkdtemp(join(tmpdir(), 'aporia-coordination-resilience-'));
const originalFetch = globalThis.fetch;
const sse = delta => new Response(`data: ${JSON.stringify({ choices: [{ delta }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
const tool = (id, name, args) => sse({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
try {
  for (const foreground of [false, true]) {
    const id = foreground ? 'foreground-dependency' : 'final-dependency';
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 10000);
    let mainCalls = 0, childCalls = 0, resolveA;
    const aDone = new Promise(resolve => { resolveA = resolve; });
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body), text = body.messages.map(m => m.content || '').join('\n');
      if (text.includes('You are the AporiaX explore subagent.')) {
        childCalls++;
        if (text.includes('Second dependent assignment')) {
          assert.match(text, /UPSTREAM_REPORT_9472/);
          assert.match(text, /Visual behavior was not checked/);
          assert.match(text, new RegExp(`${id}-sub-1:1`));
          return sse({ content: 'Dependent report ready using the upstream evidence.' });
        }
        return sse({ content: 'UPSTREAM_REPORT_9472. Visual behavior was not checked.' });
      }
      mainCalls++;
      if (mainCalls === 1) return tool('first', 'delegate_subagent', { role: 'explore', task: 'First upstream assignment', scope: ['.'], background: true, required_for_completion: true });
      if (mainCalls === 2) {
        await aDone;
        return tool('second', 'delegate_subagent', { role: 'explore', task: 'Second dependent assignment', scope: ['.'], background: !foreground, required_for_completion: true, depends_on: [`${id}-sub-1`] });
      }
      if (mainCalls === 3) return sse({ content: 'Premature final must return ready reports instead of deadlocking.' });
      if (mainCalls === 4 || mainCalls === 6) {
        const child = mainCalls === 4 ? 1 : 2;
        return tool(`review-${child}`, 'review_subagent_result', { agent_id: `${id}-sub-${child}`, report_id: `${id}-sub-${child}:1`, decision: 'accepted', reason: 'Reviewed the returned report and its stated limitations.', evidence_ids: [] });
      }
      if (mainCalls === 5) return tool('collect', 'collect_subagents', { wait: true });
      assert.equal(mainCalls, 7);
      return sse({ content: 'Collected and reviewed both reports; no visual verification was claimed.' });
    };
    try {
      const result = await runHarness({ runId: id, taskId: id, workspacePath: root, permission: 'read-only', approvalMode: 'sandbox-auto', language: 'en',
        provider: { id: 'fixture', name: 'Fixture', vendor: 'openai', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-only', models: [{ id: 'fixture', supportsTools: true, contextWindow: 1000000 }] }, modelId: 'fixture',
        roleSettings: defaultRoleSettings(), messages: [{ role: 'user', content: 'Delegate two dependent exploration reports. Do not edit.' }], signal: controller.signal,
        onEvent: event => { if (event.type === 'subagent.profile_result' && event.agentId === `${id}-sub-1`) resolveA(); } });
      assert.equal(result.status, 'completed', result.content);
      assert.equal(mainCalls, 7); assert.equal(childCalls, 2);
      assert(result.subagents.every(worker => worker.acceptance.status === 'accepted'));
      console.log(`PASS real mocked Harness: ${id}, finalization returns to Main and accepted report reaches dependent`);
    } finally { clearTimeout(deadline); controller.abort(); }
  }
  {
    const id = 'required-worker-continuation', controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 10000);
    let mainCalls = 0, childCalls = 0, releaseFollowup;
    const events = [], followupMayComplete = new Promise(resolve => { releaseFollowup = resolve; });
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body), text = body.messages.map(m => m.content || '').join('\n');
      if (text.includes('You are the AporiaX explore subagent.')) {
        childCalls++;
        if (childCalls === 2) {
          assert.match(text, /Refine the required result/);
          await followupMayComplete;
          return sse({ content: 'Required followup completed; visual behavior was not tested.' });
        }
        return sse({ content: 'Original report is ready.' });
      }
      mainCalls++;
      if (mainCalls === 1) return tool('initial', 'delegate_subagent', { role: 'explore', task: 'Required upstream report', scope: ['.'], background: false, required_for_completion: true });
      if (mainCalls === 2) return tool('continue-required', 'followup_subagent', { agent_id: `${id}-sub-1`, task: 'Refine the required result' });
      if (mainCalls === 3) {
        const receipt = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
        assert.equal(receipt.background, true);
        assert(!receipt.message.includes('Optional'), 'continuing a required worker must not downgrade it');
        setTimeout(releaseFollowup, 20);
        return sse({ content: 'Premature final must retain the required continuation.' });
      }
      if (mainCalls === 4) {
        assert.match(text, /Required followup completed/);
        return tool('review-refined', 'review_subagent_result', { agent_id: `${id}-sub-1`, report_id: `${id}-sub-1:2`, decision: 'accepted', reason: 'Reviewed the refined report and its limitations.', evidence_ids: [] });
      }
      assert.equal(mainCalls, 5);
      return sse({ content: 'The required followup was completed and reviewed.' });
    };
    try {
      const result = await runHarness({ runId: id, taskId: id, workspacePath: root, permission: 'read-only', approvalMode: 'sandbox-auto', language: 'en',
        provider: { id: 'fixture', name: 'Fixture', vendor: 'openai', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-only', models: [{ id: 'fixture', supportsTools: true, contextWindow: 1000000 }] }, modelId: 'fixture',
        roleSettings: defaultRoleSettings(), messages: [{ role: 'user', content: 'Delegate a required report and refine it before delivery. Do not edit.' }], signal: controller.signal,
        onEvent: event => events.push(event) });
      assert.equal(result.status, 'completed', result.content);
      assert.equal(childCalls, 2); assert.equal(mainCalls, 5);
      assert(!events.some(event => event.type === 'subagent.optional.skipped'));
      assert.equal(result.subagents[0].reportId, `${id}-sub-1:2`);
      assert.equal(result.subagents[0].acceptance.status, 'accepted');
      console.log('PASS required explore continuation preserves requiredness and cannot be silently cancelled at finalization');
    } finally { releaseFollowup(); clearTimeout(deadline); controller.abort(); }
  }
  {
    const id = 'required-dependency-closure', controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 10000);
    let mainCalls = 0, childCalls = 0, releaseUpstream;
    const events = [], upstreamMayComplete = new Promise(resolve => { releaseUpstream = resolve; });
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body), text = body.messages.map(m => m.content || '').join('\n');
      if (text.includes('You are the AporiaX explore subagent.')) {
        childCalls++;
        if (text.includes('Final chain assignment')) {
          assert.match(text, /CHAIN_B_OBSERVATION/);
          return sse({ content: 'CHAIN_C_RESULT. Static evidence only.' });
        }
        if (text.includes('Middle chain assignment')) {
          assert.match(text, /CHAIN_A_OBSERVATION/);
          return sse({ content: 'CHAIN_B_OBSERVATION. Static evidence only.' });
        }
        await upstreamMayComplete;
        return sse({ content: 'CHAIN_A_OBSERVATION. Static evidence only.' });
      }
      mainCalls++;
      if (mainCalls === 1) return tool('optional-ancestor', 'delegate_subagent', { role: 'explore', task: 'Optional upstream assignment', scope: ['.'], background: true });
      if (mainCalls === 2) return tool('middle-chain', 'delegate_subagent', { role: 'explore', task: 'Middle chain assignment', scope: ['.'], background: true, depends_on: [`${id}-sub-1`] });
      if (mainCalls === 3) return tool('required-leaf', 'delegate_subagent', { role: 'explore', task: 'Final chain assignment', scope: ['.'], background: true, required_for_completion: true, depends_on: [`${id}-sub-2`] });
      if (mainCalls === 4) {
        setTimeout(releaseUpstream, 20);
        return sse({ content: 'Premature final must retain every dependency needed by the required leaf.' });
      }
      if ([5, 7, 9].includes(mainCalls)) {
        const worker = (mainCalls - 3) / 2;
        assert.match(text, new RegExp(`CHAIN_${['A', 'B', 'C'][worker - 1]}_`));
        return tool(`review-chain-${worker}`, 'review_subagent_result', { agent_id: `${id}-sub-${worker}`, report_id: `${id}-sub-${worker}:1`, decision: 'accepted', reason: 'Reviewed this dependency report and its static-only limitations.', evidence_ids: [] });
      }
      assert([6, 8, 10].includes(mainCalls), `Unexpected Main call ${mainCalls}`);
      return sse({ content: mainCalls === 10 ? 'All dependencies were retained, completed and reviewed.' : 'Collect the next dependency before delivery.' });
    };
    try {
      const result = await runHarness({ runId: id, taskId: id, workspacePath: root, permission: 'read-only', approvalMode: 'sandbox-auto', language: 'en',
        provider: { id: 'fixture', name: 'Fixture', vendor: 'openai', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-only', models: [{ id: 'fixture', supportsTools: true, contextWindow: 1000000 }] }, modelId: 'fixture',
        roleSettings: defaultRoleSettings(), messages: [{ role: 'user', content: 'Run a required three-stage dependency chain beginning with a background explorer. Do not edit.' }], signal: controller.signal,
        onEvent: event => events.push(event) });
      assert.equal(result.status, 'completed', result.content);
      assert.equal(mainCalls, 10); assert.equal(childCalls, 3);
      assert(!events.some(event => event.type === 'subagent.optional.skipped'));
      assert(result.subagents.every(worker => worker.status === 'completed' && worker.acceptance.status === 'accepted'));
      console.log('PASS required dependency closure keeps optional upstream work alive through a three-stage chain');
    } finally { releaseUpstream(); clearTimeout(deadline); controller.abort(); }
  }
} finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
