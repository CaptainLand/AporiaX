// A task's live status belongs to its latest visible attempt, never to an
// earlier attempt that happens to have a Witness snapshot.
export function latestVisibleAssistant(messages = []) {
  return [...messages].reverse().find((message) =>
    message.role === "assistant" && !message.supersededByRetryId && message.kind !== "anchor-restore");
}

export function isHistoricalFailure(message, latest) {
  return message.role === "assistant" && message.id !== latest?.id &&
    Boolean(message.error || ["failed", "blocked", "interrupted"].includes(message.status));
}

export function savedOutcomeFiles(message) {
  if (message.anchorRestoredAt) return [];
  return [...new Set((message.changes || [])
    .filter((change) => !change.deleted && !change.afterMissing && !change.reverted && typeof change.path === "string" && change.path)
    .map((change) => change.path))];
}
