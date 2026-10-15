import assert from 'node:assert/strict';
import { AGENT_IDENTITIES, agentDisplayName, agentName, agentChatDisplayName } from '../shared/agent-identity.js';
import { defaultRoleSettings } from '../shared/professional-roles.js';
import { teamDisplayInfo, teamRecipients } from '../shared/team-chat.js';
import { buildOfficeModel } from '../src/office/office-model.js';
import { activityActor } from '../src/conversation/route-activity-model.js';
import { isBrowserConsoleShortcut } from '../shared/browser-shortcuts.js';
const expected = { main: ['阿珀', 'AporiaX'], explore: ['探奇', 'Scout'], review: ['察微', 'Sentry'], verify: ['验准', 'Checko'], builder: ['搭匠', 'Forge'], curator: ['知序', 'Index'] };
const settings = defaultRoleSettings();
const legacy = { explore: '探索', review: '审查', verify: '验证', builder: 'Builder', curator: '知识整理' };
for (const profile of settings.profiles) profile.name = legacy[profile.id];
const saved = JSON.stringify(settings);
for (const language of ['zh-CN', 'en']) {
  assert.equal(agentChatDisplayName({ roleId: 'main', name: '阿珀' }, language), 'AporiaX');
  assert.equal(agentChatDisplayName({ id: 'main', name: 'AporiaX · 主管' }, language), 'AporiaX');
  assert.equal(agentChatDisplayName({ id: 'main', name: '自定义主管' }, language), '自定义主管');
}
assert.equal(agentChatDisplayName({ id: 'explore', name: '探奇' }, 'zh-CN'), '探奇');
assert.equal(teamDisplayInfo({ roles: [{ id: 'main', name: '阿珀' }], rooms: [{ id: 'role:main', title: '阿珀' }] }, 'zh-CN').rooms[0].title, 'AporiaX');
for (const [id, names] of Object.entries(expected)) {
  for (const [index, language] of ['zh-CN', 'en'].entries()) {
    assert.equal(agentName(id, language), names[index]);
    assert.equal(agentDisplayName({ id, name: legacy[id] || 'AporiaX · 主管' }, language), names[index]);
    assert.equal(activityActor(id === 'main' ? {} : { actor: 'subagent', agentId: `${id}-1`, role: id, profileName: legacy[id] }, language), names[index]);
    const model = buildOfficeModel({ task: { id: 'demo', messages: [] }, settings, language });
    const agent = model.roster.find(role => role.role === id);
    assert.equal(agent.name, names[index]);
    if (language === 'en') {
      const chinese = buildOfficeModel({ task: { id: 'demo', messages: [] }, settings, language: 'zh-CN' }).roster.find(role => role.role === id);
      assert.deepEqual([agent.id, agent.color, agent.accessory], [chinese.id, chinese.color, chinese.accessory], 'language does not change robot identity or appearance');
    }
  }
}
assert.equal(JSON.stringify(settings), saved, 'legacy stored names/configuration are not overwritten');
assert.equal(activityActor({ actor: 'subagent', role: 'builder', name: 'write_file' }, 'en'), 'Forge', 'legacy tool names cannot become agent identities');
const roles = [{ id: 'main', name: 'AporiaX · 主管', template: 'main' }, ...settings.profiles];
for (const [id, identity] of Object.entries(AGENT_IDENTITIES)) {
  for (const alias of [identity.zh, identity.en, ...identity.aliases]) assert.deepEqual(teamRecipients(`@${alias} 请说明进度`, [], roles), [id]);
}
const custom = { id: 'role-custom', template: 'review', name: '我的专家' };
assert.equal(agentDisplayName(custom, 'en'), '我的专家');
assert.equal(agentDisplayName({ profileId: custom.id, role: 'review', profileName: custom.name }, 'en'), '我的专家');
assert.equal(agentDisplayName({ id: 'review', name: '自己起的名字' }, 'en'), '自己起的名字');
assert.deepEqual(teamRecipients('联系 test@example.com', [], roles), ['main']);
const info = teamDisplayInfo({ roles: [...roles, custom], rooms: [{ id: 'group', title: '工作群' }, { id: 'role:main', title: 'AporiaX · 主管' }, { id: 'role:role-custom', title: custom.name }] }, 'en');
assert.deepEqual(info.rooms.map(room => room.title), ['Team group', 'AporiaX', '我的专家']);
for (const input of [{ key: 'F12' }, { type: 'keyDown', key: 'F12' }, { key: 'I', ctrlKey: true, shiftKey: true }, { key: 'j', control: true, shift: true }]) assert.equal(isBrowserConsoleShortcut(input), true);
for (const input of [{ key: 'i', ctrlKey: true }, { key: 'F12', altKey: true }, { key: 'F12', repeat: true }, { type: 'keyUp', key: 'F12' }, { key: 'F12', isComposing: true }]) assert.equal(isBrowserConsoleShortcut(input), false);
console.log('PASS identities: bilingual names, legacy compatibility, unchanged IDs/robot skins/config, custom names, bilingual @ routing, localized team list and shortcut recognition.');
