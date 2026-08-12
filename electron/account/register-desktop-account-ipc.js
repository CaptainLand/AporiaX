import { app, ipcMain } from "electron";
import { createDesktopAccountRuntime } from "./desktop-account-runtime.js";

let runtime = null;

export function getDesktopAccountRuntime() {
  if (!runtime) runtime = createDesktopAccountRuntime();
  return runtime;
}

ipcMain.handle("account:get", () => getDesktopAccountRuntime().getSnapshot());
ipcMain.handle("account:sign-in", () => getDesktopAccountRuntime().startBrowserLogin());
ipcMain.handle("account:refresh", () => getDesktopAccountRuntime().refresh());
ipcMain.handle("account:sign-out", () => getDesktopAccountRuntime().signOut());

app.on("before-quit", () => {
  runtime?.close();
});
