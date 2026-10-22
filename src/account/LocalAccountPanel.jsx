import React, { useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  LogIn,
  LogOut,
  RefreshCw,
  UserRound,
} from "lucide-react";
import { useI18n } from "../i18n";
import { useAccount } from "./AccountContext.jsx";
import "./local-account.css";
import { accountErrorText } from "./account-errors.js";
import { AccountAvatar } from "./AccountAvatar.jsx";
import { quotaResetLabel } from './quota-reset.js';
import { AccountInviteCard } from './AccountInviteCard.jsx';

function quotaPercent(quota) {
  const ratio = Number(quota?.remainingRatio);
  return Number.isFinite(ratio) ? Math.max(0, Math.round(ratio * 100)) : 0;
}

export function LocalAccountPanel({ onOpenAccountSettings }) {
  const { tr } = useI18n();
  const { account, busy, error, setError, signIn: accountSignIn, refresh: accountRefresh, signOut: accountSignOut } = useAccount();
  const [menuOpen, setMenuOpen] = useState(false);
  const panel = useRef(null), profileButton = useRef(null);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = event => { if (!panel.current?.contains(event.target)) setMenuOpen(false); };
    const escape = event => { if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); profileButton.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [menuOpen]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (account?.status !== 'authenticated') return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 60000);
    window.addEventListener('focus', tick);
    return () => { clearInterval(timer); window.removeEventListener('focus', tick); };
  }, [account?.status, account?.quota?.cycleEnd]);

  const profile = account?.profile;
  const visibleName = profile?.displayName || profile?.email?.split("@")[0] || "AporiaX";
  const remaining = quotaPercent(account?.quota);
  const barPercent = Math.min(100, remaining);
  const signedIn = account?.status === "authenticated" && profile;
  const openAccountSettings = () => {
    if (busy || !onOpenAccountSettings) return;
    setError("");
    setMenuOpen(false);
    onOpenAccountSettings();
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
      <div className="local-account-panel" ref={panel}>
        {menuOpen && (
          <div className="local-account-popover">
            <div className="local-account-popover-head">
              <AccountAvatar />
              <div>
                <strong>{visibleName}</strong>
                <small title={profile.email || undefined}>{profile.email || tr("Aporia Account", "Aporia Account")}</small>
              </div>
            </div>

            <div className="local-account-quota-card">
              <div><span>{tr("每周额度", "Weekly quota")}</span><strong>{remaining}%</strong></div>
              <span
                aria-label={tr(`周额度剩余 ${remaining}%`, `${remaining}% weekly quota remaining`)}
                className="local-account-quota-track local-account-quota-track--large"
                role="progressbar"
                aria-valuemax="100"
                aria-valuemin="0"
                aria-valuenow={barPercent}
                aria-valuetext={`${remaining}%`}
              >
                <i style={{ width: `${barPercent}%` }} />
              </span>
              {account.quota?.cycleEnd && <small>{quotaResetLabel(account.quota, now, tr)}</small>}
            </div>

            <AccountInviteCard key={`${profile.id}:${account.invites?.inviteCode || ''}`} invites={account.invites} />

            {account?.usage?.unresolvedRequestCount > 0 && <p role="status" className="local-account-local-note">{tr("有用量待核算，尚未计入已确认消费。", "Some usage is pending reconciliation and excluded from confirmed totals.")}</p>}
            <div className="local-account-actions">
              <button className="local-account-web" disabled={busy || !onOpenAccountSettings} onClick={openAccountSettings} type="button"><UserRound size={14} />{tr("账户中心", "Account center")}</button>
              <button disabled={busy} onClick={refresh} type="button"><RefreshCw className={busy ? "spin" : ""} size={14} />{tr("刷新", "Refresh")}</button>
              <button disabled={busy} onClick={signOut} type="button"><LogOut size={14} />{tr("退出登录", "Sign out")}</button>
            </div>
            {error && <p className="local-account-login-error" role="alert">{accountErrorText(error, tr)}</p>}
          </div>
        )}

        <button
          aria-expanded={menuOpen}
          className="local-account-profile"
          ref={profileButton}
          onClick={() => setMenuOpen((current) => !current)}
          title={tr("Aporia Account 与周额度", "Aporia Account and weekly quota")}
          type="button"
        >
          <span className="local-account-profile-copy">
            <strong>{visibleName}</strong>
            <span className="local-account-quota-row">
              <small className="local-account-quota-label"><span className="local-account-quota-reset" title={account?.quota?.cycleEnd || tr('尚未取得额度重置时间', 'Quota reset time is unavailable')}>{quotaResetLabel(account?.quota, now, tr)}</span></small>
              <span className="local-account-quota-percent">{remaining}%</span>
            </span>
            <span className="local-account-quota-track" aria-hidden="true"><i style={{ width: `${barPercent}%` }} /></span>
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
