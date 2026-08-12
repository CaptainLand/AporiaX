import { app, ipcMain } from "electron";
import { createDesktopAccountRuntime } from "./desktop-account-runtime.js";

let runtime = null;

function accountRuntime() {
  if (!runtime) runtime = createDesktopAccountRuntime();
  return runtime;
}

ipcMain.handle("account:get", () => accountRuntime().getSnapshot());
ipcMain.handle("account:sign-in", () => accountRuntime().startBrowserLogin());
ipcMain.handle("account:refresh", () => accountRuntime().refresh());
ipcMain.handle("account:sign-out", () => accountRuntime().signOut());

app.on("before-quit", () => {
  runtime?.close();
});
