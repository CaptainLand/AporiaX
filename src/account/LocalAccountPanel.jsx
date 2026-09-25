import React, { useMemo, useState } from "react";
import {
  Check,
  Cloud,
  ExternalLink,
  Laptop,
  LogIn,
  LogOut,
  RefreshCw,
} from "lucide-react";
import { useI18n } from "../i18n";
import { useAccount } from "./AccountContext.jsx";
import "./local-account.css";
import { accountErrorText } from "./account-errors.js";
import { AccountAvatar } from "./AccountAvatar.jsx";

function quotaPercent(quota) {
  return Math.min(100, Math.max(0, Math.round(Number(quota?.remainingRatio || 0) * 100)));
}

function primaryModel(models = []) {
  const model = Array.isArray(models) ? models[0] : null;
  return model?.displayName || model?.name || model?.id || "Aporia Cloud";
}

export function LocalAccountPanel() {
  const { tr } = useI18n();
  const { account, busy: accountBusy, error, setError, api, signIn: accountSignIn, refresh: accountRefresh, signOut: accountSignOut } = useAccount();
  const [actionBusy, setBusy] = useState(false);
  const busy = accountBusy || actionBusy;
  const [menuOpen, setMenuOpen] = useState(false);

  const profile = account?.profile;
  const visibleName = profile?.displayName || profile?.email?.split("@")[0] || "AporiaX";
  const remaining = quotaPercent(account?.quota);
  const modelName = useMemo(() => primaryModel(account?.models), [account?.models]);
  const signedIn = account?.status === "authenticated" && profile;
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

  if (signedIn) {
    return (
      <div className="local-account-panel">
        {menuOpen && (
          <div className="local-account-popover">
            <div className="local-account-popover-head">
              <AccountAvatar profile={profile} />
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
          <AccountAvatar profile={profile} compact />
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
