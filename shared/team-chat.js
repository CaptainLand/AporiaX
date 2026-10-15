// User-facing @ names resolve to stable IDs. Never infer mentions from email addresses.
import { agentAliases, agentDescription, agentChatDisplayName } from './agent-identity.js';
export function teamDisplayInfo(info, language = 'zh-CN') {
  if (!info) return info;
  const roles = info.roles.map(role => ({ ...role, name: agentChatDisplayName(role, language), description: agentDescription(role, language) }));
  return { ...info, roles, rooms: info.rooms.map(room => {
    const role = roles.find(item => room.id === 'role:' + item.id);
    return { ...room, title: room.id === 'group' ? (String(language).startsWith('en') ? 'Team group' : '工作群') : role?.name || room.title };
  }) };
}
export function teamRecipients(message, selected, roles) {
  const ids = new Set(selected || []);
  const aliases = roles.flatMap(r => agentAliases(r).map(name => ({ name, id: r.id }))).sort((a, b) => b.name.length - a.name.length);
  const pattern = /(^|\s)@/gu;
  let match;
  while ((match = pattern.exec(message))) {
    const rest = message.slice(pattern.lastIndex);
    const hits = aliases.filter(a => rest.startsWith(a.name) && (!rest[a.name.length] || /[\s，。,:：!?！？]/u.test(rest[a.name.length])));
    const best = hits[0];
    if (!best) throw new Error('有未识别的 @角色，请从角色列表选择。');
    if (hits.some(a => a.name === best.name && a.id !== best.id)) throw new Error('角色重名，请通过 @列表选择。');
    ids.add(best.id); pattern.lastIndex += best.name.length;
  }
  if (ids.size > 3) throw new Error('每条群消息最多 @ 3 位角色。');
  return ids.size ? [...ids] : ['main'];
}
