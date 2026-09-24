import { remoteServiceSupported } from "../../shared/cloud-availability.js";
import React, { useMemo, useState } from "react";
import {
  Check,
  CircleUserRound,
  Cloud,
  ExternalLink,
  FolderOpen,
  Laptop,
  LogIn,
  LogOut,
  RefreshCw,
  Smartphone,
} from "lucide-react";
import { useI18n } from "../i18n";
import { useAccount } from "./AccountContext.jsx";
import "./local-account.css";
import { accountErrorText } from "./account-errors.js";

function quotaPercent(quota) {
  return Math.min(100, Math.max(0, Math.round(Number(quota?.remainingRatio || 0) * 100)));
}

function primaryModel(models = []) {
  const model = Array.isArray(models) ? models[0] : null;
  return model?.displayName || model?.name || model?.id || "Aporia Cloud";
}

export function LocalAccountPanel() {
  const { tr } = useI18n();
  const { account, setAccount, busy: accountBusy, error, setError, api, signIn: accountSignIn, refresh: accountRefresh, signOut: accountSignOut } = useAccount();
  const [actionBusy, setBusy] = useState(false);
  const busy = accountBusy || actionBusy;
  const [menuOpen, setMenuOpen] = useState(false);

  const profile = account?.profile;
  const visibleName = profile?.displayName || profile?.email?.split("@")[0] || "AporiaX";
  const remaining = quotaPercent(account?.quota);
  const modelName = useMemo(() => primaryModel(account?.models), [account?.models]);
  const signedIn = account?.status === "authenticated" && profile;
  const remoteSupported = remoteServiceSupported(account);
  const remoteEnabled = remoteSupported && Boolean(account?.device?.remoteEnabled);
  const remoteFilesEnabled = remoteEnabled && Boolean(account?.remoteFiles?.enabled);

  const openAccountCenter = async () => {
    if (busy || !api?.openCenter) return;
    setBusy(true);
    setError("");
    try { await api.openCenter(); }
    catch (failure) { setError(failure?.message?.startsWith("APORIAX_PRIVATE_") || failure?.message?.includes("APORIAX_CLOUD_ENDPOINTS_") ? failure.message : "APORIAX_ACCOUNT_CENTER_FAILED"); }
    finally { setBusy(false); }
  };

  const signIn = async () => {
    if (busy) return;
    const snapshot = await accountSignIn();
    if (snapshot && !snapshot.canceled) setMenuOpen(Boolean(snapshot.profile));
  };

  const refresh = async () => {
    if (busy) return;
    const snapshot = await accountRefresh();
    if (snapshot && snapshot.status !== "authenticated") setMenuOpen(false);
  };

  const signOut = async () => {
    if (busy) return;
    const snapshot = await accountSignOut();
    if (snapshot) setMenuOpen(false);
  };

  const toggleRemoteSync = async () => {
    if (!api?.setRemoteEnabled || busy) return;
    setBusy(true);
    setError("");
    try {
      const snapshot = await api.setRemoteEnabled(!remoteEnabled);
      setAccount(snapshot || account);
    } catch (remoteError) {
      setError(remoteError?.message || "REMOTE_SYNC_UPDATE_FAILED");
    } finally {
      setBusy(false);
    }
  };

  const toggleRemoteFiles = async () => {
    if (!api?.setRemoteFileAccess || busy || !remoteEnabled) return;
    setBusy(true);
    setError("");
    try {
      const snapshot = await api.setRemoteFileAccess(!remoteFilesEnabled);
      setAccount(snapshot || account);
    } catch (remoteError) {
      setError(remoteError?.message || "REMOTE_FILE_ACCESS_UPDATE_FAILED");
    } finally {
      setBusy(false);
    }
  };

  if (signedIn) {
    return (
      <div className="local-account-panel">
        {menuOpen && (
          <div className="local-account-popover">
            <div className="local-account-popover-head">
              <span className="local-account-avatar"><CircleUserRound size={18} /></span>
              <div>
                <strong>{visibleName}</strong>
                <small>{profile.email || tr("Aporia Account", "Aporia Account")}</small>
              </div>
              <span className="local-account-connected"><Check size={12} />{tr("已连接", "Connected")}</span>
            </div>

            <div className="local-account-quota-card">
              <div><span>{tr("每周额度", "Weekly quota")}</span><strong>{remaining}%</strong></div>
              <span
                aria-label={tr(`周额度剩余 ${remaining}%`, `${remaining}% weekly quota remaining`)}
                className="local-account-quota-track local-account-quota-track--large"
                role="progressbar"
                aria-valuemax="100"
                aria-valuemin="0"
                aria-valuenow={remaining}
              >
                <i style={{ width: `${remaining}%` }} />
              </span>
            </div>

            {account?.usage?.unresolvedRequestCount > 0 && <p role="status" className="local-account-local-note">{tr("有用量待核算，尚未计入已确认消费。", "Some usage is pending reconciliation and excluded from confirmed totals.")}</p>}
            <div className="local-account-meta">
              <div><Cloud size={13} /><span>{modelName}</span></div>
              <div><Laptop size={13} /><span>{account?.device?.name || tr("当前电脑", "This PC")}</span></div>
            </div>


            <button
              aria-pressed={remoteEnabled}
              className={`local-account-remote ${remoteEnabled ? "is-enabled" : ""}`}
              disabled={busy || !remoteSupported}
              onClick={toggleRemoteSync}
              type="button"
            >
              <Smartphone size={14} />
              <span>
                <strong>{tr("手机远程同步", "Mobile remote sync")}</strong>
                <small>{!remoteSupported ? tr("当前服务端不支持远程任务", "Remote tasks are not supported by this server") : remoteEnabled ? tr("已连接任务状态与远程指令", "Task status and remote commands enabled") : tr("点击后允许同账号手机访问", "Allow phones on this account to connect")}</small>
              </span>
              <i aria-hidden="true" />
            </button>
            <p className="local-account-local-note">
              {tr(
                "手机远程同步默认只传任务状态、最近对话与 Witness 摘要。文件访问需要单独开启。",
                "Mobile sync only transfers task state, recent dialogue, and Witness summaries by default. File access requires its own switch.",
              )}
            </p>

            <button
              aria-pressed={remoteFilesEnabled}
              className={`local-account-remote ${remoteFilesEnabled ? "is-enabled" : ""}`}
              disabled={busy || !remoteEnabled}
              onClick={toggleRemoteFiles}
              type="button"
            >
              <FolderOpen size={14} />
              <span>
                <strong>{tr("手机只读文件浏览", "Read-only mobile files")}</strong>
                <small>
                  {remoteFilesEnabled
                    ? tr("可浏览本机；每个文件仍需逐次确认", "Browse this PC; every file still needs approval")
                    : remoteEnabled
                      ? tr("允许查看整台电脑的文件目录", "Allow browsing file directories on this PC")
                      : tr("请先开启手机远程同步", "Enable mobile remote sync first")}
                </small>
              </span>
              <i aria-hidden="true" />
            </button>
            <p className="local-account-local-note local-account-local-note--security">
              {tr(
                "只允许查看与下载，不能修改、移动或删除。目录仅传元数据；预览或下载会在本机逐文件确认，并通过 Cloud 临时传输（最多 10 分钟）。",
                "View and download only—never edit, move, or delete. Directory metadata is listed without content; each preview or download needs Desktop approval and uses Cloud transit for up to 10 minutes.",
              )}
            </p>

            <div className="local-account-actions">
              <button className="local-account-web" disabled={busy || !api?.openCenter} onClick={openAccountCenter} type="button"><ExternalLink size={14} />{tr("账户中心", "Account center")}</button>
              <button disabled={busy} onClick={refresh} type="button"><RefreshCw className={busy ? "spin" : ""} size={14} />{tr("刷新", "Refresh")}</button>
              <button disabled={busy} onClick={signOut} type="button"><LogOut size={14} />{tr("退出登录", "Sign out")}</button>
            </div>
            {error && <p className="local-account-login-error" role="alert">{accountErrorText(error, tr)}</p>}
          </div>
        )}

        <button
          aria-expanded={menuOpen}
          className="local-account-profile"
          onClick={() => setMenuOpen((current) => !current)}
          title={tr("Aporia Account 与周额度", "Aporia Account and weekly quota")}
          type="button"
        >
          <span className="local-account-avatar local-account-avatar--compact"><CircleUserRound size={16} /></span>
          <span className="local-account-profile-copy">
            <strong>{visibleName}</strong>
            <span className="local-account-quota-row">
              <small>{tr("周额度", "Weekly")}</small>
              <span className="local-account-quota-track" aria-hidden="true"><i style={{ width: `${remaining}%` }} /></span>
            </span>
          </span>
        </button>
      </div>
    );
  }

  const booting = account?.status === "booting";
  const unavailable = account?.status === "unavailable";
  const cloudUnavailable = account?.status === "error" || Boolean(error);

  return (
    <div className="local-account-panel">
      <button
        className="local-account-signin"
        disabled={busy || booting || unavailable}
        onClick={signIn}
        type="button"
      >
        <span className="local-account-signin-icon"><LogIn size={15} /></span>
        <span className="local-account-signin-label">
          <strong>
            {booting
              ? tr("正在检查 Aporia Account", "Checking Aporia Account")
              : busy
                ? tr("连接中 / 等待网页确认", "Connecting / awaiting browser")
                : tr("登录 AporiaX", "Sign in to AporiaX")}
          </strong>
          <small>
            {cloudUnavailable
              ? tr("Aporia Cloud 未连接", "Aporia Cloud unavailable")
              : tr("在浏览器中继续", "Continue in browser")}
          </small>
        </span>
        {busy ? <RefreshCw className="spin" size={14} /> : <ExternalLink size={14} />}
      </button>
      {!busy && (error || account?.error) && <p className="local-account-login-error" role="alert">{accountErrorText(error || account.error, tr)}</p>}
    </div>
  );
}
