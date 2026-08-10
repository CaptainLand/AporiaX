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

function normalizeTimestamp(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatDesktopRunDuration(milliseconds) {
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

export function normalizeActiveRunRecords(runs = []) {
  const values =
    runs instanceof Map
      ? [...runs.values()]
      : Array.isArray(runs)
        ? runs
        : runs instanceof Set
          ? [...runs]
          : [];
  const byId = new Map();
  for (const value of values) {
    const record = value && typeof value === "object" ? value : { runId: value };
    const runId = String(record.runId || record.id || "").trim();
    if (!runId) continue;
    byId.set(runId, {
      runId,
      startedAt: normalizeTimestamp(record.startedAt),
    });
  }
  return [...byId.values()];
}

export function desktopBackgroundStatus(runs = [], now = Date.now()) {
  const activeRunRecords = normalizeActiveRunRecords(runs);
  const activeRunIds = activeRunRecords.map((record) => record.runId);
  const activeRuns = activeRunIds.length;
  const validStarts = activeRunRecords
    .map((record) => record.startedAt)
    .filter((value) => Number.isFinite(value));
  const startedAt = validStarts.length ? Math.min(...validStarts) : null;
  const elapsedMs = Number.isFinite(startedAt)
    ? Math.max(0, Number(now) - startedAt)
    : null;
  const durationLabel = Number.isFinite(elapsedMs)
    ? formatDesktopRunDuration(elapsedMs)
    : "";
  return {
    activeRunIds,
    activeRunRecords,
    activeRuns,
    startedAt,
    elapsedMs,
    durationLabel,
    statusLabel:
      activeRuns > 0
        ? `${activeRuns} 个任务正在后台运行${durationLabel ? ` · ${durationLabel}` : ""}`
        : "当前没有运行中的任务",
    tooltip:
      activeRuns > 0
        ? `AporiaX · ${activeRuns} 个任务运行中${durationLabel ? ` · ${durationLabel}` : ""}`
        : "AporiaX",
  };
}

export function taskCompletionToastSuppressionCss() {
  return `${TASK_COMPLETION_TOAST_SELECTOR}{display:none!important;}`;
}
