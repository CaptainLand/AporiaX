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
  const strict = task.loopPolicy?.strategyMode === "strict";
  return <section className="settings-section task-goal-settings">
    <div className="settings-label">{tr("任务决策与验收", "Decisions and acceptance")}</div>
    <p className="settings-help">{tr("决策按版本保存，模型判断不等于验证事实。验收只检查配置的条件；不会自行执行命令。", "Decisions are versioned assertions, not verified facts. Acceptance checks configured predicates only and never launches commands itself.")}</p>
    <div className="settings-group">
      <label className="settings-row">
        <span className="settings-row-copy"><strong>{tr("重复失败处理", "Repeated failure policy")}</strong></span>
        <select className="settings-select" aria-label="Repeated failure policy" value={task.loopPolicy?.strategyMode ?? "advisory"}
          onChange={(event) => onUpdateTask({ loopPolicy: { ...task.loopPolicy, strategyMode: event.target.value } })}>
          <option value="advisory">{tr("提示优先（默认）", "Advisory (default)")}</option>
          <option value="strict">{tr("严格限制", "Strict")}</option>
        </select>
      </label>
      {strict && <label className="settings-row">
        <span className="settings-row-copy"><strong>{tr("每个问题的重新规划额度", "Replans per problem")}</strong></span>
        <select className="settings-select" aria-label="Replans per problem" value={task.loopPolicy?.maxStrategyInterventions ?? 2}
          onChange={(event) => onUpdateTask({ loopPolicy: { ...task.loopPolicy, maxStrategyInterventions: Number(event.target.value) } })}>
          <option value="0">{tr("仅提示，不拦截", "Warn only, no blocking")}</option>
          {[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count}</option>)}
        </select>
      </label>}
      <label className="settings-row">
        <span className="settings-row-copy">
          <strong>{tr("要求当前版本验证证据", "Require current-version verification evidence")}</strong>
          <small>{tr("完整自然语言需求仍需人工核对。", "Unspecified semantic requirements still need review.")}</small>
        </span>
        <input type="checkbox" className="settings-toggle" aria-label={tr("要求当前版本验证证据", "Require current-version verification evidence")}
          checked={task.loopPolicy?.requireVerifiedChanges === true}
          onChange={(event) => onUpdateTask({ loopPolicy: { ...task.loopPolicy, requireVerifiedChanges: event.target.checked } })} />
      </label>
    </div>
    <p className="settings-help">{strict
      ? tr("严格模式按独立问题限制重复尝试，诊断命令仍需遵守原有权限。", "Strict limits repeated attempts per problem; diagnostic commands still follow existing permissions.")
      : tr("提示优先不会因重新规划额度用尽而停止任务。", "Advisory never stops a task for strategy-budget exhaustion.")}</p>
    <details className="settings-disclosure"><summary>{tr("配置逐项验收（JSON）", "Configure per-requirement acceptance (JSON)")}</summary>
      <p className="settings-help">{tr("留空时读取工作区 .aporiax/acceptance.json。空 checks 表示需要人工核对，不会自动通过。命令检查须声明 inputs，并通过普通工具审批执行。", "Empty uses workspace .aporiax/acceptance.json. Empty checks require human review. Command checks require declared inputs and normal tool approval.")}</p>
      <textarea aria-label="Task acceptance contract" className="settings-code-field" rows={10} value={draft} maxLength={64000} spellCheck={false}
        onChange={(event) => setDraft(event.target.value)} placeholder={'{"version":1,"enforce":true,"requirements":[{"id":"r1","text":"Create README","checks":[{"type":"file_exists","path":"README.md"}]}]}'} />
      <div className="settings-button-row">
        <button type="button" className="settings-button primary" onClick={save}>{tr("保存验收配置", "Save acceptance contract")}</button>
        <button type="button" className="settings-button" onClick={() => { onUpdateTask({ taskContract: null }); setDraft(""); setMessage(tr("已显式关闭工作区验收配置，下次请求生效。", "Workspace acceptance explicitly disabled for the next invocation.")); }}>{tr("关闭配置验收", "Disable configured acceptance")}</button>
      </div>
      {message && <p className="settings-help" role="status">{message}</p>}
    </details>
  </section>;
}
