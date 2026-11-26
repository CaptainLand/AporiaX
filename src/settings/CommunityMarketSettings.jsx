import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, Download, ExternalLink, Package, Palette, Plug, Plus, RefreshCw, Sparkles, Store, Upload } from "lucide-react";
import { useAccount } from "../account/AccountContext.jsx";
import { useI18n } from "../i18n";
import { CommunityMarketUpload, formatMarketQuota } from "./CommunityMarketUpload.jsx";
import { CommunityMarketMine } from "./CommunityMarketMine.jsx";
import { marketDescription } from "./community-market-copy.js";
import "./community-market.css";

const kindIcons = { skill: Sparkles, mcp: Plug, agent: Bot, skin: Palette };

function describeError(error, tr) {
  const code = String(error?.message || "").match(/\b(?:COMMUNITY|DESKTOP_ACCOUNT)_[A-Z_]+\b/)?.[0];
  switch (code) {
    case "DESKTOP_ACCOUNT_SIGNED_OUT":
    case "COMMUNITY_ACCOUNT_CHANGED": return tr("登录状态已变化，请重新登录或刷新后重试。", "Your session changed. Sign in again or refresh and retry.");
    case "COMMUNITY_RULES_REQUIRED": return tr("请先在网页社区确认社区规则，再刷新市场。", "Accept the community rules on the web, then refresh the market.");
    case "COMMUNITY_REPOSITORY_CONFLICT": return tr("资源版本已变化，请刷新市场后重试。", "This resource has changed. Refresh the market and retry.");
    case "COMMUNITY_REVISION_CONFLICT": return tr("投稿状态或版本已变化，请刷新后重试。", "The submission changed. Refresh and try again.");
    case "COMMUNITY_MODERATION_LOCKED": return tr("此作品已由管理员下架，无法从这里修改。", "A moderator removed this work. It cannot be changed here.");
    case "COMMUNITY_DUPLICATE_SUBMISSION": return tr("相同配置已经投稿或已在市场上架，不能重复上传。", "This configuration was already submitted or listed and cannot be uploaded again.");
    case "COMMUNITY_NOT_FOUND":
    case "COMMUNITY_DOWNLOAD_PERMISSION_REQUIRED": return tr("资源已下架或作者已关闭下载。", "This resource has been removed or its downloads disabled.");
    case "COMMUNITY_REPOSITORY_FULL": return tr("个人社区仓库已满，请先到网页版整理。", "Your private community library is full. Manage it on the website first.");
    case "COMMUNITY_SYNC_BUSY": return tr("还有一项同步或添加操作在进行，请稍后再试。", "A sync or add is still running. Try again shortly.");
    case "COMMUNITY_INVALID_RESOURCE":
    case "COMMUNITY_SECRET_DETECTED":
    case "COMMUNITY_LOCAL_CONFLICT": return tr("资源未通过本地检查，未覆盖本机已有内容。", "This resource failed local checks. Existing resources were not overwritten.");
    case "COMMUNITY_CATALOG_TOO_LARGE": return tr("目录过大，未能完整加载。请到网页社区查看。", "The full catalog could not be loaded. View it on the community website.");
    case "COMMUNITY_QUOTA_EXHAUSTED": return tr("本周 3 次投稿额度已用完。", "This week's 3 submissions have been used.");
    case "COMMUNITY_RATE_LIMITED": return tr("操作太频繁，请稍后再试。", "Too many requests. Try again shortly.");
    case "COMMUNITY_UPLOAD_SOURCE_CHANGED": return tr("本机配置已变化。请重新选择该资源，检查新内容后提交。", "The local configuration changed. Choose the resource again and review the new contents.");
    case "COMMUNITY_LOCAL_RESOURCE_NOT_FOUND": return tr("本机资源已不存在，请重新打开投稿表单。", "The local resource no longer exists. Reopen the submission form.");
    case "COMMUNITY_BUILTIN_RESOURCE":
    case "COMMUNITY_IMPORTED_RESOURCE": return tr("内置或导入的社区资源不能再次投稿。", "Built-in resources and community imports cannot be submitted again.");
    case "COMMUNITY_SKILL_PACKAGE_NOT_SUPPORTED": return tr("暂不支持上传带脚本或附件的 Skill，本次没有上传。", "Skills with scripts or attachments cannot be submitted. Nothing was uploaded.");
    case "COMMUNITY_RESOURCE_TOO_LARGE":
    case "COMMUNITY_FILE_TOO_LARGE": return tr("配置超过社区的文件大小限制。", "This configuration exceeds the community file size limit.");
    case "COMMUNITY_THEME_CONTRAST": return tr("配色未满足社区的文字对比度要求，请调整后再投稿。", "This skin did not meet the community text-contrast requirement.");
    case "COMMUNITY_INVALID_UPLOAD":
    case "COMMUNITY_SKILL_FORMAT":
    case "COMMUNITY_MANIFEST_INVALID":
    case "COMMUNITY_TEXT_REQUIRED":
    case "COMMUNITY_UNSAFE_RESOURCE": return tr("配置或投稿信息不符合格式要求，请检查后重试。", "The configuration or submission details did not match the required format.");
    case "COMMUNITY_IDEMPOTENCY_CONFLICT": return tr("服务器已有该投稿记录，请先到网页社区查看结果。", "The server already has a record of this submission. Check the community website first.");
    default: return tr("暂时无法完成社区请求，请稍后重试。", "The community request could not be completed. Try again later.");
  }
}

