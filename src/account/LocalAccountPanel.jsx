import React, { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  CircleUserRound,
  Cloud,
  ExternalLink,
  Laptop,
  LogIn,
  LogOut,
  RefreshCw,
} from "lucide-react";
import { useI18n } from "../i18n";
import "./local-account.css";

function quotaPercent(quota) {
  return Math.min(100, Math.max(0, Math.round(Number(quota?.remainingRatio || 0) * 100)));
}

function primaryModel(models = []) {
  const model = Array.isArray(models) ? models[0] : null;
  return model?.displayName || model?.name || model?.id || "Aporia Cloud";
}

export function LocalAccountPanel() {
  const { tr } = useI18n();
  const [account, setAccount] = useState({ status: "booting" });
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState("");

  const api = window.desktop?.account;

  useEffect(() => {
    let active = true;
    if (!api?.get) {
      setAccount({ status: "unavailable" });
      return undefined;
    }
    api.get()
      .then((snapshot) => {
        if (!active) return;
        setAccount(snapshot || { status: "anonymous" });
        setError(snapshot?.error || "");
      })
      .catch((loadError) => {
        if (!active) return;
        setAccount({ status: "error" });
        setError(loadError?.message || "APORIAX_ACCOUNT_LOAD_FAILED");
      });
    return () => {
      active = false;
    };
  }, [api]);

  const profile = account?.profile;
  const visibleName = profile?.displayName || profile?.email?.split("@")[0] || "AporiaX";
  const remaining = quotaPercent(account?.quota);
  const modelName = useMemo(() => primaryModel(account?.models), [account?.models]);
  const signedIn = account?.status === "authenticated" && profile;

  const signIn = async () => {
    if (!api?.signIn || busy) return;
    setBusy(true);
    setError("");
    try {
      const snapshot = await api.signIn();
      if (!snapshot?.canceled) {
        setAccount(snapshot || { status: "anonymous" });
        setMenuOpen(Boolean(snapshot?.profile));
      }
    } catch (signInError) {
      setError(signInError?.message || "DESKTOP_LOGIN_FAILED");
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!api?.refresh || busy) return;
    setBusy(true);
    setError("");
    try {
      const snapshot = await api.refresh();
      setAccount(snapshot || { status: "anonymous" });
      if (snapshot?.status !== "authenticated") setMenuOpen(false);
    } catch (refreshError) {
      setError(refreshError?.message || "APORIAX_ACCOUNT_REFRESH_FAILED");
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    if (!api?.signOut || busy) return;
    setBusy(true);
    setError("");
    try {
      setAccount(await api.signOut());
      setMenuOpen(false);
    } catch (signOutError) {
      setError(signOutError?.message || "APORIAX_ACCOUNT_SIGN_OUT_FAILED");
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

            <div className="local-account-meta">
              <div><Cloud size={13} /><span>{modelName}</span></div>
              <div><Laptop size={13} /><span>{account?.device?.name || tr("当前电脑", "This PC")}</span></div>
            </div>

            <p className="local-account-local-note">
              {tr(
                "账号只同步身份、额度、模型与设备信息；项目源码、工作区和本地对话仍保留在这台电脑。",
                "Account sync covers identity, quota, models and devices. Projects, workspace files and local conversations stay on this computer.",
              )}
            </p>

            {error && <p className="local-account-inline-error"><AlertCircle size={13} />{error}</p>}

            <div className="local-account-actions">
              <button disabled={busy} onClick={refresh} type="button"><RefreshCw className={busy ? "spin" : ""} size={14} />{tr("刷新", "Refresh")}</button>
              <button disabled={busy} onClick={signOut} type="button"><LogOut size={14} />{tr("退出登录", "Sign out")}</button>
            </div>
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
                ? tr("等待浏览器确认", "Waiting for browser")
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
    </div>
  );
}
