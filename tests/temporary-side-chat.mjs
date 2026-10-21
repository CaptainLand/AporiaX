import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTemporarySideChatService } from '../electron/side-chat/temporary-service.js';
import { forkPublicHistory } from '../electron/side-chat/temporary-context.js';
import { prepareTemporaryWorkspace } from '../electron/side-chat/temporary-workspace.js';
import { createPermissionPolicy } from '../electron/agent-core.js';
import { temporaryPermissionPolicy } from '../electron/side-chat/temporary-policy.js';
import { createHarnessEventBus, setDefaultHarnessEventBus } from '../electron/harness/event-bus.js';
import { configureModelResponseDiagnostics, drainModelResponseDiagnostics } from '../electron/runtime/model-response-diagnostics.js';

const root = await realpath(await mkdtemp(join(tmpdir(), 'aporia-temp-chat-test-')));
const data = join(root, 'data'), workspace = join(root, 'project'); await mkdir(workspace); await mkdir(data);
const provider = { id: 'fixture', name: 'Fixture', vendor: 'openai', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-only', models: [{ id: 'fixture', supportsTools: true, contextWindow: 128000 }] };
let task = { id: 'task', providerId: provider.id, modelId: 'fixture', workspacePath: workspace, permission: 'workspace-write',
  messages: Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'ORIGIN_' + i, reasoning_content: 'PRIVATE_REASONING', apiKey: 'PRIVATE_KEY' })) };
