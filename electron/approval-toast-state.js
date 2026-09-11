export const APPROVAL_TOAST_TIMEOUT_MS = 5_000;
export const APPROVAL_TOAST_BODY_LIMIT = 160;

export function approvalToastCopy(approval = {}, language = "zh-CN") {
  const english = String(language || "").toLowerCase().startsWith("en");
  const title = String(approval.title || (english ? "Approval required" : "需要确认"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const raw = String(approval.command || approval.reason || "")
    .replace(/\s+/g, " ")
    .trim();
  const body = raw.slice(0, APPROVAL_TOAST_BODY_LIMIT);
  return {
    eyebrow: english ? "Needs confirmation" : "等待确认",
    title: title || (english ? "Approval required" : "需要确认"),
    body: body || (english ? "The agent needs approval for this action." : "Agent 需要你确认这次操作。"),
    approve: english ? "Approve" : "确认",
    deny: english ? "Deny" : "拒绝",
  };
}

export function approvalToastClosedByTimeout(elapsedMs, clicked) {
  return !clicked && Number(elapsedMs) >= APPROVAL_TOAST_TIMEOUT_MS;
}
