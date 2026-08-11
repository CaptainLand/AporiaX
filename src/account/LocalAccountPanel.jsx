import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  CircleUserRound,
  LogIn,
  LogOut,
  ShieldCheck,
  UserPlus,
  X,
} from "lucide-react";
import { useI18n } from "../i18n";
import {
  APORIAX_DEMO_ACCOUNT,
  LOCAL_ACCOUNT_SESSION_KEY,
  authenticateDemoAccount,
  createLocalAccountProfile,
  validateLocalRegistration,
} from "./local-account-model.js";
import "./local-account.css";

function readLocalProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_ACCOUNT_SESSION_KEY) || "null");
    return saved?.username ? saved : null;
  } catch {
    return null;
  }
}

function AccountModal({ initialMode, onClose, onSignedIn }) {
  const { tr } = useI18n();
  const [mode, setMode] = useState(initialMode);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const closeOnEscape = (event) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setError("");
  };

  const submit = (event) => {
    event.preventDefault();
    if (mode === "login") {
      if (!authenticateDemoAccount(username, password)) {
        setError(tr("账号或密码不正确。当前原型可使用 landx / 111111。", "Incorrect account or password. Use landx / 111111 in this prototype."));
        return;
      }
      onSignedIn(createLocalAccountProfile(APORIAX_DEMO_ACCOUNT));
      return;
    }

    const issue = validateLocalRegistration({ username, password, confirmPassword });
    if (issue) {
      setError({
        username: tr("用户名需要 3–24 位字母、数字、下划线或短横线。", "Username must be 3–24 letters, numbers, underscores, or hyphens."),
        password: tr("密码至少需要 6 位。", "Password must contain at least 6 characters."),
        confirm: tr("两次输入的密码不一致。", "The passwords do not match."),
      }[issue]);
      return;
    }
    onSignedIn(createLocalAccountProfile({ username, displayName }));
  };

  return createPortal(
    <div className="local-account-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-labelledby="local-account-title"
        aria-modal="true"
        className="local-account-modal"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span className="local-account-modal-mark"><CircleUserRound size={20} /></span>
          <div>
            <small>APORIAX ID</small>
            <h2 id="local-account-title">{tr("连接你的 AporiaX", "Connect your AporiaX")}</h2>
          </div>
          <button aria-label={tr("关闭", "Close")} onClick={onClose} type="button"><X size={17} /></button>
        </header>

        <div className="local-account-prototype-note">
          <ShieldCheck size={15} />
          <span>
            <strong>{tr("本地 UI 原型", "Local UI prototype")}</strong>
            {tr("不会连接服务器，也不会保存密码。", "No server connection and no password storage.")}
          </span>
        </div>

        <nav className="local-account-tabs">
          <button className={mode === "login" ? "active" : ""} onClick={() => switchMode("login")} type="button">{tr("登录", "Sign in")}</button>
          <button className={mode === "register" ? "active" : ""} onClick={() => switchMode("register")} type="button">{tr("注册", "Create account")}</button>
        </nav>

        <form onSubmit={submit}>
          {mode === "register" && (
            <label>
              <span>{tr("显示名称（可选）", "Display name (optional)")}</span>
              <input autoComplete="name" onChange={(event) => setDisplayName(event.target.value)} placeholder="LandX" value={displayName} />
            </label>
          )}
          <label>
            <span>{tr("用户名", "Username")}</span>
            <input autoComplete="username" autoFocus onChange={(event) => setUsername(event.target.value)} placeholder="landx" value={username} />
          </label>
          <label>
            <span>{tr("密码", "Password")}</span>
            <input autoComplete={mode === "login" ? "current-password" : "new-password"} onChange={(event) => setPassword(event.target.value)} placeholder="••••••" type="password" value={password} />
          </label>
          {mode === "register" && (
            <label>
              <span>{tr("确认密码", "Confirm password")}</span>
              <input autoComplete="new-password" onChange={(event) => setConfirmPassword(event.target.value)} placeholder="••••••" type="password" value={confirmPassword} />
            </label>
          )}
          {error && <p className="local-account-error">{error}</p>}
          {mode === "login" && (
            <button
              className="local-account-demo-fill"
              onClick={() => {
                setUsername(APORIAX_DEMO_ACCOUNT.username);
                setPassword(APORIAX_DEMO_ACCOUNT.password);
                setError("");
              }}
              type="button"
            >
              {tr("填入测试账号 landx / 111111", "Fill demo account landx / 111111")}
            </button>
          )}
          <button className="local-account-submit" type="submit">
            {mode === "login" ? <LogIn size={16} /> : <UserPlus size={16} />}
            {mode === "login" ? tr("进入账户", "Sign in") : tr("创建本地身份", "Create local identity")}
          </button>
        </form>
      </section>
    </div>,
    document.body,
  );
}

export function LocalAccountPanel() {
  const { tr } = useI18n();
  const [profile, setProfile] = useState(readLocalProfile);
  const [modalMode, setModalMode] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const weeklyQuotaPercent = 100;
  const visibleName = profile?.username?.toLowerCase() === APORIAX_DEMO_ACCOUNT.username
    ? APORIAX_DEMO_ACCOUNT.displayName
    : profile?.displayName;

  const signIn = (nextProfile) => {
    localStorage.setItem(LOCAL_ACCOUNT_SESSION_KEY, JSON.stringify(nextProfile));
    setProfile(nextProfile);
    setModalMode("");
  };

  const signOut = () => {
    localStorage.removeItem(LOCAL_ACCOUNT_SESSION_KEY);
    setProfile(null);
    setMenuOpen(false);
  };

  return (
    <div className="local-account-panel">
      {profile ? (
        <>
          {menuOpen && (
            <div className="local-account-popover">
              <span><Check size={13} />{tr("本地会话已连接", "Local session connected")}</span>
              <small>{tr("云同步与团队账户将在后续版本开放。", "Cloud sync and team accounts will arrive later.")}</small>
              <button onClick={signOut} type="button"><LogOut size={14} />{tr("退出登录", "Sign out")}</button>
            </div>
          )}
          <button
            aria-expanded={menuOpen}
            className="local-account-profile"
            onClick={() => setMenuOpen((current) => !current)}
            title={tr("账户与周额度", "Account and weekly quota")}
            type="button"
          >
            <span className="local-account-profile-copy">
              <strong>{visibleName}</strong>
              <span className="local-account-quota-row">
                <small>{tr("周额度", "Weekly quota")}</small>
                <span
                  aria-label={tr(
                    `周额度剩余 ${weeklyQuotaPercent}%`,
                    `${weeklyQuotaPercent}% weekly quota remaining`,
                  )}
                  className="local-account-quota-track"
                  role="progressbar"
                  aria-valuemax="100"
                  aria-valuemin="0"
                  aria-valuenow={weeklyQuotaPercent}
                >
                  <i style={{ width: `${weeklyQuotaPercent}%` }} />
                </span>
              </span>
            </span>
          </button>
        </>
      ) : (
        <button className="local-account-signin" onClick={() => setModalMode("login")} type="button">
          <span className="local-account-signin-label">
            <strong>{tr("登录 AporiaX", "Sign in to AporiaX")}</strong>
          </span>
          <LogIn size={15} />
        </button>
      )}
      {modalMode && (
        <AccountModal initialMode={modalMode} onClose={() => setModalMode("")} onSignedIn={signIn} />
      )}
    </div>
  );
}
