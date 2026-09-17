import { handleTrustedIpc, assertTrustedIpcSender } from "./security/trusted-ipc.js";
import { BrowserWindow, app, ipcMain, shell } from "electron";
import electronUpdater from "electron-updater";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LATEST_RELEASE_URL,
  LATEST_YML_URL,
  UPDATE_STATE_FILE,
  createUpdateStatus,
  installUpdateDecision,
  isNewerVersion,
  isPortableBuild,
  parseLatestYml,
  shouldSkipAutoCheck,
  updateChannel,
} from "./app-update-core.js";

const autoUpdater = electronUpdater.autoUpdater;

function broadcast(status) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send("update:event", status);
  }
}

async function readLastCheckedAt(userDataDirectory) {
  try {
    const raw = await readFile(join(userDataDirectory, UPDATE_STATE_FILE), "utf8");
    const parsed = JSON.parse(raw);
    return Number(parsed?.lastCheckedAt) || 0;
  } catch {
    return 0;
  }
}

async function writeLastCheckedAt(userDataDirectory, lastCheckedAt) {
  try {
    await writeFile(
      join(userDataDirectory, UPDATE_STATE_FILE),
      JSON.stringify({ lastCheckedAt }, null, 2),
      "utf8",
    );
  } catch {
    // Persistence is optional; the next launch can check again.
  }
}

export function installAppUpdate({ getActiveRunCount } = {}) {
  const userDataDirectory = () => app.getPath("userData");
  const packaged = () => app.isPackaged;
  const portable = () => isPortableBuild(process.env);
  const channel = () => updateChannel({ packaged: packaged(), portable: portable() });
  const currentVersion = () => app.getVersion();
  const activeRuns = () => Number(getActiveRunCount?.() || 0) || 0;

  let status = createUpdateStatus({
    phase: packaged() ? "idle" : "dev",
    currentVersion: currentVersion(),
    channel: channel(),
    packaged: packaged(),
  });
  let downloaded = false;
  let configured = false;

  const setStatus = (next) => {
    status = createUpdateStatus({
      currentVersion: currentVersion(),
      channel: channel(),
      packaged: packaged(),
      releaseUrl: LATEST_RELEASE_URL,
      ...next,
    });
    broadcast(status);
    return status;
  };

  const configureUpdater = () => {
    if (configured || channel() !== "nsis") return;
    configured = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null;
    autoUpdater.on("checking-for-update", () => {
      setStatus({ phase: "checking", availableVersion: status.availableVersion });
    });
    autoUpdater.on("update-available", (info) => {
      downloaded = false;
      setStatus({
        phase: "available",
        availableVersion: info?.version || "",
      });
    });
    autoUpdater.on("update-not-available", () => {
      downloaded = false;
      setStatus({ phase: "not-available", availableVersion: "" });
    });
    autoUpdater.on("download-progress", (progress) => {
      setStatus({
        phase: "downloading",
        availableVersion: status.availableVersion,
        downloadPercent: progress?.percent,
      });
    });
    autoUpdater.on("update-downloaded", (info) => {
      downloaded = true;
      setStatus({
        phase: "downloaded",
        availableVersion: info?.version || status.availableVersion,
        downloadPercent: 100,
      });
    });
    autoUpdater.on("error", (failure) => {
      setStatus({
        phase: "error",
        availableVersion: status.availableVersion,
        downloadPercent: status.downloadPercent,
        error: String(failure?.message || failure || "Update failed"),
      });
    });
  };

  const checkPortable = async () => {
    setStatus({ phase: "checking" });
    const response = await fetch(LATEST_YML_URL, {
      headers: { "User-Agent": "AporiaX-Desktop", Accept: "text/yaml,text/plain,*/*" },
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`GitHub latest.yml HTTP ${response.status}`);
    }
    const parsed = parseLatestYml(await response.text());
    if (!parsed.version) throw new Error("GitHub latest.yml is missing a version");
    if (isNewerVersion(parsed.version, currentVersion())) {
      return setStatus({
        phase: "available",
        availableVersion: parsed.version,
      });
    }
    return setStatus({ phase: "not-available", availableVersion: "" });
  };

  const checkNsis = async () => {
    configureUpdater();
    const result = await autoUpdater.checkForUpdates();
    const remote = String(result?.updateInfo?.version || "").trim();
    if (remote && isNewerVersion(remote, currentVersion())) {
      downloaded = false;
      return setStatus({ phase: "available", availableVersion: remote });
    }
    downloaded = false;
    return setStatus({ phase: "not-available", availableVersion: "" });
  };

  const check = async ({ force = false } = {}) => {
    if (!packaged()) {
      return setStatus({ phase: "dev" });
    }
    if (status.busy) return status;
    if (!force && shouldSkipAutoCheck(await readLastCheckedAt(userDataDirectory()))) {
      return status;
    }
    try {
      const next =
        channel() === "portable" ? await checkPortable() : await checkNsis();
      await writeLastCheckedAt(userDataDirectory(), Date.now());
      return next;
    } catch (failure) {
      return setStatus({
        phase: "error",
        error: String(failure?.message || failure || "Update check failed"),
      });
    }
  };

  const download = async () => {
    if (channel() === "portable") {
      await shell.openExternal(LATEST_RELEASE_URL);
      return status;
    }
    if (channel() !== "nsis") {
      return setStatus({ phase: "dev" });
    }
    if (status.phase !== "available" && status.phase !== "error") return status;
    configureUpdater();
    downloaded = false;
    setStatus({
      phase: "downloading",
      availableVersion: status.availableVersion,
      downloadPercent: 0,
    });
    try {
      await autoUpdater.downloadUpdate();
      return status;
    } catch (failure) {
      return setStatus({
        phase: "error",
        availableVersion: status.availableVersion,
        error: String(failure?.message || failure || "Download failed"),
      });
    }
  };

  const install = async () => {
    const decision = installUpdateDecision({
      channel: channel(),
      downloaded: downloaded || status.phase === "downloaded",
      activeRuns: activeRuns(),
    });
    if (!decision.ok) {
      return setStatus({
        phase: status.phase === "downloaded" ? "downloaded" : "error",
        availableVersion: status.availableVersion,
        downloadPercent: status.phase === "downloaded" ? 100 : status.downloadPercent,
        error:
          decision.code === "TASK_RUNNING"
            ? "TASK_RUNNING"
            : decision.code === "NOT_DOWNLOADED"
              ? "NOT_DOWNLOADED"
              : "UNSUPPORTED_CHANNEL",
      });
    }
    autoUpdater.quitAndInstall(false, true);
    return status;
  };

  const openRelease = async () => {
    await shell.openExternal(LATEST_RELEASE_URL);
    return status;
  };

  handleTrustedIpc(ipcMain, "update:status", () => status);
  handleTrustedIpc(ipcMain, "update:check", (_event, request = {}) =>
    check({ force: Boolean(request?.force) }),
  );
  handleTrustedIpc(ipcMain, "update:download", () => download());
  handleTrustedIpc(ipcMain, "update:install", () => install());
  handleTrustedIpc(ipcMain, "update:open-release", () => openRelease());

  return {
    snapshot: () => status,
    check,
    download,
    install,
    openRelease,
  };
}
