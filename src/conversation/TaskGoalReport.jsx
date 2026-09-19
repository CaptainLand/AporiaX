import React from "react";
import { useI18n } from "../i18n";

export function TaskGoalReport({ brief, acceptance, strategy }) {
  const { tr } = useI18n();
  if (!brief?.entries?.length && !acceptance && !strategy) return null;
  return <details className="task-goal-report">
    <summary>{tr("决策与逐项验收", "Decisions and per-requirement acceptance")}{acceptance ? ` · ${acceptance.passed ? tr("配置检查通过", "Configured checks passed") : tr("尚未全部满足", "Not fully satisfied")}` : ""}</summary>
    {acceptance && <div><p>{tr("只代表已配置条件的检查结果，不证明遗漏的需求也已实现。", "Only configured predicates were checked; omitted requirements are not certified.")}</p>
      {(acceptance.requirements || []).map((row) => <div key={row.id}><strong>{row.id} · {row.text}</strong> <code>{row.status}</code>
        <ul>{row.checks.map((check, index) => <li key={index}><code>{check.type}</code> {check.path || ""} — {check.status}{check.error ? `: ${check.error}` : ""}{check.receipt?.callId ? ` (${check.receipt.callId})` : ""}</li>)}</ul>
      </div>)}
    </div>}
    {(brief?.entries || []).map((entry) => <details key={entry.id}><summary>{entry.id} · {entry.summary}{entry.supersededBy ? ` → ${entry.supersededBy}` : ""}</summary>
      <p>{entry.rationale}</p><small>{tr("模型记录，非验证通过；历史证据需重新核对。", "Agent assertion, not a pass. Historical evidence requires rechecking.")}</small>
      <ul>{(entry.evidence || []).map((item, i) => <li key={i}><code>{item.callId || item.sourceId}</code> {item.tool || "source"} {item.historical ? tr("（历史）", "(historical)") : ""}</li>)}</ul>
    </details>)}
    {strategy?.pending && <p>{strategy.blocking ? tr("等待新诊断和不同策略", "Awaiting fresh diagnostics and a different strategy") : tr("建议补充诊断并调整策略（不阻止任务）", "Consider fresh diagnostics and a different strategy (non-blocking)")}: {strategy.pending.reason}</p>}
  </details>;
}
