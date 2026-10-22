// A model reply is a delivery receipt, never evidence that every operation passed.
// Explicit false prevents raw error text or an incomplete stream becoming a reply.
export function hasDeliveredReply(result) {
  if (!result || result.replyDelivered === false || typeof result.content !== 'string' || !result.content.trim()) return false;
  if (result.replyDelivered === true) return true;
  return !result.error && ['completed', 'partial', 'blocked', 'needs_input'].includes(result.status);
}

export function preserveDeliveredReply(result, issue, warning = '') {
  if (!hasDeliveredReply(result)) return null;
  return { ...result, status: 'blocked', error: false, replyDelivered: true,
    content: warning && !result.content.includes(warning) ? `${result.content}\n\n${warning}` : result.content,
    runIssues: [...(Array.isArray(result.runIssues) ? result.runIssues : []), issue],
  };
}
