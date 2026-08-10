import { Menu, Tray, app } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  desktopBackgroundStatus,
  shouldHideWindowOnClose,
  taskCompletionToastSuppressionCss,
} from "./desktop-background-state.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(currentDirectory, "..");

export function installDesktopBackground() {
  let tray = null;
  let mainWindow = null;
  let isQuitting = false;
  let disposed = false;
  const activeRunRefs = new Map();

  const activeRunIds = () => activeRunRefs.keys();
  const status = () => desktopBackgroundStatus(activeRunIds());

  const showMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.flashFrame(false);
    return true;
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
    });

    window.on("closed", () => {
      if (mainWindow === window) mainWindow = null;
    });

    window.webContents.on("did-finish-load", () => {
      // The Windows system notification is the canonical completion notice.
      // Keep the existing renderer state/history intact, but suppress the
      // duplicate AporiaX in-app completion toast from the rendered UI.
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
    runStarted(runId) {
      const id = String(runId || "").trim();
      if (!id) return status();
      activeRunRefs.set(id, (activeRunRefs.get(id) || 0) + 1);
      updateTray();
      return status();
    },
    runFinished(runId) {
      const id = String(runId || "").trim();
      const references = activeRunRefs.get(id) || 0;
      if (references <= 1) activeRunRefs.delete(id);
      else activeRunRefs.set(id, references - 1);
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
