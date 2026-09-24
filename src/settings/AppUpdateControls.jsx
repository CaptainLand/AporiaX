import React, { useEffect, useState } from "react";
import { ArrowRight, Download, RefreshCw, X } from "lucide-react";
import { useI18n } from "../i18n";
import "./app-update-sidebar.css";

function updateErrorText(tr, code) {
  if (code === "TASK_RUNNING") {
    return tr(
      "有任务正在运行。完成或暂停后再安装。",
      "A task is still running. Finish or pause it before installing.",
    );
  }
  if (code === "NOT_DOWNLOADED") {
    return tr("请先下载更新。", "Download the update first.");
  }
  if (code === "UNSUPPORTED_CHANNEL") {
    return tr("便携版请打开 GitHub 下载页。", "Portable builds open the GitHub download page.");
  }
  return code;
}

function primaryAction(status) {
  if (!status) return "check";
  if (status.channel === "dev") return "";
  if (status.channel === "portable" && status.phase === "available") return "open";
  if (status.phase === "available") return "download";
  if (status.phase === "downloaded") return "install";
  if (status.phase === "downloading" || status.phase === "checking") return "";
  return "check";
}

export function AppUpdateSidebar() {
  const { tr } = useI18n();
  const [status, setStatus] = useState(null);
  useEffect(() => {
    const api = window.desktop?.update;
    if (!api?.status) return;
    let active = true, received = false;
    const unsubscribe = api.subscribe?.(next => { received = true; if (active) setStatus(next); });
    void api.status().then(next => { if (active && !received) setStatus(next); }).catch(() => {});
    return () => { active = false; unsubscribe?.(); };
  }, []);
  if (!status || status.channel === "dev") return null;
  const available = Boolean(status.availableVersion);
  const ready = status.phase === "downloaded";
  const label = ready ? tr("更新已就绪 · 重启安装", "Update ready · Restart")
    : status.phase === "downloading" ? tr("正在下载更新", "Downloading update")
    : status.phase === "checking" ? tr("正在检查更新", "Checking for updates")
    : available ? tr("有新版本更新", "New version available")
    : status.phase === "error" ? tr("更新检查失败 · 重试", "Update check failed · Retry")
    : tr("检查更新", "Check for updates");
  const act = async () => {
    const api = window.desktop.update;
    try {
      const result = ready ? await api.install()
        : available && status.channel === "portable" ? await api.openRelease()
        : available && status.phase !== "error" ? await api.download()
        : await api.check({ force: true });
      if (result) setStatus(result);
    } catch { setStatus(previous => ({ ...previous, phase: "error", busy: false, error: "UPDATE_ACTION_FAILED" })); }
  };
  return <div className="app-update-sidebar" aria-label={tr("应用更新", "App updates")}>
    <button type="button" onClick={act} disabled={status.busy}>
      {status.busy ? <RefreshCw size={16} className="spin" /> : <Download size={16} />}
      <span><strong>{label}</strong><small>{available ? "v" + status.availableVersion : "v" + status.currentVersion}
        {status.phase === "downloading" ? " · " + Math.round(status.downloadPercent || 0) + "%" : ""}</small></span>
    </button>
    {status.error && <p role="status">{status.error === "TASK_RUNNING" ? updateErrorText(tr, status.error) :
      tr("暂时无法完成更新操作，可重试或打开下载页。", "Could not complete the update. Retry or open downloads.")}</p>}
    {status.phase === "error" && <button type="button" className="update-release-link" onClick={() => void window.desktop.update.openRelease()}>
      {tr("打开下载页", "Open downloads")}<ArrowRight size={12} />
    </button>}
  </div>;
}

