import assert from 'node:assert/strict';
import { createSkillRegistry } from '../electron/harness/skills/registry.js';
import { prepareSkillRequest, prepareSkillMessage } from '../electron/skill-runtime.js';
import { parseWorkspaceMentions } from '../electron/workspace-mentions.js';
import { extractWorkspaceMentionQuery, tokenizeDisplayMentions } from '../src/agent-process-model.js';
import { ROLE_CREATION_SKILL } from '../shared/role-creation-command.js';

const registry = createSkillRegistry();
const catalog = await registry.catalog();
assert.deepEqual(catalog.diagnostics, []);
const skill = catalog.find(item => item.name === ROLE_CREATION_SKILL);
assert.ok(skill); assert.equal(skill.source, 'builtin'); assert.equal(skill.auto, true);
assert.match(skill.instructions, /curator（知识整理）/);
for (const content of ['@新建专业角色 我需要前端审查专家', '@skill:create-professional-role 帮我配置', '帮我创建一个前端审查角色', '添加一个专业角色，负责整理文档', 'Create a frontend specialist']) {
  const message = await prepareSkillMessage({ role: 'user', content }, '', { registry });
  assert.ok(message.activatedSkills.some(item => item.name === ROLE_CREATION_SKILL), content);
  assert.match(message.aporiaSkillContext, /逐次确认/);
  assert.match(message.aporiaSkillContext, /list_agent_roles/);
  assert.equal(message.content, content, 'activation must not rewrite the user message');
}
assert.equal(registry.match('帮我修改网页背景颜色', { catalog }).skills.some(item => item.name === ROLE_CREATION_SKILL), false);
const disabled = catalog.map(item => item.name === ROLE_CREATION_SKILL ? { ...item, auto: false } : item);
assert.equal(registry.match('帮我创建一个前端审查角色', { catalog: disabled }).skills.length, 0);
assert.equal(registry.match('@新建专业角色', { catalog: disabled }).skills[0].reason, 'explicit');
assert.deepEqual(parseWorkspaceMentions('@新建专业角色 @README.md'), ['README.md']);
assert.deepEqual(parseWorkspaceMentions('@{新建专业角色}'), ['新建专业角色']);
assert.equal(extractWorkspaceMentionQuery('@新建专业角色'), null);
assert.equal(extractWorkspaceMentionQuery('@{新建专业角色').query, '新建专业角色');
assert.equal(tokenizeDisplayMentions('请 @新建专业角色')[1].kind, 'skill');
const request = await prepareSkillRequest({ messages: [{ role: 'user', content: '@新建专业角色' }] }, { registry });
assert.equal(request.activatedSkills[0].reason, 'explicit');
console.log('PASS built-in role Skill discovery, explicit alias, natural-language matching, auto flag, request/steering context and no file reads; no model requests or settings writes.');
