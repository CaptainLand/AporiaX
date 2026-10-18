import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { meetingReplyMode, meetingMessages } from '../electron/team-chat/context.js';
import { meetingPersona } from '../electron/team-chat/persona.js';
import { createTeamChatService } from '../electron/team-chat/service.js';
import { defaultRoleSettings } from '../shared/professional-roles.js';

const settings = defaultRoleSettings();
const roles = [{ id: 'main', name: 'AporiaX', enabled: true }, ...settings.profiles];
for (const input of ['都在吗？', '大家都在吗', '@全体成员 都在吗？', '@Scout @Sentry 在吗', '@阿珀 @验准 都在不？', 'Is everyone here?', 'anyone there?']) {
  assert.equal(meetingReplyMode(input, roles), 'presence', input);
}
for (const [input, mode] of [['早上好！', 'greeting'], ['@all hello team!', 'greeting'], ['谢谢大家', 'thanks'], ['晚安', 'farewell']]) {
  assert.equal(meetingReplyMode(input, roles), mode, input);
}
for (const input of ['都在吗？帮我检查一下项目', '@探奇 在吗，查一下入口', '谢谢，继续做', 'hello, what did you finish?', '都在吗？进展怎么样？', '说说你是谁', '继续', '刚刚那个问题呢', '晚安前帮我跑一下测试']) {
  assert.equal(meetingReplyMode(input, roles), 'conversation', input);
}
const unusual = { id: 'custom', name: '小助理 (A+)', enabled: true, template: 'explore', description: '设计', instructions: '温和' };
assert.equal(meetingReplyMode('@小助理 (A+) 都在吗？', [...roles, unusual]), 'presence');
assert.equal(meetingReplyMode('@陌生人 在吗', roles), 'conversation', 'unknown mention is not silently discarded');

const personas = await Promise.all(roles.map(role => meetingPersona(role)));
assert.equal(new Set(personas.map(p => p.content)).size, 6);
for (let i = 0; i < roles.length; i++) {
  const role = roles[i], persona = personas[i];
  const raw = await readFile(new URL(`../electron/team-chat/skills/${role.id}/SKILL.md`, import.meta.url), 'utf8');
  const metadata = parse(/^---\n([\s\S]*?)\n---/.exec(raw)[1]);
  assert(metadata.name && metadata.description);
  assert(!persona.content.startsWith('---'), 'discovery metadata must not leak into runtime identity');
  const renamed = await meetingPersona({ ...role, name: `角色-${i}` });
  assert(renamed.content.includes(`你的本次名字是 角色-${i}。`));
  const english = await meetingPersona(role, 'en');
  assert.equal(english.name, ['AporiaX', 'Scout', 'Sentry', 'Checko', 'Index', 'Forge'][i]);
  const messages = meetingMessages({ role, persona, evidence: { title: 'OLD_TASK_POISON' },
    history: [{ role: 'assistant', roleId: role.id, personaId: persona.id, content: 'LONG_OLD_REPORT' }],
    content: '@全体成员 都在吗？', replyMode: 'presence' });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].content, '@全体成员 都在吗？');
  assert(!JSON.stringify(messages).includes('OLD_TASK_POISON'));
  assert(!JSON.stringify(messages).includes('LONG_OLD_REPORT'));
}
const custom = await meetingPersona(unusual);
assert.equal(custom.name, unusual.name);
assert(!custom.content.includes('你是探奇'), 'custom execution template is not its chat identity');

const root = await mkdtemp(join(tmpdir(), 'aporiax-team-voice-'));
await mkdir(join(root, 'project'));
const task = { id: 'task', workspacePath: join(root, 'project'), title: 'OLD_TASK_POISON', messages: [
  { role: 'user', content: 'OLD_ASSIGNMENT_POISON' },
  { role: 'assistant', status: 'completed', content: 'old report', subagents: [{ agentId: 'w1', profileId: 'review', summary: 'REVIEW_EVIDENCE' }] },
] };
const original = structuredClone(task), calls = [];
let propose = false, executions = 0;
const service = createTeamChatService({ dataDirectory: root, loadTask: async () => structuredClone(task), loadTasks: async () => [task],
  loadRoles: async () => structuredClone(settings), resolveProvider: async () => ({ id: 'fixture', models: [{ id: 'model' }] }),
  executeJob: async () => { executions++; throw new Error('not authorized by this test'); },
  callProvider: async ({ body }) => { calls.push(body); return propose
    ? { message: { tool_calls: [{ function: { name: 'propose_member_job', arguments: '{"instruction":"检查项目"}' } }] } }
    : { message: { content: body.messages.at(-1).content.includes('都在吗') ? '在。' : 'fixture reply' } }; },
});
const send = (message, extra = {}) => service.request({ action: 'send', taskId: task.id, roomId: 'group', providerId: 'fixture', modelId: 'model', requestId: crypto.randomUUID(), message, ...extra });
try {
  await send('大家都做了什么？', { recipients: roles.map(r => r.id) });
  calls.length = 0;
  const result = await send('@全体成员 都在吗？');
  assert.equal(calls.length, 6);
  assert.deepEqual(result.messages.slice(-6).map(m => m.roleId), roles.map(r => r.id));
  for (const call of calls) {
    assert.equal(call.messages.length, 2, 'each member gets only its identity and this social turn');
    assert.equal(call.tools, undefined, 'social turn cannot propose jobs');
    assert(!JSON.stringify(call).includes('OLD_TASK_POISON'));
    assert(!JSON.stringify(call).includes('OLD_ASSIGNMENT_POISON'));
    assert(!JSON.stringify(call).includes('fixture reply'), 'same-round coworkers cannot induce repeated reports');
  }
  await send('在吗？', { roomId: 'role:review' });
  assert.equal(calls.at(-1).messages.length, 2, 'private greetings use the same policy');
  await send('都在吗？进度怎么样？', { recipients: ['review'] });
  assert(JSON.stringify(calls.at(-1)).includes('REVIEW_EVIDENCE'), 'mixed request retains real role evidence');
  assert.deepEqual(calls.at(-1).tools.map(t => t.function.name), ['propose_member_job']);
  await send('前面说的是什么？', { recipients: ['review'] });
  assert(calls.at(-1).messages.length > 2, 'follow-up questions keep conversation memory');
  propose = true;
  const rejected = await send('都在吗？', { recipients: ['builder'] });
  assert.equal(rejected.messages.at(-1).status, 'failed', 'unsolicited model tool call on social turn is rejected');
  assert(!(await service.request({ action: 'jobs:list', taskId: task.id, roomId: 'group' })).length);
  const draft = await send('请独立检查项目', { recipients: ['review'] });
  assert(draft.messages.at(-1).jobProposal?.id, 'explicit work still creates only a confirmation draft');
  assert.equal(executions, 0);
  assert.deepEqual(task, original, 'chat never alters main task or its Witness');
} finally { service.dispose(); }
console.log('PASS team voice: six independent skills, localized/renamed identities, whole-turn social routing, no old evidence/history/tools on greetings, mixed work questions preserve evidence, confirmed-job boundaries unchanged. Provider mocked; no paid requests.');
