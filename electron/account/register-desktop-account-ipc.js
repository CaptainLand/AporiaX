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
ipcMain.handle("account:set-remote-enabled", (_event, enabled) =>
  getDesktopAccountRuntime().setRemoteEnabled(Boolean(enabled)),
);
ipcMain.handle("account:set-remote-file-access", (_event, enabled) =>
  getDesktopAccountRuntime().setRemoteFileAccess(Boolean(enabled)),
);
ipcMain.handle("account:sync-tasks", (_event, payload) =>
  getDesktopAccountRuntime().syncRemoteTasks(payload),
);
ipcMain.handle("account:remote-commands", () =>
  getDesktopAccountRuntime().pollRemoteCommands(),
);
ipcMain.handle("account:ack-remote-command", (_event, commandId, status, result) =>
  getDesktopAccountRuntime().acknowledgeRemoteCommand(commandId, status, result),
);
ipcMain.handle("account:execute-remote-file-command", (_event, command) =>
  getDesktopAccountRuntime().executeRemoteFileCommand(command),
);

app.on("before-quit", () => {
  runtime?.close();
});
