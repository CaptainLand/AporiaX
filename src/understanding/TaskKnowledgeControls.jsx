import { useEffect, useState } from "react";
import { Switch } from "../components/Controls.jsx";
import { useI18n } from "../i18n";

export function TaskKnowledgeControls({ workspacePath, enabled, projectId = "", onChange, isRunning = false }) {
  const { tr } = useI18n();
  const [projects, setProjects] = useState([]), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    setProjects([]); setError("");
    if (!workspacePath || !enabled) { setLoading(false); return; }
    setLoading(true);
    Promise.resolve(window.desktop?.understanding?.projects?.({ workspacePath }) || [])
      .then((rows) => { if (active) setProjects(rows); })
      .catch((failure) => { if (active) setError(failure.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspacePath, enabled]);
  return <section className="task-knowledge-controls" aria-label={tr("任务项目知识", "Task project knowledge")}>
    <div className="knowledge-setting"><div><h3>{tr("项目知识", "Project knowledge")}</h3><p>{tr("开启后由 AI 按需搜索、读取或创建知识项目，不自动加入上下文。", "Let AI search, read or create a knowledge project on demand. Nothing is automatically injected.")}</p></div><Switch label={tr("允许任务使用项目知识", "Allow task project knowledge")} checked={Boolean(workspacePath && enabled)} disabled={!workspacePath} onChange={(value) => onChange({ knowledgeEnabled: value })} /></div>
    {enabled && workspacePath && <label className="knowledge-project-field"><span>{tr("任务知识来源", "Task knowledge source")}</span><select className="text-field" aria-label={tr("任务知识来源", "Task knowledge source")} disabled={loading || isRunning || Boolean(error)} value={projectId} onChange={(event) => onChange({ knowledgeProjectId: event.target.value })}>
      <option value="">{tr("AI 按任务选择或创建", "AI selects or creates for this task")}</option>
      {projectId && !projects.some((p) => p.id === projectId) && <option value={projectId}>{loading ? tr("读取中…", "Loading…") : tr("项目不可用，请重新选择", "Project unavailable; select again")}</option>}
      {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
    </select></label>}
    <p className="field-hint">{isRunning ? tr("开关在下次运行生效；当前运行的知识项目保持不变。", "Toggle applies to the next run; the current run keeps its project.") : tr("仅影响本任务。关闭后仍可浏览已保存知识。", "Applies to this task only. Saved knowledge remains viewable when off.")}</p>
    {error && <p className="knowledge-alert" role="alert">{error}</p>}
  </section>;
}
