import { providerErrorCategory } from "./provider-errors.js";

// Opt in only when a fresh inference is safe. Authorization challenges,
// incomplete streams and uncertain Cloud accounting need human intervention
// or the existing request reconciliation, not another paid request.
export function automaticResumeHint({ error, providerKind, status, replySource, replyDelivered, persistenceFailed }) {
  if (!error || !["failed", "partial"].includes(status) || persistenceFailed ||
      (replyDelivered && replySource !== "local-receipt") ||
      error.name === "AbortError" || error.noAutomaticRetry || error.safeToRepair === false ||
      error.cloudQuota || error.partialMessage || error.usage ||
      providerKind === "chatgpt-personal") return null;

  const category = providerErrorCategory(error);
  const httpStatus = Number(error.status);
  const safeRejection = [425, 429].includes(httpStatus);
  if (providerKind === "aporia-cloud") {
    if (!error.retryWithNewCloudRequest || !error.cloudRequestId ||
        !(safeRejection || (category === "server" && httpStatus >= 500 && httpStatus <= 599))) return null;
  } else {
    const preConnect = error.requestNeverConnected === true;
    if (!(preConnect || (safeRejection && error.modelHttpRejection === true))) return null;
  }
  if (["authorization", "quota", "context", "request-size", "output-limit", "tool-protocol"].includes(category)) return null;
  const retryAfterMs = Number(error.retryAfterMs) || 0;
  if (retryAfterMs > 120_000) return null;
  return { reason: category === "rate-limit" ? "rate-limit" : category === "server" ? "server" : "connection",
    retryAfterMs: Math.max(0, retryAfterMs) };
}
