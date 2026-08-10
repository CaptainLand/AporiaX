import { Menu, Tray, app } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  desktopBackgroundStatus,
  shouldHideWindowOnClose,
  taskCompletionToastSuppressionCss,
} from "./desktop-background-state.js";
import {
  rendererTaskControlsCss,
  rendererTaskControlsScript,
} from "./desktop-task-controls.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(currentDirectory, "..");

export function installDesktopBackground() {
  let tray = null;
  let mainWindow = null;
  let isQuitting = false;
  let disposed = false;
  let refreshTimer = null;
  const activeRunRefs = new Map();

  const activeRunRecords = () =>
    [...activeRunRefs.entries()].map(([runId, state]) => ({
      runId,
      startedAt: state.startedAt,
    }));
  const status = () => desktopBackgroundStatus(activeRunRecords());

  const showMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.flashFrame(false);
    return true;
  };

  const stopRefreshTimer = () => {
    if (!refreshTimer) return;
    clearInterval(refreshTimer);
    refreshTimer = null;
  };

  const ensureRefreshTimer = () => {
    if (!activeRunRefs.size) {
      stopRefreshTimer();
      return;
    }
    if (refreshTimer) return;
    refreshTimer = setInterval(() => updateTray(), 1_000);
    refreshTimer.unref?.();
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
    ensureRefreshTimer();
  };

  const createTray = () => {
    if (disposed || tray) return;
    tray = new Tray(join(projectRoot, "build", "icon.ico"));
    tray.on("click", showMainWindow);
    tray.on("double-click", showMainWindow);
    updateTray();
  };

  const installRendererControls = (window) => {
    // The Windows notification remains the canonical completion notice. The
    // injected controls only add elapsed time and the explicit Agent topology
    // toggle, keeping the large compatibility renderer untouched.
    void window.webContents
      .insertCSS(
        `${taskCompletionToastSuppressionCss()}\n${rendererTaskControlsCss()}`,
      )
      .catch(() => undefined);
    void window.webContents
      .executeJavaScript(rendererTaskControlsScript(), true)
      .catch(() => undefined);
  };

  const attachMainWindow = (window) => {
    if (mainWindow && !mainWindow.isDestroyed()) return;
    mainWindow = window;

    window.on("close", (event) => {
      if (!shouldHideWindowOnClose({ isQuitting })) return;
      event.preventDefault();
      window.hide();
      updateTray();
    });

    window.on("closed", () => {
      if (mainWindow === window) mainWindow = null;
    });

    window.webContents.on("did-finish-load", () => {
      installRendererControls(window);
    });
  };

  const handleWindowCreated = (_event, window) => attachMainWindow(window);
  const handleBeforeQuit = () => {
    isQuitting = true;
  };
  const handleWillQuit = () => {
    disposed = true;
    stopRefreshTimer();
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
        startedAt: current?.startedAt || startedAt,
      });
      updateTray();
      return status();
    },
    runFinished(runId) {
      const id = String(runId || "").trim();
      const current = activeRunRefs.get(id);
      if (!current) return status();
      if (current.references <= 1) activeRunRefs.delete(id);
      else {
        activeRunRefs.set(id, {
          ...current,
          references: current.references - 1,
        });
      }
      if (!activeRunRefs.size) stopRefreshTimer();
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
