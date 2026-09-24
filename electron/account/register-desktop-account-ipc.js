import { handleTrustedIpc } from "../security/trusted-ipc.js";
import { app, ipcMain } from "electron";
import { createDesktopAccountRuntime } from "./desktop-account-runtime.js";
import { privateCloudOptions } from "./private-cloud-bridge.js";
import { join } from "node:path";

let runtime = null;

export function getDesktopAccountRuntime() {
  if (!runtime) runtime = createDesktopAccountRuntime(privateCloudOptions({
    userDataPath: app.getPath("userData"),
    webRoot: app.isPackaged ? join(process.resourcesPath, "private-cloud-web")
      : join(app.getAppPath(), ".tmp", "aporiax-web-guide", ".tmp", "private-preview-web"),
  }));
  return runtime;
}

handleTrustedIpc(ipcMain, "account:get", () => getDesktopAccountRuntime().getSnapshot());
handleTrustedIpc(ipcMain, "account:sign-in", () => getDesktopAccountRuntime().startBrowserLogin());
handleTrustedIpc(ipcMain, "account:open-center", () => getDesktopAccountRuntime().openAccountCenter());
handleTrustedIpc(ipcMain, "account:refresh", () => getDesktopAccountRuntime().refresh());
handleTrustedIpc(ipcMain, "account:sign-out", () => getDesktopAccountRuntime().signOut());
app.on("before-quit", () => {
  runtime?.close();
});