function SignedInMarket({ owner, api, tr, language }) {
  const [filter, setFilter] = useState("all");
  const [refresh, setRefresh] = useState(0);
  const [market, setMarket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [adding, setAdding] = useState("");
  const [feedback, setFeedback] = useState(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [mine,setMine]=useState(false);
  const [manageBusy,setManageBusy]=useState(false);
  const retryKeys = useRef(new Map());
  const runningAdd = useRef(false);
  useEffect(() => {
    let active = true;
    setLoading(true); setLoadError("");
    Promise.resolve().then(() => api.list(owner)).then(value => {
      if (active) setMarket(value);
    }).catch(error => {
      if (active) setLoadError(describeError(error, tr));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [owner, api, refresh, tr]);

  const kindLabels = { all: tr("全部", "All"), skill: "Skill", mcp: "MCP", agent: tr("子 Agent", "Sub-agent"), skin: tr("皮肤", "Skin") };
  const items = market?.items;
  const ranked = useMemo(() => [...(items || [])].sort((a,b) =>
    (b.downloadCount ?? -1) - (a.downloadCount ?? -1)
      || String(b.publishedAt || "").localeCompare(String(a.publishedAt || ""))
      || a.id.localeCompare(b.id)), [items]);
  const visible = filter === "all" ? ranked : ranked.filter(item => item.kind === filter);
  const hasCounts = ranked.some(item => item.downloadCount != null);
  const count = new Intl.NumberFormat(language === "zh-CN" ? "zh-CN" : "en");
  async function add(item) {
    if (runningAdd.current || uploadBusy || manageBusy || item.added || !item.downloadAllowed || loading || loadError || !market?.rulesAccepted) return;
    runningAdd.current = true; setAdding(item.id); setFeedback(null);
    try {
      const { id, kind, sha256, revision } = item;
      const result = await api.add({ accountId: owner, id, kind, sha256, revision });
      if (result?.canceled) return;
      if (!result?.saved) throw Error("COMMUNITY_MARKET_UNAVAILABLE");
      setMarket(current => current && ({ ...current, items: current.items.map(row => row.id === id
        ? { ...row, added: true, localMatch: result.localMatch === true, downloadCount: result.downloadCount ?? row.downloadCount } : row) }));
      setFeedback({ id, text: result.localMatch
        ? tr("本机已有相同配置，未重复保存。", "This configuration is already on this device. No copy was saved.")
        : tr("已添加到本机，不会自动启用。", "Added locally. Not enabled automatically.") });
    } catch (error) {
      setFeedback({ id: item.id, failed: true, text: describeError(error, tr) });
    } finally { runningAdd.current = false; setAdding(""); }
  }
  const openRules = () => {
    setFeedback(null);
    void Promise.resolve().then(() => api.openCommunity(owner)).catch(error => setFeedback({ failed: true, text: describeError(error, tr) }));
  };
  const uploadAvailable = typeof api.submit === "function" && market?.rulesAccepted && !loading && !loadError;
  const mineAvailable = typeof api.mine === "function" && market?.rulesAccepted;
  const locked = uploadBusy || manageBusy || Boolean(adding);
  return <>
    <div className="community-market-toolbar">
      <div className="community-market-filters" role="group" aria-label={tr("资源类别", "Resource types")}>
        {Object.entries(kindLabels).map(([kind, label]) =>
          <button key={kind} type="button" aria-pressed={!mine&&filter===kind} disabled={manageBusy}
            onClick={() => { setMine(false);setFilter(kind); }}>{label}</button>)}
      </div>
      <div className="community-market-toolbar-actions">
        <button type="button" className="community-market-action" onClick={() => { setFeedback(null); setRefresh(n => n+1); }} disabled={loading || locked}>
          <RefreshCw size={14} aria-hidden="true" />{tr("刷新", "Refresh")}
        </button>
        <button type="button" className="community-market-action community-market-add" aria-expanded={uploadOpen} aria-controls="community-market-upload"
          title={market?.rulesAccepted ? formatMarketQuota(market.quota, tr, language) : tr("确认社区规则后可以投稿", "Accept the community rules to submit")}
          disabled={locked || !uploadAvailable} onClick={() => { setFeedback(null); setUploadOpen(open => !open); }}>
          <Upload size={14} aria-hidden="true" />{tr("上传插件", "Upload plugin")}
        </button>
        <button type="button" className="community-market-action" aria-pressed={mine} disabled={locked||!mineAvailable}
          onClick={()=>{setMine(value=>!value);setUploadOpen(false);setFeedback(null);}}>
          <Package size={14} aria-hidden="true"/>{tr("我的投稿","My submissions")}
        </button>
      </div>
    </div>
    {uploadOpen && market?.rulesAccepted &&
      <CommunityMarketUpload owner={owner} api={api} tr={tr} language={language} kindLabels={kindLabels} describeError={describeError}
        retryKeys={retryKeys} blocked={manageBusy||Boolean(adding)} onBusy={setUploadBusy} onClose={() => setUploadOpen(false)} onSubmitted={result => {
          setUploadOpen(false);
          if(mineAvailable)setMine(true);
          if (result?.quota) setMarket(current => current && ({ ...current, quota: result.quota }));
          setFeedback({ text: result?.status === "approved" ? tr("插件已发布。", "The plugin was published.")
            : result?.status === "pending" ? tr("投稿已提交，等待审核。", "Submitted for review.")
              : tr("服务器已收到该投稿，可在网页社区查看状态。", "The server has received this submission. Check its status on the community website.") });
          setRefresh(n => n+1);
        }} />}
    {loading && <p className="community-market-muted" role="status">{tr("正在读取社区目录…", "Loading the community catalog…")}</p>}
    {loadError && <p className="community-market-error" role="alert">{loadError}</p>}
    {!loading && market && !market.rulesAccepted && (
      <div className="community-market-gate">
        <span>{tr("添加或投稿前，请先在网页确认社区规则。回来后点刷新。", "Accept the community rules on the web before adding or submitting. Refresh when you return.")}</span>
        <button type="button" className="community-market-action" onClick={openRules}><ExternalLink size={14} aria-hidden="true" />{tr("打开网页社区", "Open community website")}</button>
      </div>
    )}
    {feedback && (mine || !feedback.id || !visible.some(item => item.id === feedback.id)) &&
      <p className={feedback.failed ? "community-market-error" : "community-market-muted"} role={feedback.failed ? "alert" : "status"}>{feedback.text}</p>}
    {mine&&mineAvailable?<CommunityMarketMine owner={owner} api={api} tr={tr} language={language} kindLabels={kindLabels} describeError={describeError}
      refresh={refresh} locked={uploadBusy||Boolean(adding)} onBusy={setManageBusy} onManaged={action=>{
        setFeedback({text:action==="unpublish"?tr("已下架，已保存的副本不受影响。","Unpublished. Existing saved copies were kept.")
          :tr("投稿已撤回。","Submission withdrawn.")});
        setRefresh(n=>n+1);
      }}/>:<>
    {!!ranked.length && <p className="community-market-order">{tr("{total} 项 · ", "{total} resources · ", { total: count.format(visible.length) })}{
      hasCounts ? tr("下载次数从高到低（按社区仓库导入计）", "Most downloaded first (counted by imports to the community library)")
        : tr("服务暂未提供下载次数，按发布时间排列", "Download counts unavailable; newest first")
    }</p>}
    {!visible.length && !loading && market && !loadError && <p className="community-market-muted">{tr("这个类别暂时没有已发布的社区资源。", "No published resources in this category yet.")}</p>}
    <div className="community-market-grid">
      {visible.map(item => {
        const Icon = kindIcons[item.kind] || Store;
        const description = marketDescription(item, tr);
        return <article className="community-market-card" key={item.id}>
          <div className="community-market-meta"><Icon size={15} aria-hidden="true" /><span>{kindLabels[item.kind]}</span>
            {item.downloadCount != null && <span className="community-market-count" aria-label={tr("下载 {total} 次", "{total} downloads", { total: count.format(item.downloadCount) })}><Download size={13} aria-hidden="true" />{count.format(item.downloadCount)}</span>}
          </div>
          <h4>{item.title}</h4>
          {item.author && <p className="community-market-author">{item.author}</p>}
          {description && <p className="community-market-summary">{description}</p>}
          <div className="community-market-card-footer">
            <button type="button" className="community-market-action community-market-add" disabled={locked || item.added || !item.downloadAllowed || loading || Boolean(loadError) || !market?.rulesAccepted} onClick={() => void add(item)}>
              {item.added ? <><Check size={14} aria-hidden="true" />{item.localMatch ? tr("本机已有", "Already on this device") : tr("已添加", "Added")}</> : !item.downloadAllowed
                ? tr("仅展示", "Display only") : <><Plus size={14} aria-hidden="true" />{adding === item.id ? tr("正在添加…", "Adding…") : tr("添加到本机", "Add locally")}</>}
            </button>
          </div>
          {feedback?.id === item.id && <p className={feedback.failed ? "community-market-error" : "community-market-muted"} role={feedback.failed ? "alert" : "status"}>{feedback.text}</p>}
        </article>;
      })}
    </div>
    </>}
  </>;
}

export function CommunityMarketSettings() {
  const { account, busy, signIn, error } = useAccount();
  const { tr, language } = useI18n();
  const owner = account.status === "authenticated" ? account.profile?.id : "";
  const api = window.desktop?.communityMarket;
  return <section className="community-market">
    <header className="application-settings-intro">
      <h3>{tr("社区插件市场", "Community Marketplace")}</h3>
      <p>{tr("浏览社区分享的 Skill、MCP、子 Agent 和皮肤，添加到当前设备。", "Browse community skills, MCP servers, sub-agents and skins and add them to this device.")}</p>
    </header>
    {!api ? <p className="community-market-muted">{tr("社区市场目前仅在 AporiaX 桌面版可用。", "The marketplace is available in the AporiaX desktop app.")}</p>
      : account.status === "booting" ? <p className="community-market-muted" role="status">{tr("正在检查登录状态…", "Checking your sign-in status…")}</p>
      : !owner ? <div className="community-market-gate">
        <div><strong>{tr("登录后使用社区市场", "Sign in to use the marketplace")}</strong>
          {error && <p className="community-market-error" role="alert">{tr("暂时未能登录，请重试或前往账户设置检查。", "Could not sign in. Retry or check Account settings.")}</p>}</div>
        <button type="button" className="community-market-action community-market-add" disabled={busy} onClick={() => void signIn()}>
          {busy ? tr("请在浏览器完成登录…", "Finish signing in in your browser…") : tr("登录 Aporia 账号", "Sign in to Aporia")}
        </button>
      </div> : <SignedInMarket key={owner} owner={owner} api={api} tr={tr} language={language} />}
  </section>;
}
