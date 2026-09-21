export function taskSuspensionLabel(reasons = [], language = "zh-CN") {
  const en = language === "en";
  if (reasons.includes("user")) return en ? "Task paused by you" : "任务已手动暂停";
  if (reasons.includes("sleep")) return en ? "System suspended · resumes after wake" : "系统暂停 · 唤醒后自动继续";
  if (reasons.includes("network")) return en ? "Waiting for network · reconnecting automatically" : "等待网络恢复 · 自动重连";
  return en ? "Task paused" : "任务已暂停";
}
