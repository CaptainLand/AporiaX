import React, { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Switch } from "../components/Controls.jsx";

export function UnderstandingControls({ workspacePath, knowledgeProjectId = "legacy", state, onChange }) {
  const { tr } = useI18n();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const change = async (key, value) => {
    if (saving) return;
    setSaving(true); setError("");
    try {
      const next = await window.desktop.understanding.setSettings({ workspacePath, knowledgeProjectId, settings: { [key]: value } });
      // The settings dialog can close while saving. Still notify the mounted
      // workspace panel so reopening it does not show stale settings.
      onChange(next);
    } catch (failure) {
      if (active.current) setError(String(failure?.message || failure));
    } finally { if (active.current) setSaving(false); }
  };
  const disabled = !state || saving || !window.desktop?.understanding?.setSettings;
  return <section className="knowledge-settings" aria-label={tr("项目知识选项", "Project knowledge options")}>
    <div className="knowledge-setting"><div><h3>{tr("自动记录", "Automatic recording")}</h3><p>{tr("在后续任务中自动整理可复用知识，会额外消耗模型额度；不影响是否用于任务。", "Curate reusable knowledge in subsequent tasks using additional model quota. Independent of task recall.")}</p></div><Switch label={tr("自动记录", "Automatic recording")} checked={state?.settings?.autoCurate === true} disabled={disabled} onChange={(value) => void change("autoCurate", value)} /></div>
    <p className="knowledge-settings-note">{tr("自动记录按知识项目独立保存，默认关闭。仅在任务启用并选择该项目时使用；查看不消耗模型额度，也不自动注入上下文。", "Auto-recording is off by default and saved per knowledge project. Used only by enabled tasks bound to this project. Viewing uses no model quota or automatic context injection.")}</p>
    {error && <p className="knowledge-alert" role="alert">{error}</p>}
  </section>;
}
