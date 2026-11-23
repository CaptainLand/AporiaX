export function modelTokenLine(progress) {
  const count = (value, estimated) => Number.isFinite(value) && value >= 0 ? `${estimated !== false ? '≈' : ''}${Math.round(value).toLocaleString('en-US')}` : '—';
  const input = count(progress?.uncachedInputTokens, false);
  const output = count(progress?.outputTokens, progress?.outputTokensEstimated);
  return `${input === '—' ? '' : `↑ ${input} Token · `}↓ ${output} Token`;
}

const isCount = value => Number.isSafeInteger(value) && value >= 0;

function reportedCacheHits(usage, input) {
  const hits = usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens;
  return isCount(input) && isCount(hits) && hits <= input ? hits : null;
}

// Call with canonical input totals. Subtract cache reads only: creating a
// cache entry is not a hit. A missing breakdown is not evidence of a miss.
export function reportedUncachedInputTokens(usage) {
  if (usage?.cache_usage_incomplete) return null;
  const input = usage?.prompt_tokens ?? usage?.input_tokens;
  const hits = reportedCacheHits(usage, input);
  return hits === null ? null : input - hits;
}

export function reportedRunTokenLine(usage, { partial = false } = {}) {
  const input = usage?.prompt_tokens ?? usage?.input_tokens;
  const outputTokens = usage?.completion_tokens ?? usage?.output_tokens;
  if (!isCount(input) || !isCount(outputTokens)) return '';
  const uncachedInputTokens = partial ? null : reportedUncachedInputTokens(usage);
  const line = modelTokenLine({ uncachedInputTokens, outputTokens, outputTokensEstimated: false });
  return uncachedInputTokens === null ? `↑ — Token · ${line}` : line;
}

export function reportedRunUsage(usage, { partial = false } = {}) {
  const tokenLine = reportedRunTokenLine(usage, { partial });
  if (!tokenLine) return null;
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  const total = Number.isSafeInteger(usage.total_tokens) && usage.total_tokens >= 0 ? usage.total_tokens : input + output;
  const hits = reportedCacheHits(usage, input);
  const incompleteCache = partial || usage.cache_usage_incomplete === true;
  return {
    tokenLine, total, hits, partial, incompleteCache,
    hitRate: !incompleteCache && hits !== null && input > 0 ? hits / input : null,
  };
}
