export function taskSuspensionLabel(reasons = [], language = "zh-CN") {
  const en = language === "en";
  if (reasons.includes("clarification")) return en ? "Waiting for your answer" : "等待你的回答";
  if (reasons.includes("user")) return en ? "Task paused by you" : "任务已手动暂停";
  if (reasons.includes("sleep")) return en ? "System suspended · resumes after wake" : "系统暂停 · 唤醒后自动继续";
  if (reasons.includes("network")) return en ? "Waiting for network · reconnecting automatically" : "等待网络恢复 · 自动重连";
  if (reasons.includes("provider-budget-wait")) return en ? "Waiting for Cloud-wide cost settlement" : "等待 Cloud 全站费用结算 · 自动继续";
  if (reasons.includes("daily-budget")) return en ? "Cloud daily limit · progress saved" : "Cloud 今日额度已达上限 · 进度已保存";
  if (reasons.includes("quota")) return en ? "Cloud quota insufficient · resume after refill" : "Cloud 额度不足 · 补充后可继续";
  if (reasons.includes("quota-wait")) return en ? "Waiting for Cloud quota to settle" : "等待其他 Cloud 请求结算 · 自动继续";
  return en ? "Task paused" : "任务已暂停";
}
