import { app } from "electron";

export function installGpuGuard(electronApp = app) {
  // Keep the window alive while Chromium recovers its GPU process. AporiaX
  // does not disable acceleration or persist a fallback after process exits.
  // Legacy gpu-fallback.json files are intentionally ignored, not deleted.
  electronApp.commandLine.appendSwitch("disable-gpu-process-crash-limit");
}

installGpuGuard();
