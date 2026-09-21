import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BookOpen, ChevronDown, ChevronRight, FileText, History, RotateCcw, Search, X } from "lucide-react";
import { useI18n } from "../i18n";
import { UnderstandingControls } from "../settings/UnderstandingControls.jsx";
import { TaskKnowledgeControls } from "./TaskKnowledgeControls.jsx";
import { SideChatDialog } from "../workbench/SideChatDialog.jsx";
import "../workbench/side-chat.css";
import "./understanding.css";

const CHANGED = "aporiax:knowledge-changed";
const groups = [
  { id: "all", zh: "全部", en: "All" },
  { id: "structure", zh: "项目结构", en: "Structure", categories: ["architecture", "module"] },
  { id: "conventions", zh: "开发约定", en: "Conventions", categories: ["convention", "preference"] },
  { id: "commands", zh: "命令与验证", en: "Commands & checks", categories: ["command", "verification"] },
  { id: "decisions", zh: "问题与决策", en: "Issues & decisions", categories: ["decision", "known_issue"] },
];
const categories = { architecture: ["架构", "Architecture"], module: ["模块", "Module"], convention: ["约定", "Convention"], preference: ["偏好", "Preference"], command: ["命令", "Command"], verification: ["验证", "Verification"], decision: ["决策", "Decision"], known_issue: ["已知问题", "Known issue"] };
const dateLabel = (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString() : "—";

// Remount on workspace changes so late reads or writes cannot paint another project.
export function ProjectUnderstandingPanel(props) {
  return <KnowledgeProjects key={`${props.task.id}:${props.task.workspacePath || "none"}`} {...props} />;
}

function KnowledgeProjects(props) {
  const { tr } = useI18n();
  const { task, onDialogChange, onNotice } = props;
  const [projects, setProjects] = useState([{ id: "legacy", name: tr("未分类（旧知识）", "Unclassified (legacy)") }]);
  const [selected, setSelected] = useState(task.knowledgeProjectId || "legacy"), [creating, setCreating] = useState(false);
  const [name, setName] = useState(""), [description, setDescription] = useState(""), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const mounted = useRef(false), creatingRef = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let generation = 0;
    const load = async () => {
      const request = ++generation;
      try {
        if (!window.desktop?.understanding?.projects || !task.workspacePath) return;
        const next = await window.desktop.understanding.projects({ workspacePath: task.workspacePath });
        if (mounted.current && request === generation) { setProjects(next); setError(""); }
      } catch (failure) { if (mounted.current && request === generation) setError(failure.message); }
    };
    const changed = (event) => { if (event.detail === task.workspacePath) void load(); };
    void load(); window.addEventListener(CHANGED, changed);
    return () => { mounted.current = false; generation++; window.removeEventListener(CHANGED, changed); };
  }, [task.workspacePath, props.refreshToken, task.knowledgeProjectId]);
  useEffect(() => { if (creating) { onDialogChange?.(true); return () => onDialogChange?.(false); } }, [creating, onDialogChange]);
  const create = async (event) => {
    event.preventDefault();
    if (creatingRef.current || !name.trim()) return;
    creatingRef.current = true; setSaving(true); setError("");
    try {
      const result = await window.desktop.understanding.createProject({ workspacePath: task.workspacePath, taskId: task.id, name, description });
      window.dispatchEvent(new CustomEvent(CHANGED, { detail: task.workspacePath }));
      if (!mounted.current) return;
      setProjects((current) => current.some((p) => p.id === result.project.id) ? current : [...current, result.project]);
      setSelected(result.project.id); setCreating(false); setName(""); setDescription("");
      onNotice?.(result.created ? tr("知识项目已创建，尚未改变任务知识来源。", "Knowledge project created. Task knowledge source is unchanged.") : tr("已打开同名知识项目。", "Opened the existing knowledge project."));
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { creatingRef.current = false; if (mounted.current) setSaving(false); }
  };
  return <div className="knowledge-projects">
    {error && !creating && <p className="knowledge-alert" role="alert">{error}</p>}
    <KnowledgePanel {...props} knowledgeProjectId={selected} projectName={projects.find((p) => p.id === selected)?.name || selected} projects={projects} onSelectProject={setSelected} onCreateProject={() => { setError(""); setCreating(true); }} />
    {creating && <SideChatDialog className="knowledge-dialog" title={tr("新建知识项目", "New knowledge project")} onClose={() => setCreating(false)}>
      <form className="knowledge-project-form" onSubmit={create}>
        <label>{tr("知识项目名称", "Knowledge project name")}<input className="text-field" required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label>
        <label>{tr("项目说明（可选）", "Project description (optional)")}<textarea className="text-field" rows={3} maxLength={400} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <p>{tr("独立保存知识和历史。创建不会自动读取文件或消耗模型额度。", "Knowledge and history stay separate. Creation does not scan files or call a model.")}</p>
        {error && <p className="knowledge-alert" role="alert">{error}</p>}
        <button className="primary-button" type="submit" disabled={saving || !name.trim()}>{saving ? tr("创建中…", "Creating…") : tr("创建", "Create")}</button>
      </form>
    </SideChatDialog>}
  </div>;
}

