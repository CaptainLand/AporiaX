import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createTeamChatService } from '../electron/team-chat/service.js';
import { projectKey, roleEvidence } from '../electron/team-chat/context.js';
import { teamRecipients } from '../shared/team-chat.js';
import { defaultRoleSettings } from '../shared/professional-roles.js';

await mkdir('.tmp', { recursive: true });
const root = await mkdtemp(resolve('.tmp/team-chat-'));
const settings = defaultRoleSettings();
const provider = { id: 'test', models: [{ id: 'model', contextWindow: 32000 }] };
const task = { id: 'a', title: '演示任务', workspacePath: 'D:/Demo/A', projectId: 'p', messages: [{ role: 'user', content: '做一个页面' }, {
  id: 'm1', role: 'assistant', status: 'completed', runId: 'run1', content: '已完成', reasoning: 'PRIVATE_REASONING',
  subagents: [{ agentId: 'w1', profileId: 'review', profileName: '审查', status: 'completed', task: '审查页面', summary: '发现一处颜色问题' }, { agentId: 'w2', profileId: 'builder', summary: 'BUILDER_ONLY' }],
  witness: { records: [{ agentId: 'w1', title: '审查记录', detail: 'key=ok', status: 'completed' }] },
}] };
const tasks = [task, { ...task, id: 'b', title: '同项目另一任务' }, { ...task, id: 'c', workspacePath: 'D:/Other', title: 'PRIVATE_OTHER_PROJECT' }, { ...task, id: 'd', accountId: 'someone-else' }];
let calls = [], events = [];
const dependencies = { dataDirectory: root, loadTask: async id => structuredClone(tasks.find(t => t.id === id)), loadTasks: async () => structuredClone(tasks),
  loadRoles: async () => structuredClone(settings), resolveProvider: async () => provider, publish: e => events.push(e),
  callProvider: async input => { calls.push(input); input.onEvent({ type: 'response.delta', delta: '这是独立聊天。' }); return { message: { content: '这是独立聊天。' }, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }; },
};
const base = { taskId: 'a', roomId: 'group', providerId: 'test', modelId: 'model' };
let service = createTeamChatService(dependencies);
const send = (extra = {}) => service.request({ ...base, action: 'send', message: '进展怎么样', requestId: crypto.randomUUID(), ...extra });
const initial = await service.request({ ...base, action: 'list' });
assert.equal(calls.length, 0);
assert.deepEqual(initial.tasks.map(t => t.id).sort(), ['a', 'b']);
assert.equal(initial.rooms[0].id, 'group');
assert.equal(initial.roles.length, settings.profiles.length + 1);
await assert.rejects(service.request({ ...base, contextTaskId: 'c', action: 'load' }), /本项目/);
await assert.rejects(service.request({ ...base, contextTaskId: 'd', action: 'list' }), /本项目/);
await assert.rejects(send({ recipients: ['review', 'verify', 'explore', 'missing-role'] }), /删除或停用/);
await assert.rejects(send({ message: '@不存在 你好' }), /未识别/);
const reply = await send({ requestId: 'one' });
assert.equal(calls.length, 1);
assert.equal(reply.messages[1].roleId, 'main');
assert.equal(calls[0].body.tools, undefined);
assert.equal(calls[0].maxAttempts, 1);
assert.equal(calls[0].body.max_tokens, 2048);
assert(!JSON.stringify(calls[0].body).includes('PRIVATE_REASONING'));
assert(!JSON.stringify(calls[0].body).includes('PRIVATE_OTHER_PROJECT'));
await assert.rejects(send({ requestId: 'one' }), /已提交/);
assert.equal(calls.length, 1);
let listing = await service.request({ ...base, action: 'list' });
assert.equal(listing.rooms[0].unread, 1);
await service.request({ ...base, action: 'read', sequence: reply.sequence });
assert.equal((await service.request({ ...base, action: 'list' })).rooms[0].unread, 0);
await service.request({ ...base, action: 'read', sequence: 0 });
assert.equal((await service.request({ ...base, action: 'list' })).rooms[0].unread, 0);
const duo = await send({ recipients: ['review', 'builder'] });
assert.deepEqual(duo.messages.slice(-3).map(m => m.roleId), [undefined, 'review', 'builder']);
assert.equal(calls.length, 3);
assert(!JSON.stringify(calls[1].body.messages[1]).includes('BUILDER_ONLY'));
assert.equal((await service.request({ ...base, taskId: 'b', action: 'load' })).messages.length, duo.messages.length);
const privateChat = await send({ roomId: 'role:review' });
assert(!JSON.stringify(calls.at(-1).body.messages).includes('这是独立聊天。'), 'private room cannot receive group history');
assert.equal(privateChat.messages.at(-1).evidence.workers[0].id, 'w1');
const ownName = settings.profiles.find(p => p.id === 'review').name;
assert.deepEqual(teamRecipients('@' + ownName + ' 你好', [], settings.profiles), ['review']);
settings.profiles.push({ ...settings.profiles[0], id: 'designer', name: '设计师' });
await send({ roomId: 'role:designer' });
settings.profiles = settings.profiles.filter(p => p.id !== 'designer');
assert.equal((await service.request({ ...base, action: 'list' })).rooms.find(r => r.id === 'role:designer').archived, true);
await assert.rejects(send({ roomId: 'role:designer' }), /删除或停用/);
settings.profiles.find(p => p.id === 'review').enabled = false;
await assert.rejects(send({ roomId: 'role:review' }), /删除或停用/);
settings.profiles.find(p => p.id === 'review').enabled = true;
service.dispose();
service = createTeamChatService(dependencies);
assert.equal((await service.request({ ...base, roomId: 'role:review', action: 'load' })).messages.length, 2);
assert.equal((await service.request({ ...base, taskId: 'c', action: 'load' })).messages.length, 0);
assert.notEqual(projectKey(task), projectKey({ ...task, accountId: 'other' }));
assert.notEqual(projectKey({ id: 'one' }), projectKey({ id: 'two' }));
assert.equal(roleEvidence(task, 'review', { runId: 'new-run', workers: [] }).workers.length, 0, 'no old workers in new run');
assert.equal(roleEvidence(task, 'main', { runId: 'new-run', workers: [] }).records.length, 0);

