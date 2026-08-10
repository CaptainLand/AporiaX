import { app, ipcMain } from "electron";
import {
  applyDesktopAgentMode,
  normalizeDesktopAgentMode,
} from "./desktop-agent-mode.js";
import { installDesktopBackground } from "./desktop-background.js";
import { createHarnessKernel } from "./harness/kernel.js";
import { createHarnessCoreServer } from "./harness/core-server.js";
import { setDefaultHarnessEventBus } from "./harness/event-bus.js";
import {
  planAgentBudget,
  runWithAgentBudget,
} from "./harness/agent-budget.js";

// Install desktop background behavior before the compatibility main process
// creates its BrowserWindow. The close event is intercepted and hidden to the
// tray, so the renderer and active Harness IPC calls stay alive in background.
const desktopBackground = installDesktopBackground();

// The compact composer control owns an explicit topology policy switch. Single
// locks the run to Main-only. Multi restores the normal Adaptive Agent Budget,
// so AporiaX decides per task whether extra Agents are useful rather than
// forcing a fixed Main + 2 Builder topology.
let desktopAgentMode = "single";
ipcMain.handle("desktop:agent-mode-get", () => desktopAgentMode);
ipcMain.handle("desktop:agent-mode-set", (_event, mode) => {
  desktopAgentMode = normalizeDesktopAgentMode(mode);
  return desktopAgentMode;
});

// Install the per-run budget boundary before the legacy desktop main process
// registers harness:run. This keeps the migration incremental while making the
// cost guard effective for the existing runtime today.
const nativeHandle = ipcMain.handle.bind(ipcMain);
const originalHandle = ipcMain.handle;
ipcMain.handle = function budgetAwareHandle(channel, listener) {
  if (channel !== "harness:run") return nativeHandle(channel, listener);
  return nativeHandle(channel, async (event, request) => {
    const modeRequest = applyDesktopAgentMode(
      request || {},
      desktopAgentMode,
    );
    const budget = planAgentBudget(modeRequest);
    const runId = String(modeRequest?.runId || "").trim();
    desktopBackground.runStarted(runId, { startedAt: Date.now() });
    try {
      return await runWithAgentBudget(budget, {}, () =>
        listener(event, modeRequest),
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
  budget: planAgentBudget(
    applyDesktopAgentMode(request, desktopAgentMode),
  ),
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
