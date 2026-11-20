import { createHash } from 'node:crypto';
import { isHumanMessage } from './task-conversation.js';

const scopeOrConstraint = /不要|不许|不得|禁止|不能|不可以|别|避免|必须|务必|一定|仅|只|保留|保持|沿用|除非|不改|不动|先不|不(?:发布|推送|上传|删除|提交|安装|覆盖)|先(?:问|确认|暂停|等)|审批|授权|范围|预算|上限|以后|今后|始终|每次|规则|约束|标准|验收|要求|!\s*$|\b(?:must|shall|never|only|always|do not|don't|without|except|before|permission|approve|preserve|keep|avoid|scope|limit|budget|leave|unchanged|no)\b/i;
export const containsHistoricalScopeConstraint = text => scopeOrConstraint.test(text);

const textOf = (message) => typeof message.content === 'string' ? message.content
  : (message.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
const idOf = (message) => createHash('sha256').update(textOf(message)).digest('hex').slice(0, 24);
// Only explicit top-level user reset directives revoke earlier task constraints.
// Quotes, attachments, tool results and inferred model preferences cannot do so.
export function explicitlyReplacesAllConstraints(message) {
  if (!isHumanMessage(message)) return false;
  const text = textOf(message).trim();
  return /^(?:(?:请|现在)[，,\s]*)?(?:忽略|作废|取消|替换)(?:之前|此前|先前|上面)(?:的)?(?:全部|所有)(?:任务)?(?:要求|约束|指令)[。！.!\n]/.test(text) ||
    /^(?:please\s+)?(?:discard|ignore|replace|cancel)\s+all\s+(?:earlier|previous|prior)\s+(?:requirements|constraints|instructions)[.!\n]/i.test(text);
}

export function reconcileHumanConstraints(conversation, history, previous = null, { pinActive = false } = {}) {
  const entries = [];
  const superseded = new Map();
  let latestReset = null;
  for (const message of history) {
    if (!isHumanMessage(message)) continue;
    const id = idOf(message);
    if (explicitlyReplacesAllConstraints(message)) {
      latestReset = id;
      for (const entry of entries) if (entry.state === 'active') {
        entry.state = 'superseded'; entry.supersededBy = id; superseded.set(entry.id, id);
      }
    }
    entries.push({ id, state: 'active', source: 'human' });
    superseded.delete(id); // A user can explicitly reintroduce identical wording later.
  }
  for (const message of conversation) {
    if (!isHumanMessage(message)) continue;
    const replacement = superseded.get(idOf(message));
    if (replacement) {
      message.aporiaPinned = false;
      message.aporiaSupersededBy = replacement;
    } else if (pinActive) {
      // Raw persisted user messages may predate aporiaPinned. Active human
      // requirements must not disappear merely because only the newest turn
      // passed through taskRequest(). Only an explicit human reset revokes them.
      message.aporiaPinned = true;
      delete message.aporiaSupersededBy;
    }
  }
  if (latestReset && latestReset !== previous?.latestReset) {
    const prefix = 'AporiaX durable context checkpoint:\n';
    for (const message of conversation) {
      if (message.role !== 'system' || !String(message.content).startsWith(prefix)) continue;
      const checkpoint = JSON.parse(message.content.slice(prefix.length));
      checkpoint.requirements = [];
      checkpoint.requirementsResetBy = latestReset;
      message.content = prefix + JSON.stringify(checkpoint);
    }
  }
  return { version: 1, latestReset, entries };
}
