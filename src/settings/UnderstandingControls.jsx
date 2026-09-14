import React, { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";

export function UnderstandingControls({ workspacePath, state, onChange }) {
  const { tr } = useI18n();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const change = async (key, value) => {
    if (saving) return;
    setSaving(true); setError("");
    try {
      const next = await window.desktop.understanding.setSettings({ workspacePath, settings: { [key]: value } });
      if (active.current) onChange(next);
    } catch (failure) {
      if (active.current) setError(String(failure?.message || failure));
    } finally { if (active.current) setSaving(false); }
  };
  const disabled = !state || saving || !window.desktop?.understanding?.setSettings;
  return <section className="understanding-fact" aria-label={tr("项目知识选项", "Project knowledge options")}>
    <strong>{state?.settings?.useForContext ? tr("按需参考", "Relevant recall") : tr("仅查看", "View only")}</strong>
    <p>{tr("已有知识始终可以查看。默认不注入模型，也不额外调用 Curator。", "Saved knowledge remains viewable. Model injection and automatic Curator calls are off by default.")}</p>
    <div className="understanding-fact-meta">
      <label><input type="checkbox" checked={state?.settings?.useForContext === true} disabled={disabled} onChange={(event) => void change("useForContext", event.target.checked)} /> {tr("参与任务上下文", "Use in task context")}</label>
      <label><input type="checkbox" checked={state?.settings?.autoCurate === true} disabled={disabled} onChange={(event) => void change("autoCurate", event.target.checked)} /> {tr("自动整理知识（消耗模型额度）", "Auto-curate knowledge (uses model quota)")}</label>
    </div>
    <p>{tr("按工作区保存；上下文在下一次模型请求前刷新，自动整理在后续任务中启用。过期或文件证据已变更的知识只保留查看。", "Saved per workspace. Recall refreshes before the next model request; auto-curation activates in subsequent tasks. Expired facts or changed file evidence remain view-only.")}</p>
    {error && <p role="alert">{error}</p>}
  </section>;
}
