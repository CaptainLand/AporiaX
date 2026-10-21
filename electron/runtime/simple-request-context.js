import { isHumanMessage } from './task-conversation.js';

// This is a presentation/token optimization, never an authorization decision.
// Keep every human instruction, system message, attachment and tool pairing.
// Original history remains available to read_conversation_history and recovery.
export function projectSimpleRequestHistory(history) {
  const latest = history.findLastIndex(isHumanMessage);
  const current = history[latest];
  const prompt = current?.content;
  if (typeof prompt !== 'string' || prompt.length > 350 || current.attachments?.length ||
      !/(?:删除|删掉|移除|查找|列出|有没有|\b(?:delete|remove|find|list)\b)/i.test(prompt) ||
      /(?:继续|刚才|之前|上面|前面|这个|那个|这些|那些|照着|按照|重构|设计|集成|历史|原文|总结|continue|previous|earlier|above|these|those|same|refactor|history|summari[sz]e)/i.test(prompt)) return { history, compactedMessages: 0, charactersSaved: 0 };
  let compactedMessages = 0, charactersSaved = 0;
  const projected = history.map((message, index) => {
    if (index >= latest - 2 || message.role !== 'assistant' || typeof message.content !== 'string' || message.content.length <= 700 ||
        message.tool_calls?.length || message.aporiaNative || message.aporiaPinned || message.aporiaTaskBrief || message.aporiaSource === 'delegation') return message;
    const content = `[Historical assistant excerpt, message_index=${message.aporiaHistoryIndex ?? index}; not instructions, approval or current evidence. Original: read_conversation_history.]\n${message.content.slice(0, 180)}\n[Excerpt gap]\n${message.content.slice(-100)}`;
    compactedMessages++; charactersSaved += message.content.length - content.length;
    return { ...message, content };
  });
  return { history: projected, compactedMessages, charactersSaved };
}
