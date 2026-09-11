import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FLAG_NAME = "gpu-fallback.json";

function flagPath() {
  try {
    return join(app.getPath("userData"), FLAG_NAME);
  } catch {
    return "";
  }
}

function readFlag() {
  try {
    const path = flagPath();
    if (!path || !existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeFlag(data) {
  try {
    const path = flagPath();
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data));
  } catch {
    /* A missing userData directory must not block startup. */
  }
}

function clearGpuCaches() {
  try {
    const root = app.getPath("userData");
    for (const name of ["GPUCache", "ShaderCache", "DawnGraphiteCache", "DawnWebGPUCache"]) {
      rmSync(join(root, name), { recursive: true, force: true });
    }
  } catch {
    /* Cache files may be locked by a dying GPU process. */
  }
}

export function installGpuGuard() {
  // Chromium quits after three GPU process crashes. Keep the window alive.
  app.commandLine.appendSwitch("disable-gpu-process-crash-limit");
  const previous = readFlag();
  if (previous?.disableHardwareAcceleration) {
    clearGpuCaches();
    app.disableHardwareAcceleration();
  }

  app.on("child-process-gone", (_event, details) => {
    if (details?.type !== "GPU") return;
    const current = readFlag() || {};
    writeFlag({
      crashes: Number(current.crashes || 0) + 1,
      disableHardwareAcceleration: true,
      reason: details.reason || "",
      exitCode: details.exitCode,
      at: Date.now(),
    });
  });
}

installGpuGuard();
