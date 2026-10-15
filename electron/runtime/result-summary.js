// Only local progress/strategy guards may fall back to a text-only delivery.
// Authentication, transport, quota, persistence and user cancellation are NOT
// reasons to make another automatic request or relax a safety boundary.
export function resultSummaryStop(error, language = 'zh-CN') {
  const reasons = {
    LOOP_NO_PROGRESS: ['重复操作没有带来新的有效进展，本轮已停止继续执行这些操作。', 'Repeated actions produced no new progress, so further execution was stopped for this run.'],
    LOOP_STRATEGY_EXHAUSTED: ['针对同一问题的修复策略已达到本轮限制，未继续重复尝试。', 'Repair strategies for the same issue reached this run’s limit; no more repeated attempts were made.'],
    CLARIFICATION_REPEATED_DENIAL: ['提问因不符合规则或已达到次数限制而未能继续；没有获得必要的信息或授权，未擅自执行。', 'Questions were rejected by the clarification rules or limits; required information or authorization was not obtained, and no unauthorized action was taken.'],
  };
  const reason = reasons[error?.code];
  if (!reason) return null;
  return { code: error.code, reason: reason[language === 'en' ? 1 : 0] };
}

export function resultSummaryInstruction(stop) {
  return `Execution is now closed for this run (${stop.code}). Do not call tools, delegate work, request approval, or attempt more operations. Return a useful final answer in the user's language from confirmed history: what was achieved, the concrete result/files available, what remains unfinished, and why. Do not claim unobserved success or passing verification. Explain the obstacle in ordinary language, not just an error code. Existing limits and permissions still apply. Confirmed stopping reason: ${stop.reason}`;
}

export function retainedResultSummary(message, stop, language = 'zh-CN') {
  const content = typeof message?.content === 'string' ? message.content.trim() : '';
  // A provider ignoring the text-only request must never send tool calls to
  // execution. Preserve useful text and the actual reason even without prose.
  return { role: 'assistant', content: [content, `${language === 'en' ? 'Remaining work' : '未完成说明'}：${stop.reason}`].filter(Boolean).join('\n\n') };
}
