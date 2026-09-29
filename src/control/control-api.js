// Renderer access stays behind the trusted desktop IPC bridge. Tokens are never
// needed for administration and must not be put in the task or settings stores.
export async function controlRequest(action, input = {}) {
  if (!window.desktop?.control?.request) {
    throw new Error("APORIAX_CONTROL_UNAVAILABLE");
  }
  const value = await window.desktop.control.request({ action, input });
  if (value?.ok === false || value?.accepted === false) {
    throw new Error(value?.error?.message || value?.message || value?.error || "APORIAX_CONTROL_REQUEST_REJECTED");
  }
  return value;
}

export function controlError(error, tr, secret = "") {
  if (error?.message === "APORIAX_CONTROL_UNAVAILABLE") {
    return tr("此设置需要新版 AporiaX 桌面端。请更新并重新启动应用。", "This setting requires the updated AporiaX desktop app. Update and restart the app.");
  }
  let message = String(error?.message || tr("操作失败，请重试。", "The operation failed. Please retry."))
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "");
  if (secret) message = message.split(secret).join("[credential]");
  return message;
}

export function endpointUrl(endpoint) {
  if (typeof endpoint === "string") return endpoint;
  return endpoint?.url || endpoint?.baseUrl || "";
}

export function runStateLabel(status, tr) {
  const labels = {
    queued: ["排队中", "Queued"],
    starting: ["启动中", "Starting"],
    running: ["运行中", "Running"],
    paused: ["已暂停", "Paused"],
    suspended: ["等待恢复", "Suspended"],
    interrupted: ["已中断", "Interrupted"],
    waiting: ["等待处理", "Waiting"],
    waiting_for_input: ["等待回答", "Awaiting an answer"],
    awaiting_approval: ["等待审批", "Awaiting approval"],
    waiting_question: ["等待回答", "Awaiting an answer"],
    waiting_approval: ["等待审批", "Awaiting approval"],
    cancelling: ["正在停止", "Stopping"],
    completed: ["已完成", "Completed"],
    partial: ["部分完成", "Partial"],
    blocked: ["受阻", "Blocked"],
    failed: ["失败", "Failed"],
    cancelled: ["已取消", "Cancelled"],
    canceled: ["已取消", "Cancelled"],
  };
  const pair = labels[status];
  return pair ? tr(...pair) : status || tr("未知", "Unknown");
}

export function runIsFinished(status) {
  return ["completed", "failed", "cancelled", "canceled", "partial", "blocked", "interrupted"].includes(status);
}

export function readableValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value, null, 2);
}
