export const TASK_COMPLETION_TOAST_SELECTOR = ".task-completion-toast";
export const TRAY_EDUCATION_MARKER = ".aporiax-tray-hint-shown-v1";

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

export function formatTaskDuration(milliseconds) {
  const value = Math.max(0, Number(milliseconds) || 0);
  if (value < 60_000) {
    const seconds = value / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const totalSeconds = Math.floor(value / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

function normalizeActiveRuns(runs = []) {
  const map = new Map();
  for (const item of [...runs]) {
    const object = item && typeof item === "object" ? item : { id: item };
    const id = String(object.id || object.runId || "").trim();
    if (!id || map.has(id)) continue;
    const startedAt = Number(object.startedAt);
    map.set(id, {
      id,
      startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null,
    });
  }
  return [...map.values()];
}

export function desktopBackgroundStatus(runs = [], { now = Date.now() } = {}) {
  const activeRunsList = normalizeActiveRuns(runs);
  const activeRunIds = activeRunsList.map((run) => run.id);
  const activeRuns = activeRunIds.length;
  const startedAtValues = activeRunsList
    .map((run) => run.startedAt)
    .filter((value) => Number.isFinite(value));
  const oldestStartedAt = startedAtValues.length ? Math.min(...startedAtValues) : null;
  const runtimeLabel = oldestStartedAt
    ? formatTaskDuration(Math.max(0, Number(now) - oldestStartedAt))
    : "";
  return {
    activeRunIds,
    activeRuns,
    oldestStartedAt,
    runtimeLabel,
    statusLabel:
      activeRuns > 0
        ? `${activeRuns} 个任务正在后台运行${runtimeLabel ? ` · ${runtimeLabel}` : ""}`
        : "当前没有运行中的任务",
    tooltip:
      activeRuns > 0
        ? `AporiaX · ${activeRuns} 个任务运行中${runtimeLabel ? ` · ${runtimeLabel}` : ""}`
        : "AporiaX",
  };
}

export function trayEducationNotificationText() {
  return {
    title: "AporiaX 已收至系统托盘",
    body: "任务会继续在后台运行。点击托盘图标可重新打开，选择“退出 AporiaX”可完全退出。",
  };
}

export function taskCompletionToastSuppressionCss() {
  return `${TASK_COMPLETION_TOAST_SELECTOR}{display:none!important;}`;
}
