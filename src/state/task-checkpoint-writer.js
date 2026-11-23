// The renderer owns immutable task references; compare them before crossing
// the context bridge, where even unchanged objects would be cloned.
export function createTaskCheckpointWriter({
  baseline = [], save, onResult, onError, onCommitted,
  delay = 350, retryDelays = [1_000, 3_000], retryCooldown = 30_000,
  schedule = setTimeout, cancel = clearTimeout, now = Date.now,
}) {
  const durable = new Map(baseline.map(task => [task.id, task]));
  const removed = new Set();
  const rejected = new WeakSet();
  const corruptIds = new Set();
  let current = baseline;
  let timer = null;
  let retrying = false;
  let inFlight = false;
  let stopped = false;
  let disposed = false;
  let retries = 0;
  let nextAttemptAt = 0;

  const clearTimer = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  const queue = (wait = delay, backoff = false) => {
    if (disposed || stopped || inFlight) return;
    const remainingCooldown = nextAttemptAt - now();
    if (remainingCooldown > wait) { wait = remainingCooldown; backoff = true; }
    clearTimer();
    retrying = backoff;
    timer = schedule(() => {
      timer = null;
      retrying = false;
      void flush();
    }, wait);
  };

  async function flush() {
    if (disposed || stopped || inFlight) return;
    const submitted = current;
    const tasks = submitted.filter(task => !removed.has(task.id) &&
      durable.get(task.id) !== task && !rejected.has(task) && !corruptIds.has(task.id));
    const deletedTaskIds = [...removed].filter(id => durable.has(id));
    for (const id of removed) if (!durable.has(id)) removed.delete(id);
    if (!tasks.length && !deletedTaskIds.length) return;

    inFlight = true;
    let retry = false;
    try {
      const result = await save({ tasks, deletedTaskIds });
      if (disposed) return;
      const saved = new Set(result.saved);
      const deleted = new Set(result.deleted);
      for (const task of tasks) if (saved.has(task.id)) durable.set(task.id, task);
      for (const id of deleted) {
        durable.delete(id);
        removed.delete(id);
      }
      for (const failure of result.failed || []) {
        if (failure.code === "TASK_FILE_CORRUPT") {
          corruptIds.add(failure.id);
        } else if (failure.code === "TASK_JSON_TOO_LARGE") {
          const task = tasks.find(item => item.id === failure.id);
          if (task) rejected.add(task);
        } else retry = true;
      }
      if (tasks.some(task => !saved.has(task.id) && !rejected.has(task) && !corruptIds.has(task.id))) retry = true;
      if (result.ok === false) onResult?.(result);
      if (result.ok !== false && deletedTaskIds.some(id => !deleted.has(id))) {
        // The ID may already be absent (e.g. the previous acknowledgement was lost).
        for (const id of deletedTaskIds) { durable.delete(id); removed.delete(id); }
      }
      if (result.ok !== false && submitted.every(task => durable.get(task.id) === task)) {
        onCommitted?.(submitted);
      }
    } catch (error) {
      if (disposed) return;
      stopped = /TASK_STORE_(?:REVISION_CONFLICT|RECOVERY_REQUIRED)/.test(String(error?.message || error));
      retry = !stopped;
      if (stopped || retries === retryDelays.length) onError?.(error);
    } finally {
      inFlight = false;
    }
    if (retry && retries < retryDelays.length) {
      queue(retryDelays[retries++], true);
    } else if (!retry) {
      retries = 0;
      nextAttemptAt = 0;
      // After a partial save, send a pending explicit deletion separately
      // rather than retrying the same permanently invalid task version.
      if (current !== submitted || removed.size) queue();
    } else {
      nextAttemptAt = now() + retryCooldown;
      if (current !== submitted) queue();
    }
  }

  return {
    update(tasks) {
      if (tasks === current) return;
      current = tasks;
      if (!inFlight && !retrying) queue();
    },
    remove(id) { removed.add(id); queue(); },
    dispose() { disposed = true; clearTimer(); },
  };
}
