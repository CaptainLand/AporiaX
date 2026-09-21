import { KeyRound, LoaderCircle, LogIn } from "lucide-react";
import { useAccount } from "../account/AccountContext.jsx";
import { useI18n } from "../i18n";
import "./model-setup.css";

export function ModelSetupActions({ onManageProviders, compact = false }) {
  const { tr } = useI18n();
  const { account, busy, error, api, signIn } = useAccount();
  const signedIn = account?.status === "authenticated";
  return <div className={"model-setup" + (compact ? " compact" : "")}>
    {!compact && <p>{signedIn
      ? tr("也可以使用自己的 API，费用由对应服务商结算。", "You can also use your own API, billed by that provider.")
      : tr("登录后可使用 Cloud，也可以添加自己的 API。", "Sign in to use Cloud, or add your own API.")}</p>}
    <div className="model-setup-actions">
      {onManageProviders && <button type="button" onClick={onManageProviders}><KeyRound size={14} />{tr("添加自己的 API", "Add your own API")}</button>}
      {!signedIn && <button type="button" disabled={busy || !api?.signIn || account?.status === "booting"} onClick={() => void signIn()}>
        {busy ? <LoaderCircle size={14} className="spin" /> : <LogIn size={14} />}
        {busy ? tr("等待浏览器登录…", "Waiting for sign-in…") : tr("登录 Aporia Cloud", "Sign in to Aporia Cloud")}
      </button>}
    </div>
    {error && <p className="model-setup-error" role="alert">{tr("Cloud 暂未连接，可重试登录或使用自己的 API。", "Cloud is not connected. Retry sign-in or use your own API.")}</p>}
  </div>;
}
