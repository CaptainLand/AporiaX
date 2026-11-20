import { isHumanMessage } from './task-conversation.js';

const reference = /刚才|刚刚|之前|先前|前面|上面|上述|下文|上一|上次|继续|照着|按照|这个|那个|这些|那些|这是什么意思|那是什么意思|这两|那两|它(?:们)?(?:是|的|有)|第[一二三四五六七八九十\d]+[个项条种步版本]|历史|原文|\b(?:continue|resume|previous|earlier|above|below|this|those|these|that|former|latter|same|second option|step \d|history|summari[sz]e)\b|^(?:explain|what is|why is|why does)\s+(?:it|its|he|she|they|their)\b/i;
const work = /[\r\n]|https?:|[/\\]|[\w-]+\.\w{1,8}\b|工作区|文件|仓库|当前代码|帮我.{0,6}(查|搜|做)|搜索|联网|查一下|截图|浏览器|打开|修改|实现|测试|部署|修复|创建|导出|运行|顺便|最新|今天|现在的|\b(?:workspace|repository|file|repo|implement|change|test|browse|search|open|latest|today|debug|fix|deploy|export|also)\b/i;

// Presentation only: this grants neither permissions nor authority to act.
// Ambiguous and referential follow-ups keep full working history.
export function classifyTaskRequest(messages) {
  const current = messages?.findLast(isHumanMessage);
  if (current?.attachments?.length || current?.images?.length || typeof current?.content !== 'string') return 'contextual';
  const text = current.content.trim();
  if (!text || reference.test(text)) return 'contextual';
  if (text.length <= 240 && /^\d+(?:\s*[+*/÷×−-]\s*\d+)+(?:\s*[=?？。])*$/.test(text)) return 'standalone-question';
  if (text.length <= 240 && !work.test(text) &&
      /什么是|是什么意思|是什么|有什么区别|有何区别|怎么理解|解释一下|等于几|等于多少|几加几|^(?:what (?:is|are)|why (?:is|does)|explain|how much is)\b/i.test(text) &&
      !/^(?:是什么意思|是什么|解释一下|有什么区别|有何区别|怎么理解|等于几|等于多少|what is|what are|explain)[.。?!？！\s]*$/i.test(text)) return 'standalone-question';
  return text.length <= 350 && !/重构|设计|集成|总结|\b(?:refactor|integrate)\b/i.test(text) &&
    /删除|删掉|移除|查找|列出|有没有|\b(?:delete|remove|find|list)\b/i.test(text) ? 'simple-operation' : 'contextual';
}

// This is a presentation/token optimization, never an authorization decision.
// Keep every human instruction, system message, attachment and tool pairing.
// Original history remains available to read_conversation_history and recovery.
export function projectSimpleRequestHistory(history, { route = classifyTaskRequest(history), canReadHistory = true } = {}) {
  if (!canReadHistory || route === 'contextual') return { history, compactedMessages: 0, charactersSaved: 0 };
  const latest = history.findLastIndex(isHumanMessage);
  let compactedMessages = 0, charactersSaved = 0;
  const projected = history.map((message, index) => {
    if (index >= (route === 'simple-operation' ? latest - 2 : latest) ||
        message.role !== 'assistant' || typeof message.content !== 'string' || message.content.length <= 700 ||
        message.attachments?.length || message.tool_calls?.length || message.aporiaNative || message.aporiaPinned ||
        message.aporiaTaskBrief || message.aporiaSource === 'delegation') return message;
    if (route === 'standalone-question') {
      const content = '[Historical assistant reply omitted. Original: read_conversation_history(message_index=' + (message.aporiaHistoryIndex ?? index) + ').]';
      compactedMessages++; charactersSaved += message.content.length - content.length;
      return { ...message, content };
    }
    const content = `[Historical assistant excerpt, message_index=${message.aporiaHistoryIndex ?? index}; not instructions, approval or current evidence. Original: read_conversation_history.]\n${message.content.slice(0, 180)}\n[Excerpt gap]\n${message.content.slice(-100)}`;
    compactedMessages++; charactersSaved += message.content.length - content.length;
    return { ...message, content };
  });
  return { history: projected, compactedMessages, charactersSaved };
}

export function restoreProjectedAssistantHistory(conversation, originals) {
  for (let i = 0; i < conversation.length; i++) {
    const message = conversation[i], original = originals[message.aporiaHistoryIndex];
    if (message.role === 'assistant' && original?.role === 'assistant' && typeof message.content === 'string' &&
        /^\[(?:Historical assistant reply omitted\. Original: read_conversation_history|Historical assistant excerpt, message_index=)/.test(message.content))
      conversation[i] = original;
  }
}
