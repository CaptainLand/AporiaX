export const TASKS_STORAGE_KEY = "aporiax.tasks.v1";

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

export function readTaskListFromStorage(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(TASKS_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function assistantMessageCount(task) {
  return (Array.isArray(task?.messages) ? task.messages : []).filter(
    (message) => message?.role === "assistant",
  ).length;
}

export function selectVisibleTask(
  tasks,
  { title = "", workspace = "", assistantCount = null } = {},
) {
  const records = Array.isArray(tasks) ? tasks : [];
  const normalizedTitle = String(title || "").trim();
  const normalizedWorkspace = String(workspace || "").trim();
  const candidates = records.filter((task) => {
    if (
      normalizedTitle &&
      String(task?.title || "").trim() !== normalizedTitle
    ) {
      return false;
    }
    if (
      normalizedWorkspace &&
      String(task?.workspaceName || "").trim() !== normalizedWorkspace
    ) {
      return false;
    }
    return true;
  });

  if (!candidates.length) return null;
  if (Number.isFinite(Number(assistantCount))) {
    const expectedCount = Number(assistantCount);
    const exact = candidates.find(
      (task) => assistantMessageCount(task) === expectedCount,
    );
    if (exact) return exact;

    // AporiaX deliberately truncates oversized localStorage task caches. Once
    // that happens, matching the visible DOM to the shortened message array by
    // index shifts every later assistant turn and makes elapsed-time/status UI
    // disappear or attach to the wrong round. Treat a count mismatch as a
    // stale/incomplete snapshot so callers can fall back to the authoritative
    // desktop task history instead of guessing.
    return null;
  }
  return candidates[0] || null;
}

function modelDisplayName(model, fallback = "") {
  return String(
    model?.shortName || model?.name || model?.id || fallback || "",
  ).trim();
}

export function resolveVisionCapability(providers, task) {
  const records = Array.isArray(providers) ? providers : [];
  const provider =
    records.find((candidate) => candidate?.id === task?.providerId) || null;
  const model =
    provider?.models?.find(
      (candidate) => String(candidate?.id || "") === String(task?.modelId || ""),
    ) || null;

  const nativeSupportsImages = Boolean(
    model?.nativeSupportsImages === true ||
      (model?.supportsImages === true && model?.supportsImageProxy !== true),
  );
  const proxy =
    !nativeSupportsImages && model?.supportsImageProxy === true
      ? model?.visionProxy || null
      : null;
  const proxyEnabled = Boolean(proxy?.modelId);
  const available = nativeSupportsImages || proxyEnabled;

  return {
    available,
    mode: nativeSupportsImages ? "native" : proxyEnabled ? "proxy" : "none",
    providerId: String(provider?.id || task?.providerId || ""),
    providerName: String(provider?.name || ""),
    mainModelId: String(model?.id || task?.modelId || ""),
    mainModelName: modelDisplayName(model, task?.modelId),
    proxy: proxyEnabled
      ? {
          providerId: String(proxy.providerId || ""),
          providerName: String(proxy.providerName || ""),
          modelId: String(proxy.modelId || ""),
          modelName: String(proxy.modelName || proxy.modelId || ""),
        }
      : null,
  };
}
