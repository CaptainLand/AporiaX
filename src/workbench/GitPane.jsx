import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, GitBranch, Plus, Minus, RefreshCw, X, FileText, Settings2, ChevronDown } from "lucide-react";
import { GitSetupDialog } from "./GitSetupDialog.jsx";
import { GitConflictDialog, GitPullRequests } from "./GitConflictDialog.jsx";
import { useI18n } from "../i18n";
import "./git-pane.css";

export function GitPane({ workbench }) {
  const { tr } = useI18n();
  const [state, setState] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState("");
  const [view, setView] = useState("changes"), [selected, setSelected] = useState(null), [diff, setDiff] = useState(null), [history, setHistory] = useState(null);
  const [message, setMessage] = useState(() => workbench.draft("git:message") || "");
  const [dialog, setDialog] = useState(null), [conflictPath, setConflictPath] = useState(null);
  const live = useRef(true), generation = useRef(0), operation = useRef(false);
  const request = (op, extra = {}) => workbench.request({ action: "git", operation: op, ...extra });
  async function refresh() {
    if (operation.current) return;
    const id = ++generation.current;
    setBusy("status"); setError("");
    try { const result = await request("status"); if (live.current && id === generation.current) { setState(result); setHistory(null); } }
    catch (failure) { if (live.current && id === generation.current) setError(failure.message); }
    finally { if (live.current && id === generation.current) setBusy(""); }
  }
  useEffect(() => {
    live.current = true; setState(null); setSelected(null); setConflictPath(null); setDialog(null); void refresh();
    const focus = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", focus);
    return () => { live.current = false; generation.current++; window.removeEventListener("focus", focus); };
  }, [workbench.key]);
  useEffect(() => {
    if (!selected || !state?.repository || state.readOnly) return;
    let canceled = false;
    setDiff(null);
    if (!state.files.some((file) => file.path === selected.path && (selected.staged ? file.staged : file.unstaged))) { setSelected(null); return; }
    request("diff", selected).then((result) => { if (!canceled) setDiff(result); }).catch((failure) => { if (!canceled) setDiff({ text: failure.message, error: true }); });
    return () => { canceled = true; };
  }, [selected, state]);
  useEffect(() => {
    if (view !== "history" || !state?.repository || state.readOnly) return;
    let canceled = false;
    request("log").then((result) => { if (!canceled) setHistory(result); }).catch((failure) => { if (!canceled) setError(failure.message); });
    return () => { canceled = true; };
  }, [view, state]);
  async function act(op, extra = {}) {
    if (operation.current || !state) return;
    if (["stage", "unstage", "commit"].includes(op) && workbench.dirty.current.size) { setError(tr("请先保存侧栏文件草稿，再操作 Git 索引。", "Save editor drafts before changing the Git index.")); return false; }
    if (op === "pull" && workbench.dirty.current.size > 0) { setError(tr("请先保存侧栏的文件草稿，再拉取更新。", "Save editor drafts before pulling.")); return false; }
    operation.current = true; ++generation.current;
    setBusy(op); setError("");
    try {
      const result = await request(op, { revision: state.revision, ...extra });
      if (!live.current) return;
      setState(result.state); setHistory(null);
      if (op === "commit" && !result.canceled) { setMessage(""); workbench.saveDraft("git:message", null); }
      return !result.canceled;
    } catch (failure) { if (live.current) setError(failure.message); }
    finally { operation.current = false; if (live.current) setBusy(""); }
  }
  const ready = state?.repository && !state.readOnly;
  const staged = state?.files.filter((file) => file.staged) || [], unstaged = state?.files.filter((file) => file.unstaged) || [];
  const group = (files, isStaged) => <section className="git-file-group">
    <h3>{isStaged ? tr("已暂存", "Staged") : tr("工作区改动", "Working changes")}<span>{files.length}</span></h3>
    {files.map((file) => <div className={"git-file-row" + (selected?.path === file.path && selected.staged === isStaged ? " selected" : "")} key={file.path}>
      <button className="git-file-open" title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path} onClick={() => file.conflict ? setConflictPath(file.path) : setSelected({ path: file.path, staged: isStaged })}>
        <span className={"git-status " + (file.conflict ? "conflict" : file.untracked || file.x === "A" ? "added" : file.x === "D" || file.y === "D" ? "deleted" : "modified")}>{file.conflict ? "!" : file.untracked ? "U" : isStaged ? file.x : file.y}</span>
        <span>{file.path}</span>
      </button>
      <button className="git-icon" title={tr("打开文件", "Open file")} aria-label={tr("打开文件 ", "Open file ") + file.path} onClick={() => workbench.openFile(file.path)}><FileText size={13} /></button>
      <button className="git-icon" aria-label={(isStaged ? tr("取消暂存 ", "Unstage ") : tr("暂存 ", "Stage ")) + file.path} disabled={Boolean(busy) || file.conflict} onClick={() => void act(isStaged ? "unstage" : "stage", { path: file.path })}>{isStaged ? <Minus size={14} /> : <Plus size={14} />}</button>
    </div>)}
    {!files.length && <p className="git-empty-small">{tr("暂无", "None")}</p>}
  </section>;
  return <section className="workbench-git" aria-label="Git">
    <header className="git-heading"><GitBranch size={16} /><button className="git-branch-trigger" aria-label={tr("选择 Git 分支", "Choose Git branch")} title={state?.root} disabled={!ready || Boolean(busy)} onClick={() => { setError(""); setDialog("branches"); }}><strong>{state?.branch || (state?.detached ? "detached HEAD" : "Git")}</strong><ChevronDown size={13} /></button>
      {state?.upstream && <span className="git-tracking" title={state.upstream}>↑{state.ahead} ↓{state.behind}</span>}
      <button className="git-icon" aria-label={tr("仓库设置", "Repository settings")} disabled={!state || state.readOnly || Boolean(busy)} onClick={() => { setError(""); setDialog("setup"); }}><Settings2 size={15} /></button>
      <button className="git-icon" aria-label={tr("刷新 Git", "Refresh Git")} disabled={Boolean(busy)} onClick={() => void refresh()}><RefreshCw size={14} /></button>
    </header>
    {error && <div className="workbench-error" role="alert">{error}</div>}
    {!state && <div className="git-empty">{busy ? tr("正在读取仓库…", "Reading repository…") : tr("无法读取仓库，请检查 Git 或工作区后刷新。", "Cannot read repository. Check Git and workspace, then refresh.")}</div>}
    {state && !ready && <div className="git-empty"><GitBranch size={28} /><p>{state.message}</p>{state.readOnly ? <code>{state.root}</code> : <div className="git-empty-actions"><button disabled={Boolean(busy)} onClick={() => { setError(""); setDialog("init"); }}>{tr("初始化仓库", "Initialize repository")}</button><button disabled={Boolean(busy) || !state.empty} title={tr("需要空工作区", "Requires an empty workspace")} onClick={() => { setError(""); setDialog("clone"); }}>{tr("克隆仓库", "Clone repository")}</button></div>}</div>}
    {ready && <>
      <div className="git-toolbar"><div className="git-view-toggle"><button aria-pressed={view === "changes"} onClick={() => setView("changes")}>{tr("改动", "Changes")}</button><button aria-pressed={view === "history"} onClick={() => setView("history")}>{tr("历史", "History")}</button><button aria-pressed={view === "pr"} onClick={() => setView("pr")}>PR</button></div>
        <button disabled={Boolean(busy) || !state.remotes.length} onClick={() => void act("fetch")} title={tr("获取远程状态，不合并工作区", "Fetch without merging working files")}><ArrowDown size={13} />{tr("获取", "Fetch")}</button>
        <button disabled={Boolean(busy) || !state.upstream} onClick={() => void act("pull")} title={tr("只快进拉取，不自动合并", "Fast-forward only")}><ArrowDown size={13} />{tr("拉取", "Pull")}</button>
        <button disabled={Boolean(busy) || !state.remotes.length || !state.head} onClick={() => { if (state.upstream) void act("push"); else { setError(""); setDialog("publish"); } }}><ArrowUp size={13} />{state.upstream ? tr("推送", "Push") : tr("发布分支", "Publish branch")}</button>
      </div>
      {busy && <div className="git-operation" role="status">{tr("Git 正在处理…", "Git is working…")}</div>}
      {state.workflow && <div className="workbench-search-hint">{state.workflow === "merge" ? tr("正在合并：点击冲突文件核对双方内容。", "Merge in progress: open conflicted files to review both sides.") : tr("正在 {operation}，请在终端解决并继续该操作。", "{operation} in progress; resolve and continue in terminal.", { operation: state.workflow })}</div>}
      {state.workflow && state.workflow !== "merge" && <div className="git-empty-actions"><button onClick={() => void workbench.create("terminal")}>{tr("打开终端处理", "Continue in terminal")}</button></div>}
      {state.workflow === "merge" && !state.files.some((file) => file.conflict) && <p className="workbench-search-hint">{tr("冲突已解决。核对已暂存列表，填写提交说明后完成合并。", "Conflicts resolved. Review staged files and enter a commit message to complete the merge.")}</p>}
      {state.truncated && <div className="workbench-search-hint">{tr("仅显示前 1000 个改动，请缩小仓库范围。", "Showing the first 1000 changes.")}</div>}
      {view === "changes" ? <>
        <div className={"git-changes" + (selected ? " with-diff" : "")}>{group(staged, true)}{group(unstaged, false)}{!state.files.length && <p className="git-clean">{tr("工作区干净，没有待提交改动。", "Working tree clean.")}</p>}</div>
        {selected && <section className="git-diff"><header><span title={selected.path}>{selected.path} · {selected.staged ? tr("已暂存", "Staged") : tr("未暂存", "Unstaged")}</span><button className="git-icon" aria-label={tr("关闭差异", "Close diff")} onClick={() => setSelected(null)}><X size={14} /></button></header>
          <pre aria-label={tr("文件差异", "File diff")}>{diff ? diff.text ? diff.text.split("\n").map((line, index) => <span key={index} className={line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : line.startsWith("@@") ? "hunk" : ""}>{line || " "}{"\n"}</span>) : tr("没有文本差异（可能仅文件属性变化）。", "No text differences (possibly file metadata only).") : tr("正在读取差异…", "Loading diff…")}</pre>
          {diff?.truncated && <small>{tr("差异过长，已截断；请在终端检查完整内容。", "Diff truncated; inspect the complete diff in terminal.")}</small>}
        </section>}
        <form className="git-commit" onSubmit={(event) => { event.preventDefault(); void act("commit", { message }); }}><textarea aria-label={tr("提交说明", "Commit message")} placeholder={tr("描述这次改动…", "Describe this change…")} rows={2} maxLength={4000} value={message} disabled={Boolean(busy)} onChange={(event) => { setMessage(event.target.value); workbench.saveDraft("git:message", event.target.value); }} /><div><small>{tr("仅提交已暂存内容，不会自动推送", "Only staged changes; no automatic push")}</small><button type="submit" disabled={Boolean(busy) || !staged.length || !message.trim() || state.detached}>{tr("提交已暂存", "Commit staged")}</button></div></form>
      </> : view === "pr" ? <GitPullRequests workbench={workbench} state={state} /> : <div className="git-history">{history === null ? <p>{tr("读取提交记录…", "Loading history…")}</p> : !history.length ? <p>{tr("尚无提交。", "No commits yet.")}</p> : history.map((entry) => <article key={entry.hash}><strong>{entry.subject}</strong><p><code title={entry.hash}>{entry.shortHash}</code> · {entry.author}</p><small>{new Date(entry.date).toLocaleString()}</small></article>)}</div>}
    </>}
    {dialog && state && <GitSetupDialog kind={dialog} state={state} workbench={workbench} busy={busy} error={error} onAction={act} onClose={() => setDialog(null)} />}
    {conflictPath && state && <GitConflictDialog key={workbench.key + conflictPath} path={conflictPath} state={state} workbench={workbench} onState={setState} onClose={() => setConflictPath(null)} />}
  </section>;
}
