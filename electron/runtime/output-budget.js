export const DEEPSEEK_OUTPUT_LIMITS = Object.freeze({ nonThinking: 8192, thinking: 65536, maxThinking: 131072, maximum: 393216 });
export function isManagedDeepSeek(provider, body) {
  return provider.kind === "aporia-cloud" && body.model === "aporia-cloud-default";
}
export function deepSeekOutputLimit(body) {
  if (body.reasoning_effort === "none" || (!body.reasoning_effort && body.thinking?.type === "disabled")) return DEEPSEEK_OUTPUT_LIMITS.nonThinking;
  return body.reasoning_effort === "max" ? DEEPSEEK_OUTPUT_LIMITS.maxThinking : DEEPSEEK_OUTPUT_LIMITS.thinking;
}
export function modelOutputBudget(provider, body) {
  const deepseek = isManagedDeepSeek(provider, body) || provider.vendor === "deepseek" || provider.protocol === "deepseek-chat";
  return {
    limit: body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? (deepseek ? deepSeekOutputLimit(body) : null),
    // An explicit caller ceiling is a real limit, not permission to raise it.
    maximum: body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? (deepseek ? DEEPSEEK_OUTPUT_LIMITS.maximum : (provider.nativeModel?.maxOutputTokens ?? provider.maxOutputTokens ?? null)),
  };
}
