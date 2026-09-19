import React, { useState } from "react";
import { useI18n } from "../i18n";
import { normalizeTaskContract } from "../../electron/runtime/task-contract-schema.js";

export function TaskGoalSettings({ task, onUpdateTask }) {
  const { tr } = useI18n();
  const [draft, setDraft] = useState(() => task.taskContract ? JSON.stringify(task.taskContract, null, 2) : "");
  const [message, setMessage] = useState("");
  const save = () => {
    try {
      const contract = draft.trim() ? normalizeTaskContract(JSON.parse(draft)) : undefined;
      onUpdateTask({ taskContract: contract });
      setMessage(tr("已保存，下次任务请求生效。", "Saved for the next invocation."));
    } catch (error) { setMessage(error.message); }
  };
  return <section className="settings-section task-goal-settings">
    <div className="settings-label">{tr("任务决策与验收", "Decisions and acceptance")}</div>
    <p>{tr("决策按版本保存，模型判断不等于验证事实。验收只检查配置的条件；不会自行执行命令。", "Decisions are versioned assertions, not verified facts. Acceptance checks configured predicates only and never launches commands itself.")}</p>
    <details><summary>{tr("配置逐项验收（JSON）", "Configure per-requirement acceptance (JSON)")}</summary>
      <p>{tr("留空时读取工作区 .aporiax/acceptance.json。空 checks 表示需要人工核对，不会自动通过。命令检查须声明 inputs，并通过普通工具审批执行。", "Empty uses workspace .aporiax/acceptance.json. Empty checks require human review. Command checks require declared inputs and normal tool approval.")}</p>
      <textarea aria-label="Task acceptance contract" className="text-field" rows={12} value={draft} maxLength={64000}
        onChange={(event) => setDraft(event.target.value)} placeholder={'{"version":1,"enforce":true,"requirements":[{"id":"r1","text":"Create README","checks":[{"type":"file_exists","path":"README.md"}]}]}'} />
      <button type="button" className="secondary-button" onClick={save}>{tr("保存验收配置", "Save acceptance contract")}</button>
      <button type="button" className="secondary-button" onClick={() => { onUpdateTask({ taskContract: null }); setDraft(""); setMessage(tr("已显式关闭工作区验收配置，下次请求生效。", "Workspace acceptance explicitly disabled for the next invocation.")); }}>{tr("关闭配置验收", "Disable configured acceptance")}</button>
      {message && <p role="status">{message}</p>}
    </details>
    <label><input type="checkbox" checked={task.loopPolicy?.requireVerifiedChanges === true} onChange={(event) => onUpdateTask({ loopPolicy: { ...task.loopPolicy, requireVerifiedChanges: event.target.checked } })} /> {tr("要求当前版本验证证据", "Require current-version verification evidence")}</label>
    <small>{tr("修改策略只影响下次请求。完整自然语言需求仍需人工核对，不因测试通过而声称全部理解。", "Policy changes apply to the next invocation. Unspecified semantic requirements still need review.")}</small>
  </section>;
}
