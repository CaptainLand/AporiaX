import { app, ipcMain } from "electron";
import { installDesktopBackground } from "./desktop-background.js";
import { createHarnessKernel } from "./harness/kernel.js";
import { createHarnessCoreServer } from "./harness/core-server.js";
import { setDefaultHarnessEventBus } from "./harness/event-bus.js";
import {
  planAgentBudget,
  runWithAgentBudget,
} from "./harness/agent-budget.js";
import { prepareVisionProxyRequest } from "./vision-proxy.js";

// Install desktop background behavior before the compatibility main process
// creates its BrowserWindow. The close event is intercepted and hidden to the
// tray, so the renderer and active Harness IPC calls stay alive in background.
const desktopBackground = installDesktopBackground();

// Install the per-run budget boundary before the legacy desktop main process
// registers harness:run. This keeps the migration incremental while making the
// cost guard effective for the existing runtime today.
const nativeHandle = ipcMain.handle.bind(ipcMain);
const originalHandle = ipcMain.handle;
ipcMain.handle = function budgetAwareHandle(channel, listener) {
  if (channel !== "harness:run") return nativeHandle(channel, listener);
  return nativeHandle(channel, async (event, request) => {
    const budget = planAgentBudget(request || {});
    const runId = String(request?.runId || "").trim();
    desktopBackground.runStarted(runId);
    try {
      const preparedRequest = await prepareVisionProxyRequest(request);
      return await runWithAgentBudget(budget, {}, () =>
        listener(event, preparedRequest),
      );
    } finally {
      desktopBackground.runFinished(runId);
    }
  });
};

await import("./main.js");
ipcMain.handle = originalHandle;

const kernel = createHarnessKernel();
setDefaultHarnessEventBus(kernel.events);
const coreServer = createHarnessCoreServer({ kernel });

ipcMain.handle("core:status", () => ({
  running: Boolean(coreServer.url),
  url: coreServer.url,
  capabilities: kernel.capabilities(),
}));
ipcMain.handle("core:agents", () => ({ agents: kernel.agents.list() }));
ipcMain.handle("core:plugins", () => ({ plugins: kernel.plugins.list() }));
ipcMain.handle("core:sessions", () => ({ sessions: kernel.sessions.list() }));
ipcMain.handle("core:events", (_event, request = {}) => ({
  events: kernel.events.history(request),
}));
ipcMain.handle("core:agent-budget", (_event, request = {}) => ({
  budget: planAgentBudget(request),
}));
ipcMain.handle("desktop:background-status", () => desktopBackground.snapshot());

app.whenReady().then(() => coreServer.listen()).catch(() => undefined);
app.on("before-quit", () => {
  coreServer.close().catch(() => undefined);
});

export {
  kernel as harnessKernel,
  coreServer as harnessCoreServer,
  desktopBackground,
};
