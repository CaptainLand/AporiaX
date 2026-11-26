export const AUTO_RETRY_KEY = "aporiax.auto-retry.v1";
export const AUTO_RETRY_MAX = 5;

export function normalizeAutoRetry(value) {
  const attempts = Number(value?.attempts);
  return {
    enabled: value?.enabled === true,
    attempts: Number.isInteger(attempts) && attempts >= 1 && attempts <= AUTO_RETRY_MAX ? attempts : 2,
  };
}

export function autoRetryDelay(settings, result, attempt) {
  if (!settings.enabled || attempt >= settings.attempts ||
      result?.persistence?.failed || !["failed", "partial"].includes(result?.status) ||
      (result.replyDelivered && result.replySource !== "local-receipt") ||
      !["rate-limit", "server", "connection"].includes(result.autoResume?.reason)) return null;
  const wait = result.autoResume.retryAfterMs;
  if (!Number.isFinite(wait) || wait < 0 || wait > 120_000) return null;
  return Math.max(2000 * 2 ** attempt, wait);
}

export function canResumeAutomatically(task, attempt) {
  if (!task || task.id !== attempt.taskId || task.workspacePath !== attempt.workspacePath ||
      task.providerId !== attempt.providerId || task.modelId !== attempt.modelId) return false;
  if (task.messages.some(message => message.queued || message.steeringStatus === "pending")) return false;
  const assistant = task.messages.findLast(message => !message.supersededByRetryId);
  return assistant?.role === "assistant" && assistant.id === attempt.assistantId && assistant.runId === attempt.runId &&
    assistant.sourceUserId === attempt.sourceUserId && !assistant.anchorRestoredAt &&
    ["failed", "partial"].includes(assistant.status) &&
    task.messages.some(message => message.role === "user" && message.id === attempt.sourceUserId);
}

export function createAutoRetryQueue({ schedule = setTimeout, clear = clearTimeout, onChange = () => {} } = {}) {
  const pending = new Map();
  const isPending = entry => pending.get(entry.taskId) === entry;
  function cancel(taskId) {
    const entry = pending.get(taskId);
    if (!entry) return;
    clear(entry.timer);
    pending.delete(taskId);
    onChange(taskId, null);
  }
  return {
    isPending,
    cancel,
    clear() { for (const id of pending.keys()) cancel(id); },
    enqueue(attempt, delay, launch) {
      cancel(attempt.taskId);
      const entry = { ...attempt };
      entry.timer = schedule(async () => {
        try { if (isPending(entry)) await launch(entry); }
        finally { if (isPending(entry)) cancel(entry.taskId); }
      }, delay);
      pending.set(entry.taskId, entry);
      onChange(entry.taskId, { attempt: entry.attempt, limit: entry.limit });
      return entry;
    },
  };
}
