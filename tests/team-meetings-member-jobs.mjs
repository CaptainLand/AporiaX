import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamChatService } from '../electron/team-chat/service.js';
import { defaultRoleSettings } from '../shared/professional-roles.js';
import { teamRecipients } from '../shared/team-chat.js';
import { meetingPersona } from '../electron/team-chat/persona.js';
import { memberPermissionPolicy } from '../electron/team-chat/member-policy.js';
import { createPermissionPolicy } from '../electron/agent-core.js';
import { createMemberExecutor } from '../electron/team-chat/executor.js';
import { createLocalControlPolicy, withLocalControlPolicy, assertLocalControlTool } from '../electron/control/policy.js';
import { configureNativeFileAccess } from '../electron/runtime/file-access-policy.js';
import { configureModelResponseDiagnostics, drainModelResponseDiagnostics } from '../electron/runtime/model-response-diagnostics.js';
import { readdir } from 'node:fs/promises';
import { projectKey } from '../electron/team-chat/context.js';
import { memberWorkspaceIdentity } from '../electron/team-chat/workspace-identity.js';

const root = await mkdtemp(join(tmpdir(), 'aporiax-member-jobs-'));
const workspace = join(root, 'project'); await mkdir(workspace); await writeFile(join(workspace, 'file.txt'), 'original');
const settings = defaultRoleSettings(), roles = [{ id: 'main', name: 'AporiaX', enabled: true }, ...settings.profiles];
assert.equal(teamRecipients('@全体成员 请汇报', [], roles).length, 6);
assert.equal(teamRecipients('@all hello', ['review'], roles).length, 6);
assert.equal(teamRecipients('', ['explore', 'review', 'verify', 'builder'], roles).length, 4);
assert.equal(teamRecipients('a@example.com', [], roles)[0], 'main');
assert.equal(teamRecipients('@全体成员', [], roles.map(r => r.id === 'review' ? { ...r, enabled: false } : r)).length, 5);
assert.equal(new Set((await Promise.all(roles.map(role => meetingPersona(role)))).map(p => p.content)).size, 6);
assert.match((await meetingPersona({ id: 'custom', name: '独立角色', description: '设计', template: 'explore', instructions: '稳重' })).content, /独立角色/);
for (const role of settings.profiles) {
  const policy = memberPermissionPolicy(createPermissionPolicy('workspace-write'), role);
  assert.equal(policy.delegate_subagent, 'deny'); assert.equal(policy.manage_agent_role, 'deny'); assert.equal(policy.read_external_file, 'deny');
  if (role.template === 'review') { const readOnly = memberPermissionPolicy(createPermissionPolicy('read-only'), role); assert.equal(readOnly.write_file ?? readOnly['*'], 'deny'); }
}
let calls = [], executions = [], reportEvents = [], release, propose = false;
const task = { id: 'main-task', title: '主任务不变', workspacePath: workspace, accountId: 'account-a', messages: [{ role: 'user', content: 'main-only' }] };
const originalTask = structuredClone(task), provider = { id: 'test', name: 'Test', baseUrl: 'https://fixture.invalid/v1', models: [{ id: 'mock' }] };
const dependencies = { dataDirectory: root, loadTask: async id => ({ ...structuredClone(task), id, ...(id === 'other-account' ? { accountId: 'account-b' } : {}) }), loadTasks: async () => [task], loadRoles: async () => structuredClone(settings), resolveProvider: async () => provider,
  publish: e => reportEvents.push(e), callProvider: async ({ body }) => { calls.push(body); return propose ? { message: { content: '', tool_calls: [{ id: 'draft-call', function: { name: 'propose_member_job', arguments: '{"instruction":"模型整理的任务目标"}' } }] } } : { message: { content: `角色简报-${calls.length}` } }; },
  executeJob: async (job, { signal, onEvent }) => { executions.push(job); await onEvent({ type: 'member.workspace', path: workspace });
    if (job.instruction === 'wait') await new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
    return { status: 'completed', content: '真实结果', usage: { total_tokens: 10 } }; },
};
let service = createTeamChatService(dependencies);
const base = { taskId: task.id, roomId: 'group', providerId: 'test', modelId: 'mock' };
const request = (action, extra = {}) => service.request({ ...base, action, ...extra });
const wait = async fn => { for (let i = 0; i < 200 && !(await fn()); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert(await fn()); };
await request('send', { message: '@全体成员 汇报', requestId: 'all' });
assert.equal(calls.length, 6);
assert(!calls[1].messages.some(m => m.role === 'assistant' && m.content === '角色简报-1'), 'other speaker cannot become my assistant history');
assert(calls[1].messages.some(m => m.role === 'user' && m.content.includes('角色简报-1')), 'same-round prior reply is visible as attributed data');
await request('send', { roomId: 'role:review', message: '私聊', requestId: 'private' });
assert(!JSON.stringify(calls.at(-1)).includes('角色简报-1'), 'private conversation cannot receive group history');
propose = true;
const proposed = await request('send', { message: '请察微独立检查这个项目', recipients: ['review'], requestId: 'model-proposal' });
assert(proposed.messages.at(-1).jobProposal?.id);
assert.equal(executions.length, 0, 'a model-authored proposal cannot execute work');
assert.equal(proposed.messages.at(-1).jobProposal.roleId, 'review');
assert.deepEqual(calls.at(-1).tools.map(t => t.function.name), ['propose_member_job']);
propose = false;
const draft = await request('jobs:prepare', { roleId: 'review', instruction: 'inspect' });
assert.equal(executions.length, 0, 'draft has no execution authority');
await assert.rejects(request('jobs:start', { jobId: draft.id, taskId: 'other-account' }), /不属于/);
await assert.rejects(request('jobs:start', { jobId: draft.id, roomId: 'role:review' }), /不属于/);
await Promise.all([request('jobs:start', { jobId: draft.id }), request('jobs:start', { jobId: draft.id })]);
await wait(async () => (await request('jobs:list')).find(j => j.id === draft.id)?.status === 'completed');
assert.equal(executions.length, 1, 'duplicate start calls launch once');
assert.notEqual(executions[0].taskId, task.id); assert.equal(executions[0].origin, 'team-member');
await request('jobs:list');
let room = await request('load');
assert.equal(room.messages.filter(m => m.memberJobId === draft.id).length, 1);
assert.equal(room.messages.find(m => m.memberJobId === draft.id).mentions[0].type, 'user');
assert.deepEqual(task, originalTask, 'main messages, status and records never change');
const waiting = await request('jobs:prepare', { roleId: 'review', instruction: 'wait' });
await request('jobs:start', { jobId: waiting.id }); await wait(() => !!release);
await request('send', { message: '任务执行期间仍能聊天', recipients: ['main'], requestId: 'during-job' });
await request('jobs:cancel', { jobId: waiting.id });
await wait(async () => (await request('jobs:list')).find(j => j.id === waiting.id)?.status === 'cancelled');
service.dispose();
service = createTeamChatService(dependencies);
await request('jobs:list'); room = await request('load');
assert.equal(room.messages.filter(m => m.memberJobId === draft.id).length, 1, 'restart does not duplicate a report');
service.dispose();

// Crash/restart reconciliation: no inference replay, and the report is an outbox entry.
const jobStorePath = join(root, 'team-member-jobs', projectKey(task) + '.json');
const stored = JSON.parse(await readFile(jobStorePath, 'utf8'));
stored.jobs.find(j => j.id === draft.id).reported = false; // Report saved, acknowledgement lost.
const crashed = { ...structuredClone(stored.jobs.find(j => j.id === draft.id)), id: 'crash-fixture', runId: 'member-crash-fixture', taskId: 'member-task-crash-fixture', status: 'running', reported: false, result: null };
stored.jobs.push(crashed); await writeFile(jobStorePath, JSON.stringify(stored));
const beforeRecovery = executions.length;
service = createTeamChatService(dependencies);
const recoveredJobs = await request('jobs:list');
assert.equal(recoveredJobs.find(j => j.id === crashed.id).status, 'needs_attention');
assert.equal(executions.length, beforeRecovery, 'crash recovery cannot repeat an uncertain operation');
room = await request('load');
assert.equal(room.messages.filter(m => m.memberJobId === draft.id).length, 1, 'saved report survives a missing delivery acknowledgement');
assert.equal(room.messages.filter(m => m.memberJobId === crashed.id).length, 1);
await request('jobs:list'); assert.equal((await request('load')).messages.filter(m => m.memberJobId === crashed.id).length, 1);
const changedDraft = await request('jobs:prepare', { roleId: 'review', instruction: 'changed profile' });
settings.profiles.find(r => r.id === 'review').instructions = 'new instruction';
await assert.rejects(request('jobs:start', { jobId: changedDraft.id }), /配置已变化/);
settings.profiles.find(r => r.id === 'review').instructions = '';
assert.equal(service.listMemberJobs().length, 0);
service.dispose();

// Exercise the actual separate runtime and retained workspace, with inference mocked.
console.log('PASS meeting and job-service checks; checking independent runtime.');
let runtimeInput;
const executor = createMemberExecutor({ dataDirectory: root, resolveProvider: async () => provider, infer: async input => {
  runtimeInput = input; assert.notEqual(input.workspacePath, workspace);
  assert.equal(input.memberRole.id, 'builder'); assert.equal(input.approvalMode, 'manual');
  await writeFile(join(input.workspacePath, 'file.txt'), 'member-copy');
  return { status: 'completed', content: '副本完成', changes: [{ path: 'file.txt' }] };
} });
const job = { id: 'fixture-job', runId: 'member-fixture-job', taskId: 'member-task-fixture-job', role: settings.profiles.find(r => r.id === 'builder'), workspacePath: workspace, workspaceIdentity: await memberWorkspaceIdentity(workspace), providerId: 'test', modelId: 'mock', instruction: 'edit the copy', language: 'zh-CN' };
const result = await executor.executeJob(job, { signal: new AbortController().signal, onEvent: async () => {} });
console.log('PASS independent runtime returned.');
assert.equal(result.workspace.mergeRequired, true);
assert.equal(await readFile(join(workspace, 'file.txt'), 'utf8'), 'original');
assert.equal(await readFile(join(result.workspace.path, 'file.txt'), 'utf8'), 'member-copy');
assert(result.artifacts.some(a => a.path === 'file.txt'));
assert.equal((await executor.runtime.getRunResult(job.runId)).content, '副本完成');
assert.equal(runtimeInput.messages.length, 1);

// Global outside-file access must not let a member escape its confirmed copy.
configureNativeFileAccess(() => ({ enabled: true, protectedPaths: [] }));
try {
  const strict = createLocalControlPolicy({ permissionProfile: 'workspace_edit', workspaceRoot: result.workspace.path, strictWorkspace: true });
  await assert.rejects(withLocalControlPolicy(strict, () => assertLocalControlTool({ toolName: 'write_file', workspaceRoot: result.workspace.path, input: { path: join(workspace, 'file.txt') } })), /outside|escape/i);
} finally { configureNativeFileAccess(() => ({ enabled: false, protectedPaths: [] })); }

// Real Harness + real native read dispatcher, fake SSE only; diagnostics remain enabled.
const savedFetch = globalThis.fetch, actualBodies = [];
configureModelResponseDiagnostics({ dataDirectory: () => root, requests: 1 });
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body); actualBodies.push(body);
  const chunk = actualBodies.length === 1 ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'read-fixture', type: 'function', function: { name: 'read_file', arguments: '{"path":"file.txt"}' } }] }, finish_reason: 'tool_calls' }] }
    : { choices: [{ delta: { content: '已读取文件，内容为 original。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 } };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
};
try {
  const realExecutor = createMemberExecutor({ dataDirectory: root, resolveProvider: async () => provider });
  const realJob = { ...job, id: 'real-read', runId: 'member-real-read', taskId: 'member-task-real-read', role: settings.profiles.find(r => r.id === 'review'), instruction: '读取 file.txt 并简短报告内容，不修改任何文件' };
  const actual = await realExecutor.executeJob(realJob, { signal: new AbortController().signal, onEvent: async () => {} });
  assert.equal(actual.status, 'completed'); assert.equal(actualBodies.length, 2);
  const tools = actualBodies[0].tools.map(t => t.function.name);
  assert(tools.includes('read_file'));
  for (const name of ['write_file', 'run_command', 'verify_project']) assert(tools.includes(name), 'role responsibility is not a capability ceiling');
  for (const name of ['delegate_subagent', 'manage_agent_role', 'read_conversation_history']) assert(!tools.includes(name));
  assert(actualBodies[1].messages.some(m => m.role === 'tool' && String(m.content).includes('original')));
  await drainModelResponseDiagnostics();
  const diagnostics = await readdir(join(root, 'diagnostics', 'model-responses'));
  const capture = JSON.parse(await readFile(join(root, 'diagnostics', 'model-responses', diagnostics[0]), 'utf8'));
  assert.equal(capture.runId, realJob.runId); assert.equal(capture.taskId, realJob.taskId);
  assert(!JSON.stringify(capture).includes('"path":"file.txt"'), 'diagnostic capture does not export tool arguments');
  assert.equal(await readFile(join(workspace, 'file.txt'), 'utf8'), 'original');
  console.log('PASS actual member Harness, native read, restricted tool catalogue and opt-in diagnostic identity.');
} finally { globalThis.fetch = savedFetch; configureModelResponseDiagnostics(); }
console.log('PASS meetings/member jobs: all/multi, personas, speaker isolation, same-round context, private history, confirmation, duplicate starts, account/room scoping, concurrent chat, cancellation, reports, retained copy and separate runtime.');
console.log('Isolated test data:', root);