export function AppUpdateControls() {
  const { tr } = useI18n();
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!window.desktop?.update?.status) return undefined;
    let active = true;
    void window.desktop.update.status().then((next) => {
      if (active) setStatus(next);
    });
    const unsubscribe = window.desktop.update.subscribe?.((next) => {
      if (active) setStatus(next);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  if (!window.desktop?.update || !status) return null;
  const action = primaryAction(status);
  const busy = Boolean(status.busy);
  const versionLabel = status.currentVersion
    ? `v${status.currentVersion}`
    : tr("开发版", "Development");
  const detail =
    status.channel === "dev"
      ? tr("开发运行不检查 GitHub 更新。", "Dev launches do not check GitHub for updates.")
      : status.phase === "available"
        ? tr("发现新版本 v{version}。", "Version v{version} is available.", {
            version: status.availableVersion,
          })
        : status.phase === "downloading"
          ? tr("正在下载 v{version}… {percent}%", "Downloading v{version}… {percent}%", {
              version: status.availableVersion,
              percent: Math.round(status.downloadPercent || 0),
            })
          : status.phase === "downloaded"
            ? tr("v{version} 已下载，重启后安装。", "v{version} is ready. Restart to install.", {
                version: status.availableVersion,
              })
            : status.phase === "not-available"
              ? tr("已是最新版本。", "You are on the latest version.")
              : status.phase === "checking"
                ? tr("正在检查更新…", "Checking for updates…")
                : status.channel === "portable"
                  ? tr("便携版检测到更新后会打开 GitHub 下载页。", "Portable builds open GitHub when an update is found.")
                  : tr("安装版可在应用内下载并重启安装。", "Installed builds can download and restart to install.");

  return (
    <section className="application-about-update" aria-label={tr("应用更新", "App updates")}>
      <div>
        <strong>{tr("当前版本 {version}", "Current version {version}", { version: versionLabel })}</strong>
        <p>{detail}</p>
        {status.phase === "error" && status.error ? (
          <p role="alert">{updateErrorText(tr, status.error)}</p>
        ) : null}
      </div>
      <div className="application-about-update-actions">
        {action === "check" ? (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void window.desktop.update.check({ force: true })}
          >
            <RefreshCw size={14} />
            {tr("检查更新", "Check for updates")}
          </button>
        ) : null}
        {action === "download" ? (
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => void window.desktop.update.download()}
          >
            <Download size={14} />
            {tr("下载更新", "Download update")}
          </button>
        ) : null}
        {action === "install" ? (
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => void window.desktop.update.install()}
          >
            {tr("重启安装", "Restart and install")}
          </button>
        ) : null}
        {action === "open" || status.channel === "portable" ? (
          <button
            type="button"
            className="secondary-button"
            onClick={() => void window.desktop.update.openRelease()}
          >
            {tr("打开下载页", "Open download page")}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function AppUpdateToast({ status, onAction, onClose }) {
  const { tr } = useI18n();
  if (!status || (status.phase !== "available" && status.phase !== "downloaded")) {
    return null;
  }
  const portable = status.channel === "portable";
  const downloaded = status.phase === "downloaded";
  return (
    <aside className="task-completion-toast app-update-toast" role="status" aria-live="polite">
      <span className="task-completion-icon">
        <Download size={16} />
      </span>
      <div className="task-completion-copy">
        <span>{tr("应用更新", "App update")}</span>
        <strong>
          {tr("AporiaX {version} 可用", "AporiaX {version} is available", {
            version: `v${status.availableVersion}`,
          })}
        </strong>
        <p>
          {downloaded
            ? tr(
                "安装包已下载。有任务在跑时请先完成，再重启安装。",
                "The installer is downloaded. Finish running tasks, then restart to install.",
              )
            : portable
              ? tr(
                  "便携版请到 GitHub 下载新包。当前包不会被自动替换。",
                  "Portable builds open GitHub for a new package. This copy is not replaced in place.",
                )
              : tr(
                  "安装版可以在应用内下载，下载完成后重启安装。",
                  "Installed builds can download in-app, then restart to install.",
                )}
        </p>
        <button type="button" onClick={onAction}>
          {downloaded
            ? tr("重启安装", "Restart and install")
            : portable
              ? tr("打开下载页", "Open download page")
              : tr("下载更新", "Download update")}
          <ArrowRight size={13} />
        </button>
      </div>
      <button
        className="task-completion-close"
        type="button"
        aria-label={tr("稍后", "Later")}
        onClick={onClose}
      >
        <X size={15} />
      </button>
    </aside>
  );
}

export function updateToastKey(status) {
  if (!status?.phase || !status?.availableVersion) return "";
  return `${status.phase}:${status.availableVersion}`;
}
