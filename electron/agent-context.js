export * from "./agent-context-core.js";

import {
  mergeTokenUsage as mergeTokenUsageCore,
  retrieveRelevantContext,
} from "./agent-context-core.js";

const RELEVANT_CONTEXT_PREFIX = "AporiaX relevant durable context:";
const relevantContextState = new WeakMap();

function normalizeUsageNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function cacheHitTokensFromUsage(usage) {
  return normalizeUsageNumber(
    usage?.prompt_cache_hit_tokens ??
      usage?.promptCacheHitTokens ??
      usage?.cache_read_input_tokens ??
      usage?.cacheReadInputTokens,
  );
}

function cacheMissTokensFromUsage(usage) {
  return normalizeUsageNumber(
    usage?.prompt_cache_miss_tokens ??
      usage?.promptCacheMissTokens ??
      usage?.cache_creation_input_tokens ??
      usage?.cacheCreationInputTokens,
  );
}

function hasPromptCacheUsage(usage) {
  return Boolean(
    usage &&
      ("prompt_cache_hit_tokens" in usage ||
        "promptCacheHitTokens" in usage ||
        "cache_read_input_tokens" in usage ||
        "cacheReadInputTokens" in usage ||
        "prompt_cache_miss_tokens" in usage ||
        "promptCacheMissTokens" in usage ||
        "cache_creation_input_tokens" in usage ||
        "cacheCreationInputTokens" in usage),
  );
}

export function mergeTokenUsage(current, incoming) {
  const merged = mergeTokenUsageCore(current, incoming);
  if (!merged || !(hasPromptCacheUsage(current) || hasPromptCacheUsage(incoming))) {
    return merged;
  }
  return {
    ...merged,
    prompt_cache_hit_tokens:
      cacheHitTokensFromUsage(current) + cacheHitTokensFromUsage(incoming),
    prompt_cache_miss_tokens:
      cacheMissTokensFromUsage(current) + cacheMissTokensFromUsage(incoming),
  };
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((item) => item?.type === "text")
    .map((item) => item.text || "")
    .join("\n");
}

function leadingSystemCount(conversation) {
  let count = 0;
  while (conversation[count]?.role === "system") count += 1;
  return count;
}

function isRelevantContextMessage(message) {
  return (
    message?.role === "system" &&
    String(message?.content || "").startsWith(RELEVANT_CONTEXT_PREFIX)
  );
}

function parseRelevantContextMessage(message) {
  const content = String(message?.content || "");
  if (!isRelevantContextMessage(message)) return [];
  try {
    const parsed = JSON.parse(content.slice(RELEVANT_CONTEXT_PREFIX.length).trim());
    return Array.isArray(parsed)
      ? parsed.map(({ kind, value }) => ({ kind, value }))
      : [];
  } catch {
    return [];
  }
}

function removeRelevantContextMessages(conversation) {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if (isRelevantContextMessage(conversation[index])) {
      conversation.splice(index, 1);
    }
  }
}

export function upsertRelevantContextMessage(
  conversation,
  { checkpoints = [], memoryFacts = [], plan = null, refresh = false } = {},
) {
  const checkpointCount = Array.isArray(checkpoints) ? checkpoints.length : 0;
  const existingIndex = conversation.findIndex(isRelevantContextMessage);
  const state = relevantContextState.get(conversation);
  const checkpointChanged = Boolean(
    state && state.checkpointCount !== checkpointCount,
  );

  // DeepSeek KV cache reuse is prefix-sensitive. Keep the injected durable
  // context byte-for-byte stable during ordinary model rounds. Rebuild only
  // when explicitly requested or after a compaction checkpoint changed.
  if (!refresh && !checkpointChanged) {
    if (state) return state.items;
    if (existingIndex >= 0) {
      const items = parseRelevantContextMessage(conversation[existingIndex]);
      relevantContextState.set(conversation, {
        checkpointCount,
        items,
      });
      return items;
    }
  }

  if (existingIndex >= 0) {
    removeRelevantContextMessages(conversation);
  }

  const query = [
    ...conversation.slice(-8).map(messageText),
    ...(plan?.steps || []).map((step) => `${step.title} ${step.detail || ""}`),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(-24_000);
  const relevant = retrieveRelevantContext({
    query,
    checkpoints,
    memoryFacts,
  }).map(({ kind, value }) => ({ kind, value }));

  if (relevant.length) {
    const insertAt = leadingSystemCount(conversation);
    conversation.splice(insertAt, 0, {
      role: "system",
      content: `${RELEVANT_CONTEXT_PREFIX}\n${JSON.stringify(relevant)}`,
    });
  }
  relevantContextState.set(conversation, {
    checkpointCount,
    items: relevant,
  });
  return relevant;
}
