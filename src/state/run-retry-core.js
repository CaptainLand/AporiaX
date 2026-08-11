function taskRunEntries(runs, taskId) {
  if (!(runs instanceof Map) || !taskId) return [];
  return [...runs.entries()].filter(([, run]) => run?.taskId === taskId);
}

function activeTaskRuns(records, taskId) {
  return (Array.isArray(records) ? records : []).filter(
    (record) => record?.taskId === taskId,
  );
}

function removeRendererTaskRuns(runs, taskId) {
  const removedRunIds = [];
  for (const [runId] of taskRunEntries(runs, taskId)) {
    runs.delete(runId);
    removedRunIds.push(runId);
  }
  return removedRunIds;
}

/**
 * Reconcile renderer bookkeeping with the main-process Harness registry before
 * retrying a failed or interrupted turn. The main process is authoritative:
 * when it reports no active run for a task, a stale renderer entry must not
 * block the retry indefinitely.
 */
export async function prepareTaskRetry({
  taskId,
  rendererRuns,
  listActiveRuns,
  interruptRun,
  interruptActive = false,
  sleep = (milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  timeoutMs = 8_000,
  pollMs = 120,
}) {
  if (!taskId || !(rendererRuns instanceof Map)) {
    return { ready: false, reason: "invalid-task", removedRunIds: [] };
  }

  let mainSnapshot = null;
  if (typeof listActiveRuns === "function") {
    try {
      mainSnapshot = await listActiveRuns();
    } catch {
      mainSnapshot = null;
    }
  }

  if (mainSnapshot !== null) {
    let matchingMainRuns = activeTaskRuns(mainSnapshot, taskId);
    if (!matchingMainRuns.length) {
      return {
        ready: true,
        reason: "main-confirmed-idle",
        removedRunIds: removeRendererTaskRuns(rendererRuns, taskId),
      };
    }

    // Retrying an older historical turn must never cancel a newer run in the
    // same task. Only an explicit checkpoint recovery may retire an active run.
    if (!interruptActive) {
      return {
        ready: false,
        reason: "task-still-active",
        removedRunIds: [],
      };
    }

    if (typeof interruptRun === "function") {
      await Promise.allSettled(
        matchingMainRuns.map((run) => interruptRun(run.runId)),
      );
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      try {
        matchingMainRuns = activeTaskRuns(await listActiveRuns(), taskId);
      } catch {
        return {
          ready: false,
          reason: "main-status-unavailable",
          removedRunIds: [],
        };
      }
      if (!matchingMainRuns.length) {
        return {
          ready: true,
          reason: "main-run-stopped",
          removedRunIds: removeRendererTaskRuns(rendererRuns, taskId),
        };
      }
    }

    return {
      ready: false,
      reason: "main-run-still-active",
      removedRunIds: [],
    };
  }

  // Compatibility fallback for older preload bridges without activeRuns().
  const localEntries = taskRunEntries(rendererRuns, taskId);
  if (!localEntries.length) {
    return { ready: true, reason: "renderer-idle", removedRunIds: [] };
  }
  if (typeof interruptRun !== "function") {
    return { ready: false, reason: "interrupt-unavailable", removedRunIds: [] };
  }
  await Promise.allSettled(
    localEntries.map(([runId]) => interruptRun(runId)),
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!taskRunEntries(rendererRuns, taskId).length) {
      return { ready: true, reason: "renderer-run-stopped", removedRunIds: [] };
    }
    await sleep(pollMs);
  }
  return {
    ready: false,
    reason: "renderer-run-still-active",
    removedRunIds: [],
  };
}

/**
 * Execute the complete renderer-side retry transaction. A retry only counts as
 * successful after the old run has been reconciled and the replacement run
 * has actually been accepted by the renderer.
 */
export async function executeTaskRetry({
  taskId,
  rendererRuns,
  listActiveRuns,
  interruptRun,
  interruptActive = false,
  onReady,
  startRetry,
}) {
  try {
    const preparation = await prepareTaskRetry({
      taskId,
      rendererRuns,
      listActiveRuns,
      interruptRun,
      interruptActive,
    });
    if (!preparation.ready) {
      return {
        started: false,
        reason: preparation.reason,
        preparation,
      };
    }

    await onReady?.(preparation);
    if (typeof startRetry !== "function") {
      return {
        started: false,
        reason: "start-unavailable",
        preparation,
      };
    }
    const accepted = await startRetry(preparation);
    return {
      started: accepted === true,
      reason: accepted === true ? "started" : "start-rejected",
      preparation,
    };
  } catch (error) {
    return {
      started: false,
      reason: "retry-error",
      error,
    };
  }
}

export function hasRendererTaskRun(runs, taskId) {
  return taskRunEntries(runs, taskId).length > 0;
}