function KnowledgePanel({ task, knowledgeProjectId, projectName, projects, onSelectProject, onCreateProject, refreshToken, onOpenFile, onNotice, onDialogChange, onUpdateTask, isRunning }) {
  const { tr } = useI18n();
  const [snapshot, setSnapshot] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  // Keep the settings dialog open while switching projects, but never show the
  // previous project's facts or apply its late settings response to this one.
  const state = snapshot?.projectId === knowledgeProjectId ? snapshot.data : null;
  const [query, setQuery] = useState(""), [group, setGroup] = useState("all"), [dialog, setDialog] = useState(null);
  const [confirmRevision, setConfirmRevision] = useState(""), [reverting, setReverting] = useState(false), [dialogError, setDialogError] = useState("");
  const generation = useRef(0), mounted = useRef(false), writing = useRef(false);
  const activeProject = useRef(knowledgeProjectId);
  activeProject.current = knowledgeProjectId;
  const workspace = task.workspacePath;
  const label = (category) => tr(...(categories[category] || [category || "其他", category || "Other"]));
  const load = async () => {
    if (writing.current) return;
    const request = ++generation.current;
    setLoading(true); setError("");
    try {
      if (!workspace || !window.desktop?.understanding?.get) throw new Error(tr("请先选择工作区，并在桌面端查看项目知识。", "Choose a workspace and open project knowledge in the desktop app."));
      const next = await window.desktop.understanding.get({ workspacePath: workspace, knowledgeProjectId });
      if (mounted.current && generation.current === request) setSnapshot({ projectId: knowledgeProjectId, data: next });
    } catch (failure) {
      if (mounted.current && generation.current === request) setError(failure?.message || tr("读取失败，请重试", "Could not load knowledge. Try again."));
    } finally { if (mounted.current && generation.current === request) setLoading(false); }
  };
  useEffect(() => {
    mounted.current = true;
    const changed = (event) => { if (event.detail === workspace) void load(); };
    window.addEventListener(CHANGED, changed);
    return () => { mounted.current = false; generation.current++; window.removeEventListener(CHANGED, changed); };
  }, [workspace, knowledgeProjectId]);
  useEffect(() => { void load(); }, [refreshToken, knowledgeProjectId]);
  useEffect(() => { setQuery(""); setGroup("all"); setDialogError(""); setConfirmRevision(""); }, [knowledgeProjectId]);
  useEffect(() => {
    if (!dialog) return;
    onDialogChange?.(true);
    return () => onDialogChange?.(false);
  }, [Boolean(dialog), onDialogChange]);
  const close = () => { setDialog(null); setDialogError(""); setConfirmRevision(""); };
  const open = (value) => { setDialog(value); setDialogError(""); setConfirmRevision(""); };
  const changed = (next) => {
    if (mounted.current && activeProject.current === knowledgeProjectId) {
      generation.current++;
      setSnapshot({ projectId: knowledgeProjectId, data: next }); setError(""); setLoading(false);
    }
    window.dispatchEvent(new CustomEvent(CHANGED, { detail: workspace }));
  };
  const restore = async (revision) => {
    if (writing.current) return;
    writing.current = true; generation.current++; setReverting(true); setLoading(false); setDialogError("");
    try {
      const result = await window.desktop.understanding.revert({ workspacePath: workspace, knowledgeProjectId, taskId: task.id, revisionId: revision.id });
      if (!mounted.current || activeProject.current !== knowledgeProjectId) return;
      changed(result.state); setConfirmRevision("");
      onNotice?.(tr("已恢复知识版本 {revision}，并保留新的回退记录。", "Restored knowledge revision {revision} with a new history record.", { revision: revision.number }));
    } catch (failure) {
      if (mounted.current) setDialogError(failure?.message || tr("恢复失败，请重试", "Restore failed. Try again."));
    } finally { writing.current = false; if (mounted.current) setReverting(false); }
  };
  const facts = state?.facts || [];
  const visible = useMemo(() => {
    const selected = groups.find((item) => item.id === group);
    const needle = query.trim().toLocaleLowerCase();
    return facts.filter((fact) => (!selected?.categories || selected.categories.includes(fact.category)) && (!needle || [fact.content, label(fact.category), ...(fact.evidence || []).flatMap((item) => [item.reference, item.detail])].join(" ").toLocaleLowerCase().includes(needle)));
  }, [facts, query, group, tr]);
  const fact = dialog?.type === "fact" ? facts.find((item) => item.id === dialog.id) : null;
  const settingsSummary = task.knowledgeEnabled ? tr("本任务：按需读取", "Task: on-demand reading") : tr("本任务：知识关闭", "Task: knowledge off");
  const title = dialog?.type === "settings" ? tr("知识设置", "Knowledge settings") : dialog?.type === "history" ? tr("修订历史", "Revision history") : tr("知识详情", "Knowledge details");
  return <section className="knowledge-panel" aria-label={tr("项目知识", "Project knowledge")}>
    <header className="knowledge-header">
      <div className="knowledge-heading"><BookOpen size={20} /><h2>{tr("项目知识", "Project knowledge")}</h2></div>
      <div className="knowledge-tools">
        <button className="knowledge-project-trigger" type="button" onClick={() => open({ type: "settings" })} aria-label={tr("项目设置：{name}", "Project settings: {name}", { name: projectName })} aria-haspopup="dialog" aria-expanded={dialog?.type === "settings"} title={projectName}><span>{projectName}</span><ChevronDown size={14} /></button>
        <button type="button" onClick={() => open({ type: "history" })} disabled={!state} aria-label={tr("修订历史", "Revision history")} title={tr("修订历史", "Revision history")}><History size={16} /><span>{tr("历史", "History")}</span></button>
        <button type="button" onClick={() => void load()} disabled={loading || reverting} aria-label={tr("刷新知识", "Refresh knowledge")} title={tr("刷新知识", "Refresh knowledge")}><RotateCcw size={16} className={loading ? "spin" : ""} /></button>
      </div>
    </header>
    <div className="knowledge-search"><Search size={16} /><input type="search" aria-label={tr("搜索项目知识", "Search project knowledge")} placeholder={tr("搜索知识、文件或命令…", "Search knowledge, files or commands…")} value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" aria-label={tr("清除搜索", "Clear search")} onClick={() => setQuery("")}><X size={14} /></button>}</div>
    <div className="knowledge-filters" role="group" aria-label={tr("知识分类", "Knowledge categories")}>{groups.map((item) => <button key={item.id} type="button" aria-pressed={group === item.id} onClick={() => setGroup(item.id)}>{tr(item.zh, item.en)}</button>)}</div>
    {error && <div className="knowledge-alert" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}
    {loading && !state ? <p role="status" className="knowledge-empty">{tr("正在读取项目知识…", "Loading project knowledge…")}</p> : <>
      {(query || group !== "all") && <p className="knowledge-result-count" role="status">{tr("找到 {count} 条知识", "{count} matching entries", { count: visible.length })}</p>}
      <div className="knowledge-list">{visible.map((item) => <article className="knowledge-item" key={item.id}>
        <div className="knowledge-item-top"><span className="knowledge-category">{label(item.category)}</span><button className="knowledge-detail-trigger" type="button" aria-haspopup="dialog" aria-label={tr("查看知识详情：{content}", "View knowledge details: {content}", { content: item.content.slice(0, 60) })} title={tr("查看详情", "View details")} onClick={() => open({ type: "fact", id: item.id })}><ChevronRight size={16} /></button></div>
        <p>{item.content}</p>
        <div className="knowledge-item-meta"><span>{tr("来源", "Source")}: {item.evidence?.[0]?.reference || item.evidence?.[0]?.detail || tr("未记录", "Not recorded")}{item.evidence?.length > 1 ? ` +${item.evidence.length - 1}` : ""}</span><span>{dateLabel(item.lastConfirmedAt)}</span></div>
      </article>)}</div>
      {!visible.length && !error && <div className="knowledge-empty"><BookOpen size={24} /><h3>{facts.length ? tr("没有匹配的知识", "No matching knowledge") : tr("还没有保存的项目知识", "No project knowledge yet")}</h3><p>{facts.length ? tr("试试其他关键词或分类。", "Try another search or category.") : tr("这里保存可复用的项目约定和经验。查看不消耗模型额度。", "Reusable project conventions and findings live here. Viewing uses no model quota.")}</p><button type="button" onClick={() => facts.length ? (setQuery(""), setGroup("all")) : open({ type: "settings" })} disabled={!state}>{facts.length ? tr("清除筛选", "Clear filters") : tr("查看记录设置", "Recording settings")}</button></div>}
    </>}
    {dialog && <SideChatDialog className="knowledge-dialog" title={title} subtitle={task.workspaceName || workspace} onClose={close}>
      {dialog.type === "settings" && <>
        <div className="knowledge-project-options">
          <label className="knowledge-project-field"><span>{tr("查看知识项目", "Browse knowledge project")}</span><select className="text-field" value={knowledgeProjectId} aria-label={tr("查看知识项目", "Browse knowledge project")} onChange={(event) => onSelectProject(event.target.value)}>
            {!projects.some((p) => p.id === knowledgeProjectId) && <option value={knowledgeProjectId}>{tr("读取中…", "Loading…")}</option>}
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select></label>
          <div className="knowledge-project-actions">
            <button type="button" disabled={!workspace || !window.desktop?.understanding?.createProject} onClick={() => { close(); onCreateProject(); }}>{tr("新建知识项目", "New knowledge project")}</button>
            {onUpdateTask && <button type="button" disabled={isRunning || (task.knowledgeEnabled && task.knowledgeProjectId === knowledgeProjectId)} onClick={() => onUpdateTask({ knowledgeEnabled: true, knowledgeProjectId })}>{task.knowledgeEnabled && task.knowledgeProjectId === knowledgeProjectId ? tr("本任务使用中", "Used by this task") : tr("用于本任务", "Use for this task")}</button>}
          </div>
          <div className="knowledge-summary"><span>{state ? tr("{count} 条已保存", "{count} saved", { count: facts.length }) : tr("尚未读取知识", "Knowledge not loaded")}</span><span>{settingsSummary}</span></div>
        </div>
        {onUpdateTask && <TaskKnowledgeControls workspacePath={workspace} enabled={task.knowledgeEnabled} projectId={task.knowledgeProjectId} onChange={onUpdateTask} isRunning={isRunning} />}
        <UnderstandingControls key={knowledgeProjectId} workspacePath={workspace} knowledgeProjectId={knowledgeProjectId} state={state} onChange={changed} />
        {!!task.knowledgeReads?.length && <details className="knowledge-read-log"><summary>{tr("本任务知识读取记录", "Task knowledge reads")} · {task.knowledgeReads.length}</summary>{task.knowledgeReads.slice().reverse().map((read, index) => <p key={index}>{dateLabel(read.at)} · {read.projectId} · {read.count} {tr("条", "entries")} {read.query}</p>)}</details>}
      </>}
      {dialog.type === "fact" && (fact ? <div className="knowledge-detail">
        <span className="knowledge-category">{label(fact.category)}</span><p className="knowledge-detail-content">{fact.content}</p>
        <dl><dt>{tr("最近记录／确认", "Last recorded / confirmed")}</dt><dd>{dateLabel(fact.lastConfirmedAt)}</dd></dl>
        <h3>{tr("来源与依据", "Sources & evidence")}</h3>
        {(fact.evidence || []).map((item, index) => <div className="knowledge-evidence" key={index}>{item.type === "file" && item.reference ? <button type="button" onClick={() => { close(); onOpenFile?.(item.reference); }}><FileText size={15} /><span>{item.reference}</span></button> : <strong>{item.reference || tr("来源记录", "Source record")}</strong>}{item.detail && <p>{item.detail}</p>}</div>)}
        {!fact.evidence?.length && <p>{tr("未记录来源，请以当前项目文件为准。", "No source recorded. Consult the current project files.")}</p>}
        <details><summary>{tr("更多信息", "More information")}</summary><p>{tr("模型估计的置信度", "Model-estimated confidence")}: {Number.isFinite(fact.confidence) ? `${Math.round(fact.confidence * 100)}%` : "—"}</p><p>{tr("不是正确率或验证通过的证明。是否进入任务上下文，还取决于相关性、时效和文件证据检查。", "This is not an accuracy score or proof of verification. Recall also depends on relevance, freshness and file-evidence checks.")}</p></details>
      </div> : <p>{tr("该条目已在其他任务中变更，请关闭后刷新。", "This entry changed in another task. Close and refresh.")}</p>)}
      {dialog.type === "history" && <div className="knowledge-history"><p className="knowledge-history-note">{tr("仅恢复项目知识，不修改代码或任务对话；恢复会新增一条历史记录。", "Restores knowledge only, not code or conversations. A new history entry is kept.")}</p>{dialogError && <p className="knowledge-alert" role="alert">{dialogError}</p>}
        {(state?.revisions || []).map((revision) => <article key={revision.id} className="knowledge-revision"><header><strong>{tr("版本 {number}", "Revision {number}", { number: revision.number })}</strong>{revision.number === state.currentRevision && <span>{tr("当前", "Current")}</span>}<time>{dateLabel(revision.createdAt)}</time></header><p>{revision.summary}</p><small>{tr("{count} 条知识", "{count} entries", { count: revision.factCount })}</small>
          {!!revision.changes?.length && <details><summary>{tr("查看该次修改", "View revision changes")}</summary>{revision.changes.map((change, index) => <p key={index}><b>{tr(...({ add: ["新增", "Added"], update: ["更新", "Updated"], remove: ["移除", "Removed"] }[change.operation] || ["变更", "Changed"]))}</b> · {change.content}</p>)}</details>}
          {revision.number !== state.currentRevision && <div className="knowledge-restore">{confirmRevision === revision.id && <><p>{tr("将用此版本替换当前项目知识。来源文件不会恢复，请确认后继续。", "This replaces current knowledge. Source files are not restored. Confirm to continue.")}</p><button type="button" disabled={reverting} onClick={() => setConfirmRevision("")}>{tr("取消", "Cancel")}</button></>}<button type="button" disabled={reverting || !window.desktop?.understanding?.revert} onClick={() => confirmRevision === revision.id ? void restore(revision) : setConfirmRevision(revision.id)}>{reverting && confirmRevision === revision.id ? tr("恢复中…", "Restoring…") : confirmRevision === revision.id ? tr("确认恢复", "Confirm restore") : tr("恢复此版本", "Restore revision")}</button></div>}
        </article>)}
        {!state?.revisions?.length && <p>{tr("还没有修订记录。保存或自动记录知识后会出现在这里。", "No revisions yet. History appears after knowledge is saved or recorded.")}</p>}
      </div>}
    </SideChatDialog>}
  </section>;
}