let blockedCalls = 0;
service.dispose();
service = createTeamChatService({ ...dependencies, dataDirectory: join(root, 'cancel'), callProvider: input => new Promise((resolve, reject) => {
  blockedCalls++; input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
}) });
const waitFor = async fn => { for (let i = 0; i < 200 && !fn(); i++) await new Promise(r => setTimeout(r, 5)); assert(fn()); };
const pending = send({ recipients: ['review', 'builder'] });
await waitFor(() => blockedCalls === 1);
await assert.rejects(send(), /正在回复/);
const otherPending = send({ roomId: 'role:review' });
await waitFor(() => blockedCalls === 2);
await assert.rejects(send({ roomId: 'role:builder' }), /最多进行两场/);
await service.request({ ...base, action: 'cancel' });
const stopped = await pending;
assert.equal(stopped.messages.at(-1).status, 'interrupted');
assert.equal(blockedCalls, 2, 'cancel stops remaining invitees but does not cancel another chat');
await service.request({ ...base, roomId: 'role:review', action: 'cancel' });
assert.equal((await otherPending).messages.at(-1).status, 'interrupted');
service.dispose();
service = createTeamChatService({ ...dependencies, dataDirectory: join(root, 'timeout'), timeoutMs: 15, callProvider: input => new Promise((resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })) });
const timeout = await send();
assert.match(timeout.messages.at(-1).error, /超时/);
service.dispose();
service = createTeamChatService({ ...dependencies, dataDirectory: join(root, 'tools'), callProvider: async () => ({ message: { tool_calls: [{ function: { name: 'delete_file', arguments: '{}' } }] } }) });
assert.equal((await send()).messages.at(-1).status, 'failed');
service.dispose();
console.log('PASS team messages: host project/account boundaries, private/group isolation, bounded routing, roles, archived history, durable read cursors, no tools, cancellation, deadline, new-run evidence isolation.');