const base = { taskId: 'task', scope: 'test-scope' }, deps = { dataDirectory: data, loadTask: async () => structuredClone(task), resolveProvider: async () => provider };
let checks = 0; const pass = name => { checks++; console.log('PASS ' + name); };
const until = async condition => { for (let n = 0; n < 300 && !condition(); n++) await new Promise(resolve => setTimeout(resolve, 5)); assert(condition(), 'test wait timed out'); };
const policy = temporaryPermissionPolicy(createPermissionPolicy('workspace-write'), true);
for (const tool of ['delegate_subagent', 'collect_subagents', 'followup_subagent', 'cancel_subagent', 'review_subagent_result', 'manage_agent_role', 'remember_project_fact', 'github_pr_create', 'git_push']) assert.equal(policy[tool] ?? policy['*'], 'deny');
assert.equal(policy.write_file, 'allow'); assert.equal(policy.run_command, 'allow');
const attached = forkPublicHistory([{ role: 'user', content: 'see attached', attachments: [{ kind: 'document', content: 'PUBLIC_DOCUMENT', name: 'notes.txt', apiKey: 'PRIVATE_KEY' }, { type: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }] }]);
assert.equal(attached[0].attachments[0].content, 'PUBLIC_DOCUMENT'); assert.equal(attached[0].attachments[1].dataUrl, 'data:image/png;base64,AAAA'); assert(!JSON.stringify(attached).includes('PRIVATE_KEY'));
const fork = forkPublicHistory(task.messages); assert.equal(fork.length, 24); assert(!JSON.stringify(fork).includes('PRIVATE_')); pass('public complete fork and hard single-Agent whitelist');
const originalFetch = globalThis.fetch;
try {
  const requests = [], events = [];
  const service = createTemporarySideChatService({ ...deps, publish: event => events.push(event), execute: async request => {
    requests.push(request); request.onEvent({ type: 'witness.updated', witness: { status: 'completed', records: [{ id: 'owned', detail: 'temporary only' }] } });
    request.onEvent({ type: 'response.delta', delta: 'own reply' });
    return { status: 'completed', content: 'own reply', deliveryDetails: 'OWN_DELIVERY_DETAILS', steps: [] };
  } });
  const opened = await service.request({ ...base, action: 'open' }); assert.equal(requests.length, 0);
  task.messages.push({ role: 'user', content: 'AFTER_FORK_NEVER_INHERIT' });
  const sent = await service.request({ ...base, sessionId: opened.id, action: 'send', message: 'temporary work' });
  assert.equal(sent.messages.length, 2); assert(sent.messages[1].witness.records.some(record => record.id === 'owned'));
  assert.equal(sent.messages[1].deliveryDetails, 'OWN_DELIVERY_DETAILS', 'temporary replies retain their optional supporting details');
  assert.equal(requests[0].messages.filter(message => /^ORIGIN_/.test(message.content)).length, 24);
  assert(!requests[0].messages.some(message => /AFTER_FORK/.test(message.content))); assert(requests[0].temporaryChat);
  assert(!JSON.stringify(sent).includes('ORIGIN_')); assert.equal((await service.request({ ...base, action: 'load' })).id, opened.id);
  pass('opening costs no inference; full frozen fork; own Witness; hide/reopen retains branch');
  await service.request({ ...base, action: 'close', sessionId: opened.id });
  await assert.rejects(service.request({ ...base, action: 'send', sessionId: opened.id, message: 'late' }), /关闭/);
  const fresh = await service.request({ ...base, action: 'open' }); assert.notEqual(fresh.id, opened.id); assert.equal(fresh.messages.length, 0);
  assert((await readdir(data)).every(name => !/side-chats|run|journal/.test(name))); service.dispose();
  pass('close destroys conversation; stale writes rejected; new open creates new fork; no chat journal');

  let waiting, aborted = false;
  const approvalService = createTemporarySideChatService({ ...deps, publish: event => { waiting = event.session; }, execute: async request => {
    const approval = await request.requestApproval({ title: 'OWN_APPROVAL', toolName: 'run_command' });
    aborted = request.signal.aborted; assert.equal(approval.approved, false);
    return { status: 'interrupted', content: 'stopped' };
  } });
  const a = await approvalService.request({ ...base, action: 'open' });
  const pending = approvalService.request({ ...base, action: 'send', sessionId: a.id, message: 'wait for approval' });
  await until(() => waiting?.approval);
  await assert.rejects(approvalService.request({ ...base, sessionId: a.id, action: 'approve', approvalId: 'main-approval', approved: true }), /失效/);
  await approvalService.request({ ...base, action: 'close', sessionId: a.id }); await pending; assert(aborted); approvalService.dispose();
  pass('close aborts its own approval/run and drains before disposal; foreign approval rejected');

  await writeFile(join(workspace, 'a.txt'), 'before');
  const handle = await prepareTemporaryWorkspace({ workspacePath: workspace, dataDirectory: data, writable: true });
  await writeFile(join(handle.workspacePath, 'a.txt'), 'temporary after');
  const merged = await handle.finish({ status: 'completed', content: 'changed' }); assert(merged.integrated);
  assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'temporary after');
  await writeFile(join(handle.workspacePath, 'a.txt'), 'second temporary edit'); await writeFile(join(workspace, 'a.txt'), 'main newer edit');
  const conflict = await handle.finish({ status: 'completed', content: 'changed again' }); assert.equal(conflict.status, 'partial');
  assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'main newer edit');
  assert((await handle.close()).retainedWorkspace); assert.equal(await readFile(join(handle.workspacePath, 'a.txt'), 'utf8'), 'second temporary edit');
  pass('private workspace and atomic conflict-checked writeback; unapplied files survive close');

  let calls = 0; const bodies = [];
  const call = (name, input) => ({ tool_calls: [{ index: 0, id: 'call-' + calls, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body); calls++;
    assert(!body.tools?.some(tool => /subagent|agent_role|self_check/.test(tool.function.name)), 'forbidden schemas must not be exposed');
    const delta = calls === 1 ? call('delegate_subagent', { role: 'explore', task: 'forbidden' })
      : calls === 2 ? call('read_file', { path: 'a.txt' }) : { content: 'Observed the current file without delegation.' };
    return new Response('data: ' + JSON.stringify({ choices: [{ delta }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\ndata: [DONE]\n\n');
  };
  const shared = createHarnessEventBus(), leaked = []; shared.on('*', event => leaked.push(event)); setDefaultHarnessEventBus(shared);
  const actual = createTemporarySideChatService(deps), openedActual = await actual.request({ ...base, action: 'open' });
  configureModelResponseDiagnostics({ dataDirectory: () => data, requests: 1 });
  const result = await actual.request({ ...base, sessionId: openedActual.id, action: 'send', message: 'Read a.txt without changing files.' });
  assert.equal(result.messages.at(-1).status, 'completed', JSON.stringify(result.messages.at(-1)));
  assert.equal(calls, 3); assert.equal(leaked.length, 0);
  const rejectedReceipt = bodies[1].messages.filter(message => message.role === 'tool');
  assert(rejectedReceipt.some(message => JSON.parse(message.content).error), JSON.stringify(rejectedReceipt));
  assert(result.messages.at(-1).witness); assert(!result.messages.at(-1).witness.records.some(record => record.kind === 'agent'));
  const nextTurn = await actual.request({ ...base, sessionId: openedActual.id, action: 'send', message: 'Explain the previous temporary result.' });
  assert.equal(nextTurn.messages.at(-1).status, 'completed', nextTurn.messages.at(-1).content);
  assert(bodies.at(-1).messages.some(message => message.role === 'tool'), 'the fork keeps its own runtime tool context across turns');
  assert.equal(leaked.length, 0);
  await drainModelResponseDiagnostics(); await assert.rejects(access(join(data, 'diagnostics')), { code: 'ENOENT' });
  await actual.request({ ...base, sessionId: openedActual.id, action: 'close' }); actual.dispose(); setDefaultHarnessEventBus(null);
  pass('real mocked Harness: tool-level delegation rejection, isolated events, own Witness, consecutive-turn runtime context and successful delivery');
  console.log(`Temporary side chat: ${checks} checks PASS; no live model requests.`);
} finally { globalThis.fetch = originalFetch; configureModelResponseDiagnostics(); setDefaultHarnessEventBus(null); await rm(root, { recursive: true, force: true }); }
