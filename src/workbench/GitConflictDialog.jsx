import { useEffect, useState } from "react";
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
  const [remote, setRemote] = useState(state.remotes.includes("origin") ? "origin" : state.remotes[0] || "");
  useEffect(() => {
    let disposed = false; setData(null); setError("");
    workbench.request({ action: "git", operation: "pull-requests", remote }).then((result) => { if (!disposed) setData(result); }).catch((failure) => { if (!disposed) setError(failure.message); });
    return () => { disposed = true; };
  }, [workbench.key, state.revision, remote]);
  return <section className="git-history"><label className="git-field"><span>{tr("远程仓库（只读）", "Remote (read only)")}</span><select value={remote} onChange={(event) => setRemote(event.target.value)}>{state.remotes.map((name) => <option key={name}>{name}</option>)}</select></label>
    {error && <p className="git-form-error" role="alert">{error}</p>}
    {!error && !data && <p role="status">{tr("正在读取当前分支 PR…", "Loading branch pull requests…")}</p>}
    {data && <><p className="git-hint">{data.repository} · {data.branch}</p>{!data.items.length && <p>{tr("当前分支没有 PR。", "No pull requests for this branch.")}</p>}{data.items.map((pr) => <article key={pr.number}><strong>#{pr.number} {pr.title}</strong><p>{pr.isDraft ? "Draft · " : ""}{pr.state}</p>{pr.checks.map((check, index) => <p key={index}>{check.name}: {check.status}</p>)}{pr.url && <button onClick={() => workbench.openBrowser(pr.url)}>{tr("打开 PR", "Open pull request")}</button>}</article>)}</>}
  </section>;
}
