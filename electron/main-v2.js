import { app, ipcMain } from "electron";
import { createHarnessKernel } from "./harness/kernel.js";
import { createHarnessCoreServer } from "./harness/core-server.js";
import { setDefaultHarnessEventBus } from "./harness/event-bus.js";
import {
  planAgentBudget,
  runWithAgentBudget,
} from "./harness/agent-budget.js";

// Install the per-run budget boundary before the legacy desktop main process
// registers harness:run. This keeps the migration incremental while making the
// cost guard effective for the existing runtime today.
const nativeHandle = ipcMain.handle.bind(ipcMain);
const originalHandle = ipcMain.handle;
ipcMain.handle = function budgetAwareHandle(channel, listener) {
  if (channel !== "harness:run") return nativeHandle(channel, listener);
  return nativeHandle(channel, (event, request) => {
    const budget = planAgentBudget(request || {});
    return runWithAgentBudget(budget, {}, () => listener(event, request));
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

app.whenReady().then(() => coreServer.listen()).catch(() => undefined);
app.on("before-quit", () => {
  coreServer.close().catch(() => undefined);
});

export { kernel as harnessKernel, coreServer as harnessCoreServer };