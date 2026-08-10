import { Menu, Notification, Tray, app } from "electron";
import { access, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TRAY_EDUCATION_MARKER,
  desktopBackgroundStatus,
  shouldHideWindowOnClose,
  taskCompletionToastSuppressionCss,
  trayEducationNotificationText,
} from "./desktop-background-state.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(currentDirectory, "..");

export function installDesktopBackground() {
  let tray = null;
  let mainWindow = null;
  let isQuitting = false;
  let disposed = false;
  let trayRefreshTimer = null;
  let trayHintHandledThisSession = false;
  const activeRunRefs = new Map();

  const activeRuns = () =>
    [...activeRunRefs.entries()].map(([id, state]) => ({
      id,
      startedAt: state.startedAt,
    }));
  const status = () => desktopBackgroundStatus(activeRuns());

  const showMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.flashFrame(false);
    return true;
  };

  const stopTrayRefreshTimer = () => {
    if (!trayRefreshTimer) return;
    clearInterval(trayRefreshTimer);
    trayRefreshTimer = null;
  };

  const ensureTrayRefreshTimer = () => {
    if (activeRunRefs.size === 0) {
      stopTrayRefreshTimer();
      return;
    }
    if (trayRefreshTimer) return;
    trayRefreshTimer = setInterval(() => updateTray(), 1_000);
    trayRefreshTimer.unref?.();
  };

  const updateTray = () => {
    if (!tray || tray.isDestroyed()) return;
    const current = status();
    tray.setToolTip(current.tooltip);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: current.statusLabel,
          enabled: false,
        },
        { type: "separator" },
        {
          label: "打开 AporiaX",
          click: showMainWindow,
        },
        {
          label: "退出 AporiaX",
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ]),
    );
    ensureTrayRefreshTimer();
  };

  const maybeShowTrayEducation = async () => {
    if (trayHintHandledThisSession || disposed) return;
    trayHintHandledThisSession = true;

    const markerPath = join(app.getPath("userData"), TRAY_EDUCATION_MARKER);
    try {
      await access(markerPath);
      return;
    } catch {
      // No marker means the user has not seen the close-to-tray explanation yet.
    }

    if (!Notification.isSupported()) return;
    try {
      const text = trayEducationNotificationText();
      const notification = new Notification(text);
      notification.on("click", showMainWindow);
      notification.show();
      await writeFile(markerPath, new Date().toISOString(), "utf8");
    } catch {
      // Tray education is non-critical and must never interfere with hiding.
    }
  };

  const createTray = () => {
    if (disposed || tray) return;
    tray = new Tray(join(projectRoot, "build", "icon.ico"));
    tray.on("click", showMainWindow);
    tray.on("double-click", showMainWindow);
    updateTray();
  };

  const attachMainWindow = (window) => {
    if (mainWindow && !mainWindow.isDestroyed()) return;
    mainWindow = window;

    window.on("close", (event) => {
      if (!shouldHideWindowOnClose({ isQuitting })) return;
      event.preventDefault();
      window.hide();
      updateTray();
      void maybeShowTrayEducation();
    });

    window.on("closed", () => {
      if (mainWindow === window) mainWindow = null;
    });

    window.webContents.on("did-finish-load", () => {
      // Windows system notifications remain the canonical completion notice.
      // Keep renderer state/history intact and suppress only the duplicate
      // in-app completion toast. Per-task elapsed time is renderer-owned now.
      void window.webContents
        .insertCSS(taskCompletionToastSuppressionCss())
        .catch(() => undefined);
    });
  };

  const handleWindowCreated = (_event, window) => attachMainWindow(window);
  const handleBeforeQuit = () => {
    isQuitting = true;
  };
  const handleWillQuit = () => {
    disposed = true;
    stopTrayRefreshTimer();
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
  };
  const handleActivate = () => {
    showMainWindow();
  };

  app.on("browser-window-created", handleWindowCreated);
  app.on("before-quit", handleBeforeQuit);
  app.on("will-quit", handleWillQuit);
  app.on("activate", handleActivate);
  void app.whenReady().then(createTray);

  return {
    runStarted(runId, { startedAt = Date.now() } = {}) {
      const id = String(runId || "").trim();
      if (!id) return status();
      const current = activeRunRefs.get(id);
      activeRunRefs.set(id, {
        references: (current?.references || 0) + 1,
        startedAt: current?.startedAt || Number(startedAt) || Date.now(),
      });
      updateTray();
      return status();
    },
    runFinished(runId) {
      const id = String(runId || "").trim();
      const current = activeRunRefs.get(id);
      if (!current || current.references <= 1) activeRunRefs.delete(id);
      else {
        activeRunRefs.set(id, {
          ...current,
          references: current.references - 1,
        });
      }
      updateTray();
      return status();
    },
    show: showMainWindow,
    snapshot() {
      return {
        ...status(),
        trayReady: Boolean(tray && !tray.isDestroyed()),
        windowVisible: Boolean(
          mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible(),
        ),
        isQuitting,
      };
    },
  };
}
