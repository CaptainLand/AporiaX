import { handleTrustedIpc, assertTrustedIpcSender } from "./security/trusted-ipc.js";
import { BrowserWindow, app, ipcMain, shell } from "electron";
import electronUpdater from "electron-updater";
import { loadCloudEndpoints } from "./account/cloud-endpoints.js";
import {
  LATEST_RELEASE_URL,
  LATEST_YML_URL,
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

export function installAppUpdate({ getActiveRunCount } = {}) {
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
  // Never persist this throttle: every new app process must check at least once.
  let lastAttemptAt = 0;
  let pendingCheck = null;
  let selectedFeed = LATEST_YML_URL;
  const metadataUrls = [LATEST_YML_URL];
  const endpoints = loadCloudEndpoints();
  if (endpoints.configured && new URL(endpoints.accountWebUrl).protocol === "https:") {
    metadataUrls.push(endpoints.accountWebUrl + "/downloads/latest.yml");
  }

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
    // The operator publishes preview releases as GitHub Latest. Use that exact
    // YAML channel, not electron-updater's inferred "preview.yml" channel.
    autoUpdater.setFeedURL({ provider: "generic", url: LATEST_YML_URL.replace(/latest\.yml$/, ""), channel: "latest" });
    autoUpdater.allowPrerelease = true;
    autoUpdater.allowDowngrade = false;
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

  const readPublishedUpdate = async () => {
    let failure;
    for (const url of metadataUrls) {
      try {
        const response = await fetch(url, {
          headers: { "User-Agent": "AporiaX-Desktop", Accept: "text/yaml,text/plain,*/*" },
          redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error("Update metadata HTTP " + response.status);
        const parsed = parseLatestYml(await response.text());
        isNewerVersion(parsed.version, currentVersion());
        if (!/^AporiaX-Setup-[0-9A-Za-z.+-]+-x64\.exe$/.test(parsed.path)) throw new Error("INVALID_UPDATE_ASSET");
        selectedFeed = url;
        return parsed;
      } catch (error) { failure = error; }
    }
    throw failure;
  };
  const checkPortable = async () => {
    setStatus({ phase: "checking", availableVersion: status.availableVersion });
    const parsed = await readPublishedUpdate();
    if (isNewerVersion(parsed.version, currentVersion())) {
      return setStatus({
        phase: "available",
        availableVersion: parsed.version,
      });
    }
    return setStatus({ phase: "not-available", availableVersion: "" });
  };

  const checkNsis = async () => {
    setStatus({ phase: "checking", availableVersion: status.availableVersion });
    await readPublishedUpdate();
    configureUpdater();
    autoUpdater.setFeedURL({ provider: "generic", url: selectedFeed.replace(/latest\.yml$/, ""), channel: "latest" });
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
    if (pendingCheck) return pendingCheck;
    if (status.busy || downloaded) return status;
    const retryMs = status.phase === "error" ? 60_000 : undefined;
    if (!force && shouldSkipAutoCheck(lastAttemptAt, Date.now(), retryMs)) return status;
    lastAttemptAt = Date.now();
    pendingCheck = (async () => {
      try {
        return await (channel() === "portable" ? checkPortable() : checkNsis());
      } catch (failure) {
        return setStatus({ phase: "error", availableVersion: status.availableVersion,
          error: String(failure?.message || failure || "Update check failed") });
      }
    })();
    try { return await pendingCheck; } finally { pendingCheck = null; }
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
