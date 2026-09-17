import { handleTrustedIpc, assertTrustedIpcSender } from "../security/trusted-ipc.js";
import { app, ipcMain } from "electron";
import { createDesktopAccountRuntime } from "./desktop-account-runtime.js";

let runtime = null;

export function getDesktopAccountRuntime() {
  if (!runtime) runtime = createDesktopAccountRuntime();
  return runtime;
}

handleTrustedIpc(ipcMain, "account:get", () => getDesktopAccountRuntime().getSnapshot());
handleTrustedIpc(ipcMain, "account:sign-in", () => getDesktopAccountRuntime().startBrowserLogin());
handleTrustedIpc(ipcMain, "account:refresh", () => getDesktopAccountRuntime().refresh());
handleTrustedIpc(ipcMain, "account:sign-out", () => getDesktopAccountRuntime().signOut());
handleTrustedIpc(ipcMain, "account:set-remote-enabled", (_event, enabled) =>
  getDesktopAccountRuntime().setRemoteEnabled(Boolean(enabled)),
);
handleTrustedIpc(ipcMain, "account:set-remote-file-access", (_event, enabled) =>
  getDesktopAccountRuntime().setRemoteFileAccess(Boolean(enabled)),
);
handleTrustedIpc(ipcMain, "account:sync-tasks", (_event, payload) =>
  getDesktopAccountRuntime().syncRemoteTasks(payload),
);
handleTrustedIpc(ipcMain, "account:remote-commands", () =>
  getDesktopAccountRuntime().pollRemoteCommands(),
);
const observedConsumers = new WeakSet();
handleTrustedIpc(ipcMain, "account:claim-remote-command", (event, commandId) => {
  const consumerId = String(event.sender.id);
  if (!observedConsumers.has(event.sender)) {
    observedConsumers.add(event.sender);
    const abandon = () => runtime?.abandonRemoteCommands(consumerId);
    event.sender.on("destroyed", abandon);
    event.sender.on("render-process-gone", abandon);
    event.sender.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) abandon();
    });
  }
  return getDesktopAccountRuntime().claimRemoteCommand(commandId, consumerId);
});
handleTrustedIpc(ipcMain, "account:ack-remote-command", (_event, commandId, status, result, claim) =>
  getDesktopAccountRuntime().acknowledgeRemoteCommand(commandId, status, result, claim),
);
handleTrustedIpc(ipcMain, "account:execute-remote-file-command", (_event, command) =>
  getDesktopAccountRuntime().executeRemoteFileCommand(command),
);

app.on("before-quit", () => {
  runtime?.close();
});
