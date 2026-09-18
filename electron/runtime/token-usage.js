// Provider usage is billing evidence, not a tokenizer. Preserve unknown cache
// fields as absent and never count a cache-read subset twice in prompt_tokens.
const number = (value) => value !== null && value !== undefined && value !== "" &&
  Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined;
const first = (...values) => values.map(number).find((value) => value !== undefined);

export function normalizeTokenUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const read = first(usage.prompt_cache_hit_tokens, usage.promptCacheHitTokens,
    usage.prompt_tokens_details?.cached_tokens, usage.input_tokens_details?.cached_tokens,
    usage.cache_read_input_tokens, usage.cacheReadInputTokens);
  const write = first(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens);
  const explicitPrompt = first(usage.prompt_tokens, usage.promptTokens);
  const input = first(usage.input_tokens, usage.inputTokens);
  // Raw Anthropic input_tokens excludes cache reads AND creations. Once
  // normalized, prompt_tokens takes precedence so repeated merges are idempotent.
  const exclusiveInput = explicitPrompt === undefined && input !== undefined &&
    (first(usage.cache_read_input_tokens, usage.cacheReadInputTokens) !== undefined || write !== undefined) &&
    usage.prompt_cache_hit_tokens === undefined && usage.prompt_tokens_details === undefined &&
    usage.input_tokens_details === undefined;
  const prompt = explicitPrompt ?? (exclusiveInput ? input + (read ?? 0) + (write ?? 0) : input) ?? 0;
  const output = first(usage.completion_tokens, usage.completionTokens, usage.output_tokens, usage.outputTokens) ?? 0;
  const miss = first(usage.prompt_cache_miss_tokens, usage.promptCacheMissTokens) ??
    (exclusiveInput ? input : read !== undefined ? Math.max(0, prompt - read - (write ?? 0)) : undefined);
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: first(usage.total_tokens, usage.totalTokens) ?? prompt + output,
    ...(read === undefined ? {} : { prompt_cache_hit_tokens: read }),
    ...(miss === undefined ? {} : { prompt_cache_miss_tokens: miss }),
    ...(write === undefined ? {} : { cache_creation_input_tokens: write }),
    ...(usage.cache_usage_incomplete ? { cache_usage_incomplete: true } : {}),
  };
}

export function mergeTokenUsage(current, incoming) {
  if (!incoming) return current || null;
  const left = normalizeTokenUsage(current), right = normalizeTokenUsage(incoming);
  const result = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    result[key] = (left?.[key] ?? 0) + (right?.[key] ?? 0);
  }
  const keys = ["prompt_cache_hit_tokens", "prompt_cache_miss_tokens", "cache_creation_input_tokens"];
  for (const key of keys) {
    if (left?.[key] !== undefined || right?.[key] !== undefined) result[key] = (left?.[key] ?? 0) + (right?.[key] ?? 0);
  }
  // Summed known cache fields are lower bounds if any request omitted them.
  const leftKnown = left?.prompt_cache_hit_tokens !== undefined;
  const rightKnown = right?.prompt_cache_hit_tokens !== undefined;
  if (left?.cache_usage_incomplete || right?.cache_usage_incomplete ||
      (left && leftKnown !== rightKnown)) result.cache_usage_incomplete = true;
  return result;
}
