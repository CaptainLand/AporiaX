import { BrowserWindow, Notification, app, ipcMain } from "electron";
import { createDesktopAccountRuntime } from "./desktop-account-runtime.js";
import { onCloudModelActivity } from "./account-events.js";

const LOW_QUOTA_RATIO = 0.2;
const QUOTA_REFRESH_DEBOUNCE_MS = 120;

let runtime = null;
let activityUnsubscribe = null;
let quotaRefreshTimer = null;
let quotaRefreshPromise = null;
let warnedQuotaCycle = "";

function quotaRatio(snapshot) {
  const value = Number(snapshot?.quota?.remainingRatio);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

function quotaCycleKey(snapshot) {
  const quota = snapshot?.quota;
  return String(quota?.cycleStart || quota?.cycleEnd || "").trim();
}

function focusDesktop() {
  const window = BrowserWindow.getAllWindows().find((entry) => !entry.isDestroyed());
  if (!window) return false;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.flashFrame(false);
  return true;
}

function maybeNotifyLowQuota(snapshot) {
  if (snapshot?.status !== "authenticated") return false;
  const ratio = quotaRatio(snapshot);
  const cycleKey = quotaCycleKey(snapshot);
  if (ratio === null || ratio > LOW_QUOTA_RATIO) {
    warnedQuotaCycle = "";
    return false;
  }
  // Exhaustion is already surfaced by the model error path. The proactive
  // notification is reserved for the useful window where the user can still
  // switch to a local model before the weekly quota reaches zero.
  if (ratio <= 0 || !cycleKey || warnedQuotaCycle === cycleKey) return false;
  warnedQuotaCycle = cycleKey;
  if (!Notification.isSupported()) return false;

  const percent = Math.max(1, Math.round(ratio * 100));
  try {
    const notification = new Notification({
      title: "AporiaX · Cloud 周额度偏低",
      body: `本周 Aporia Cloud 额度剩余 ${percent}%。建议切换到本地模型继续长任务，避免中途耗尽。`,
      silent: false,
    });
    notification.on("click", focusDesktop);
    notification.show();
    return true;
  } catch {
    return false;
  }
}

function publishAccountSnapshot(snapshot) {
  if (!snapshot) return snapshot;
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send("account:changed", snapshot);
  }
  maybeNotifyLowQuota(snapshot);
  return snapshot;
}

async function refreshQuotaAfterCloudActivity() {
  if (!runtime) return null;
  if (quotaRefreshPromise) return quotaRefreshPromise;
  quotaRefreshPromise = runtime
    .refresh()
    .then(publishAccountSnapshot)
    .catch(() => null)
    .finally(() => {
      quotaRefreshPromise = null;
    });
  return quotaRefreshPromise;
}

function scheduleQuotaRefresh() {
  if (quotaRefreshTimer) clearTimeout(quotaRefreshTimer);
  quotaRefreshTimer = setTimeout(() => {
    quotaRefreshTimer = null;
    void refreshQuotaAfterCloudActivity();
  }, QUOTA_REFRESH_DEBOUNCE_MS);
  quotaRefreshTimer.unref?.();
}

function ensureRuntimeObservers() {
  if (activityUnsubscribe) return;
  activityUnsubscribe = onCloudModelActivity(() => scheduleQuotaRefresh());
}

export function getDesktopAccountRuntime() {
  if (!runtime) runtime = createDesktopAccountRuntime();
  ensureRuntimeObservers();
  return runtime;
}

ipcMain.handle("account:get", async () =>
  publishAccountSnapshot(await getDesktopAccountRuntime().getSnapshot()),
);
ipcMain.handle("account:sign-in", async () =>
  publishAccountSnapshot(await getDesktopAccountRuntime().startBrowserLogin()),
);
ipcMain.handle("account:refresh", async () =>
  publishAccountSnapshot(await getDesktopAccountRuntime().refresh()),
);
ipcMain.handle("account:sign-out", async () => {
  warnedQuotaCycle = "";
  return publishAccountSnapshot(await getDesktopAccountRuntime().signOut());
});

app.on("before-quit", () => {
  if (quotaRefreshTimer) clearTimeout(quotaRefreshTimer);
  quotaRefreshTimer = null;
  activityUnsubscribe?.();
  activityUnsubscribe = null;
  runtime?.close();
});
