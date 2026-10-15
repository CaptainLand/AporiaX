import { useEffect, useState } from "react";
import { GitPullRequest, GitMerge, GitBranch, ExternalLink, RefreshCw, CircleCheck, CircleX, Clock, CircleHelp, LoaderCircle } from "lucide-react";
import { SideChatDialog } from "./SideChatDialog.jsx";
import { useI18n } from "../i18n";
import "./side-chat.css";

export function GitConflictDialog({ path, state, workbench, onState, onClose }) {
  const { tr } = useI18n();
  const [data, setData] = useState(null), [draft, setDraft] = useState(""), [source, setSource] = useState("ours");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [backup, setBackup] = useState("");
  const request = (operation, extra = {}) => workbench.request({ action: "git", operation, path, ...extra });
  useEffect(() => {
    let disposed = false;
    request("conflict-read").then((result) => { if (!disposed) { setData(result); setDraft(result.working); } }).catch((failure) => { if (!disposed) setError(failure.message); });
    return () => { disposed = true; };
  }, [path, workbench.key]);
  async function save(resolve = false) {
    if (busy || !data) return;
    if (workbench.dirty.current.size) { setError(tr("请先保存侧栏文件草稿。", "Save editor drafts first.")); return; }
    setBusy(true); setError("");
    try {
      const result = await request(resolve ? "conflict-resolve" : "conflict-save", { token: data.token, revision: state.revision, content: draft });
      onState(result.state);
      if (resolve) onClose();
      else { setData(result.conflict); setDraft(result.conflict.working); setBackup(result.backup); }
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  const dirty = data && draft !== data.working;
  const close = () => { if (!busy && (!dirty || window.confirm(tr("放弃未保存的合并草稿？", "Discard unsaved merge draft?")))) onClose(); };
  return <SideChatDialog title={tr("解决文件冲突", "Resolve file conflict")} subtitle={path} onClose={close}>
    <div className="git-setup git-conflict-editor">
      {error && <p role="alert" className="git-form-error">{error}</p>}
      {!data && !error && <p role="status">{tr("正在读取三方版本…", "Loading conflict sources…")}</p>}
      {data && <>
        <nav className="git-settings-tabs" aria-label={tr("冲突来源", "Conflict source")}>{[["base", "共同基线", "Base"], ["ours", "当前分支", "Ours"], ["theirs", "合入分支", "Theirs"]].map(([id, zh, en]) => <button key={id} aria-pressed={source === id} onClick={() => setSource(id)}>{tr(zh, en)}</button>)}</nav>
        <pre className="git-conflict-source">{data[source] || tr("（空文件或无共同基线）", "(Empty or no base)")}</pre>
        <button disabled={busy} onClick={() => setDraft(data[source])}>{tr("采用此版本作为合并草稿", "Use this version as draft")}</button>
        <label className="git-field"><span>{tr("合并结果（可编辑）", "Merged result (editable)")}</span><textarea aria-label={tr("合并结果", "Merged result")} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={busy} spellCheck={false} /></label>
        <p className="git-hint">{tr("保存前备份原件。保存不代表已解决；核对后再标记，最后提交已暂存内容。", "Original is backed up before saving. Review, mark resolved, then commit staged changes.")}</p>
        {backup && <p className="git-hint">{tr("原件备份：", "Backup: ")}<code>{backup}</code></p>}
        <div className="git-empty-actions"><button disabled={busy || !dirty} onClick={() => void save()}>{tr("保存合并结果", "Save merge")}</button><button disabled={busy || Boolean(dirty)} onClick={() => void save(true)}>{tr("标记已解决并暂存", "Mark resolved and stage")}</button></div>
      </>}
    </div>
  </SideChatDialog>;
}

export function GitPullRequests({ workbench, state }) {
  const { tr } = useI18n();
  const [data, setData] = useState(null), [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [remote, setRemote] = useState(state.remotes.includes("origin") ? "origin" : state.remotes[0] || "");
  const selectedRemote = state.remotes.includes(remote) ? remote : state.remotes[0] || "";
  useEffect(() => {
    let disposed = false; setData(null); setError("");
    if (!selectedRemote) return () => { disposed = true; };
    workbench.request({ action: "git", operation: "pull-requests", remote: selectedRemote }).then((result) => { if (!disposed) setData(result); }).catch((failure) => { if (!disposed) setError(failure.message); });
    return () => { disposed = true; };
  }, [workbench.key, state.revision, selectedRemote, refresh]);
  const checkState = status => {
    const value = String(status || "").toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(value)) return { tone: "passed", Icon: CircleCheck, label: value === "SUCCESS" ? tr("通过", "Passed") : value === "SKIPPED" ? tr("已跳过", "Skipped") : tr("中性", "Neutral") };
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(value)) return { tone: "failed", Icon: CircleX, label: tr("需检查", "Needs attention") };
    if (["PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED"].includes(value)) return { tone: "pending", Icon: Clock, label: tr("进行中", "Pending") };
    return { tone: "unknown", Icon: CircleHelp, label: tr("未报告", "Not reported") };
  };
  return <section className="git-history git-pull-requests">
    <div className="git-pr-heading"><div><strong>{tr("拉取请求", "Pull requests")}</strong><p>{tr("查看当前分支的评审与检查结果，不会自动合并。", "Review this branch's requests and checks. No automatic merge.")}</p></div><button className="git-icon" aria-label={tr("刷新 PR", "Refresh pull requests")} disabled={!selectedRemote || (!data && !error)} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} /></button></div>
    <label className="git-field"><span>{tr("远程仓库（只读）", "Remote (read only)")}</span><select aria-label={tr("PR 远程仓库", "PR remote")} value={selectedRemote} disabled={!state.remotes.length} onChange={(event) => setRemote(event.target.value)}>{!state.remotes.length && <option value="">{tr("尚未配置远程", "No remote configured")}</option>}{state.remotes.map((name) => <option key={name}>{name}</option>)}</select></label>
    {error && <div className="git-pr-error" role="alert"><p>{error}</p><button onClick={() => setRefresh(value => value + 1)}>{tr("重新读取", "Retry")}</button></div>}
    {!selectedRemote ? <div className="git-pr-empty"><GitBranch size={26} /><strong>{tr("先连接远程仓库", "Connect a remote first")}</strong><p>{tr("在上方仓库设置中配置 GitHub 远程，并登录 GitHub。", "Configure a GitHub remote and sign in through repository settings above.")}</p></div> : !error && !data && <div className="git-pr-empty" role="status"><LoaderCircle className="spin" size={24} /><p>{tr("正在读取当前分支 PR…", "Loading branch pull requests…")}</p></div>}
    {data && <><div className="git-pr-repository"><GitBranch size={13} /><span>{data.repository} · {data.branch}</span><span>{data.items.length} PR</span></div>
      {!data.items.length && <div className="git-pr-empty"><GitPullRequest size={26} /><strong>{tr("当前分支没有 PR", "No pull requests for this branch")}</strong><p>{tr("发布分支并在 GitHub 创建 PR 后，可在这里查看评审状态。", "Publish the branch and create a PR on GitHub to view its review status here.")}</p></div>}
      {data.items.map(pr => <article className="git-pr-card" key={pr.number}>
        <div className="git-pr-title">{pr.state === "MERGED" ? <GitMerge size={17} /> : <GitPullRequest size={17} />}<strong>#{pr.number} {pr.title}</strong></div>
        <div className="git-pr-meta"><span className={"git-pr-badge " + (pr.isDraft ? "draft" : String(pr.state).toLowerCase())}>{pr.isDraft ? tr("草稿", "Draft") : pr.state === "OPEN" ? tr("待合并", "Open") : pr.state === "MERGED" ? tr("已合并", "Merged") : pr.state === "CLOSED" ? tr("已关闭", "Closed") : pr.state}</span>{pr.updatedAt && Number.isFinite(Date.parse(pr.updatedAt)) && <time dateTime={pr.updatedAt}>{tr("更新于 ", "Updated ") + new Date(pr.updatedAt).toLocaleDateString()}</time>}</div>
        <div className="git-pr-checks"><h4>{tr("自动检查", "Checks")}</h4>{!pr.checks.length && <p>{tr("尚无检查结果", "No checks reported")}</p>}{pr.checks.map((check, index) => { const status = checkState(check.status); return <div className={"git-pr-check " + status.tone} key={index}><status.Icon size={14} /><span>{check.name || tr("未命名检查", "Unnamed check")}</span><small title={check.status}>{status.label}</small></div>; })}</div>
        {pr.url && <button className="git-pr-open" onClick={async () => { try { const opened = await workbench.openHref(pr.url); if (opened === false) throw new Error(tr("无法打开 PR", "Cannot open pull request")); } catch (failure) { setError(failure.message); } }}><ExternalLink size={14} />{tr("打开 PR 详情", "Open PR details")}</button>}
      </article>)}
    </>}
  </section>;
}
