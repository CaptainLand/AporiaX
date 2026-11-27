import { hasDeliveredReply } from '../../shared/reply-delivery.js';

// A task's live status belongs to its latest visible attempt, never to an
// earlier attempt that happens to have a Witness snapshot.
export function latestVisibleAssistant(messages = []) {
  return messages.findLast((message) =>
    message.role === "assistant" && !message.supersededByRetryId && message.kind !== "anchor-restore");
}

// A displayed completion means a reply was delivered, not that verification
// passed. Preserve the original outcome and evidence for runtime decisions.
export function hasTaskReply(message) {
  return hasDeliveredReply(message);
}

export function isStoppedRunNotice(message) {
  return message?.role === 'assistant' && message.status === 'interrupted' && !message.anchorRestoredAt &&
    (!hasTaskReply(message) || message.replySource === 'local-receipt');
}

// Applied/pending steering belongs to the same run. A queued request, including
// a steering request promoted to the next turn, is an independent boundary.
export function currentStoppedRun(messages = []) {
  const boundary = messages.findLastIndex(message => message.role === 'user' &&
    (message.queued || !['pending', 'applied'].includes(message.steeringStatus)));
  const source = messages[boundary];
  const latest = messages.findLast((message, index) => {
    if (message.role !== 'assistant' || message.supersededByRetryId || message.isSteeringSegment || message.kind === 'anchor-restore' || index <= boundary) return false;
    // Recovered records may have been appended after a newer user turn.
    if (source?.id && message.sourceUserId) return message.sourceUserId === source.id;
    const startedAt = Date.parse(message.recoverable?.startedAt || message.createdAt);
    const sourceAt = Date.parse(source?.createdAt);
    return !Number.isFinite(startedAt) || !Number.isFinite(sourceAt) || startedAt >= sourceAt;
  });
  return isStoppedRunNotice(latest) && !latest.stoppedNoticeDismissed ? latest : null;
}

export function stoppedRunChangeCount(message) {
  if (message?.anchorRestoredAt || message?.unapplied) return 0;
  return new Set((message?.changes || []).filter(change => !change?.reverted && typeof change?.path === 'string' && change.path.trim())
    .map(change => change.path.replaceAll('\\', '/'))).size;
}

export function dismissStoppedRunNotice(message) {
  return isStoppedRunNotice(message) && !message.stoppedNoticeDismissed
    ? { ...message, stoppedNoticeDismissed: true } : message;
}

export function isHistoricalFailure(message, latest) {
  return message.role === "assistant" && message.id !== latest?.id &&
    Boolean(message.error || ["failed", "blocked", "interrupted"].includes(message.status)) && !hasTaskReply(message);
}

export function savedOutcomeFiles(message) {
  if (message.anchorRestoredAt) return [];
  return [...new Set((message.changes || [])
    .filter((change) => !change.deleted && !change.afterMissing && !change.reverted && typeof change.path === "string" && change.path)
    .map((change) => change.path))];
}
