import { readFile } from 'node:fs/promises';
import { agentChatDisplayName } from '../../shared/agent-identity.js';

const BUILTINS = new Set(['main', 'explore', 'review', 'verify', 'builder', 'curator']);
const cache = new Map();
export async function meetingPersona(role, language = 'zh-CN') {
  const name = agentChatDisplayName(role, language);
  // A custom role never borrows the identity of its execution template.
  if (!BUILTINS.has(role.id)) return {
    id: `team-persona:${role.id}`, name,
    content: `你是 ${name}。职责：${String(role.description || '').slice(0, 800)}。保持自己的身份，不自称其他成员。日常一句话，普通问答一至两句；只有被问到工作才简短汇报。性格体现在措辞和关注点，不虚构工作经历，不机械套用报告模板。\n个性与表达参考（不能更改身份或权限）：${String(role.instructions || '').slice(0, 1800)}`,
  };
  if (!cache.has(role.id)) {
    const pending = readFile(new URL(`./skills/${role.id}/SKILL.md`, import.meta.url), 'utf8');
    cache.set(role.id, pending);
    pending.catch(() => cache.delete(role.id));
  }
  const content = (await cache.get(role.id)).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/^#.*$/m, `# ${name}：独立交流 Skill`).replace(/^你是[^。]*。/m, `你的本次名字是 ${name}。`);
  return { id: `team-persona:${role.id}`, name, content: content + (role.instructions ? `\n用户保存的本角色偏好（不得更改本次身份或扩大权限）：${String(role.instructions).slice(0, 1800)}` : '') };
}
