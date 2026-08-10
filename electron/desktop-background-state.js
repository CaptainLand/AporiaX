export const TASK_COMPLETION_TOAST_SELECTOR = ".task-completion-toast";

export function shouldHideWindowOnClose({ isQuitting = false } = {}) {
  return !Boolean(isQuitting);
}

export function normalizeActiveRunIds(runIds = []) {
  return [
    ...new Set(
      [...runIds]
        .map((runId) => String(runId || "").trim())
        .filter(Boolean),
    ),
  ];
}

export function desktopBackgroundStatus(runIds = []) {
  const activeRunIds = normalizeActiveRunIds(runIds);
  const activeRuns = activeRunIds.length;
  return {
    activeRunIds,
    activeRuns,
    statusLabel:
      activeRuns > 0
        ? `${activeRuns} 个任务正在后台运行`
        : "当前没有运行中的任务",
    tooltip:
      activeRuns > 0
        ? `AporiaX · ${activeRuns} 个任务运行中`
        : "AporiaX",
  };
}

export function taskCompletionToastSuppressionCss() {
  return `${TASK_COMPLETION_TOAST_SELECTOR}{display:none!important;}`;
}
