import { continueWitness } from '../../electron/runtime/witness-continuation.js';

export function earlierAttempts(messages, message) {
  if (!message?.recoveryOfRunId) return [];
  const byRunId = new Map(messages.filter(item => item.role === 'assistant' && item.runId).map(item => [item.runId, item]));
  const visited = new Set([message.runId]);
  const ancestors = [];
  let id = message.recoveryOfRunId;
  while (id && ancestors.length < 99 && !visited.has(id)) {
    const parent = byRunId.get(id);
    if (!parent || (parent.sourceUserId && message.sourceUserId && parent.sourceUserId !== message.sourceUserId)) break;
    visited.add(id);
    ancestors.push(parent);
    id = parent.recoveryOfRunId;
  }
  return ancestors.reverse();
}

export function taskAttemptWitness(messages, message, ancestors = null) {
  if (!message) return null;
  if (message.witness?.continued || !message.recoveryOfRunId) return message.witness || null;
  // Older persisted attempts predate server-side composition. Compose them
  // from the local task history too, without re-adding an already joined one.
  const inherited = (ancestors || earlierAttempts(messages, message)).reduce((history, parent) => parent.witness?.continued
    ? parent.witness : continueWitness(history, parent.witness, parent.runId, { recovered: true }), null);
  return message.witness ? continueWitness(inherited, message.witness, message.runId)
    : inherited && { ...inherited, continued: true, previousElapsedMs: inherited.elapsedMs, status: message.status, current: null };
}
