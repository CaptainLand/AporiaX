import { BrowserWindow, ipcMain, screen } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVAL_TOAST_TIMEOUT_MS,
  approvalToastCopy,
} from "./approval-toast-state.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

let active = null;
let ipcBound = false;

function workArea() {
  return screen.getPrimaryDisplay()?.workArea || { x: 0, y: 0, width: 1280, height: 720 };
}

function place(window) {
  const area = workArea();
  const { width, height } = window.getBounds();
  window.setPosition(
    Math.round(area.x + area.width - width - 24),
    Math.round(area.y + area.height - height - 24),
    false,
  );
}

function bindIpc() {
  if (ipcBound) return;
  ipcBound = true;
  ipcMain.on("approval-toast:decide", (event, approved) => {
    if (!active || event.sender !== active.window?.webContents) return;
    if (typeof approved !== "boolean") return;
    const decide = active.onDecide;
    closeApprovalToast();
    decide?.(approved);
  });
}

export function closeApprovalToast() {
  if (!active) return;
  const current = active;
  active = null;
  clearTimeout(current.timer);
  if (current.window && !current.window.isDestroyed()) {
    current.window.close();
  }
}

export function showApprovalToast({
  approval,
  language,
  theme = "light",
  onDecide,
  timeoutMs = APPROVAL_TOAST_TIMEOUT_MS,
} = {}) {
  bindIpc();
  closeApprovalToast();
  const copy = approvalToastCopy(approval, language);
  const window = new BrowserWindow({
    width: 396,
    height: 204,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(currentDirectory, "approval-toast-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setHasShadow(false);
  window.setAlwaysOnTop(true, "status");
  window.setMenuBarVisibility(false);
  const timer = setTimeout(() => {
    if (active?.window === window) closeApprovalToast();
  }, Math.max(0, Number(timeoutMs) || APPROVAL_TOAST_TIMEOUT_MS));
  active = {
    window,
    timer,
    approvalId: String(approval?.id || ""),
    onDecide,
  };
  window.on("closed", () => {
    if (active?.window !== window) return;
    clearTimeout(active.timer);
    active = null;
  });
  window.webContents.once("did-finish-load", () => {
    if (window.isDestroyed()) return;
    window.webContents.send("approval-toast:payload", { ...copy, theme });
    place(window);
    window.showInactive();
  });
  void window.loadFile(join(currentDirectory, "approval-toast.html"));
  return closeApprovalToast;
}

export function approvalToastApprovalId() {
  return active?.approvalId || "";
}
