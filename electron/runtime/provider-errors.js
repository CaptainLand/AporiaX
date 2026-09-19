// Keep transport failure, context pressure and uncertain tool effects separate.
export function providerErrorCategory(error) {
  const code = [error?.providerCode, error?.code, error?.message].filter(Boolean).join(" ");
  if (/insufficient_quota|billing_hard_limit|quota_exhausted|budget_exhausted|account.*(?:balance|credit)/i.test(code)) return "quota";
  if (/context_length_exceeded|context_window_exceeded|maximum context length|prompt.{0,30}too long|too many (?:input )?tokens|context.{0,30}(?:exceed|overflow)/i.test(code)) return "context";
  if (error?.code === "PROVIDER_FINISH_LENGTH") return "output-limit";
  if (["PROVIDER_TOOL_CALL_INVALID", "PROVIDER_TOOL_CALL_INCOMPLETE"].includes(error?.code)) return "tool-protocol";
  if (error?.name === "AbortError") return "cancelled";
  if ([401, 403].includes(Number(error?.status))) return "authorization";
  if (Number(error?.status) === 429) return "rate-limit";
  if (Number(error?.status) >= 500) return "server";
  if (error instanceof TypeError || error?.retryable) return "transport";
  return "other";
}

export function retryAfterMilliseconds(headers, now = Date.now()) {
  const rawMs = headers?.get?.("retry-after-ms");
  if (rawMs !== null && rawMs !== undefined && /^\d+(?:\.\d+)?$/.test(rawMs.trim())) return Math.ceil(Number(rawMs));
  const raw = headers?.get?.("retry-after");
  if (!raw?.trim()) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw.trim())) return Math.ceil(Number(raw) * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function providerRetryDelay(attempt, retryAfterMs = null, random = Math.random) {
  const jitter = Math.max(0, Math.min(1, Number(random()) || 0));
  const backoff = Math.min(30_000, 750 * 2 ** Math.max(0, attempt - 1));
  return Math.ceil(Math.max(Number(retryAfterMs) || 0, backoff * (1 + 0.25 * jitter)));
}
