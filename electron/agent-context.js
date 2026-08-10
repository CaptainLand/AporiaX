export * from "./agent-context-core.js";

import { AsyncLocalStorage } from "node:async_hooks";
import {
  loadProjectInstructionContext as loadProjectInstructionContextCore,
  mergeTokenUsage as mergeTokenUsageCore,
  retrieveRelevantContext,
} from "./agent-context-core.js";
import { collaborationContextText } from "./harness/collaboration.js";

const RELEVANT_CONTEXT_PREFIX = "AporiaX relevant durable context:";
const relevantContextState = new WeakMap();
const collaborationContextStorage = new AsyncLocalStorage();

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

export function runWithCollaborationContext(context, callback) {
  if (typeof callback !== "function") {
    throw new TypeError("Collaboration context requires a callback.");
  }
  if (!context?.contract) return callback();
  return collaborationContextStorage.run(Object.freeze({ ...context }), callback);
}

export function currentCollaborationContext() {
  return collaborationContextStorage.getStore() || null;
}

export async function loadProjectInstructionContext(...args) {
  const base = await loadProjectInstructionContextCore(...args);
  const collaboration = currentCollaborationContext();
  const sharedText = collaborationContextText(collaboration || {});
  if (!sharedText) return base;
  const root = base?.root || { file: null, content: "" };
  return {
    ...base,
    root: {
      ...root,
      content: [root.content, sharedText].filter(Boolean).join("\n\n"),
    },
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
  const existingIndex = conversation.findIndex(isRelevantContextMessage);
  const state = relevantContextState.get(conversation);

  // DeepSeek KV cache reuse is prefix-sensitive. Freeze this injected prefix
  // for the lifetime of the conversation. Compaction already writes its own
  // checkpoint into history, so refreshing this earlier system message after
  // compaction would cause a second, avoidable cache-prefix reset.
  if (!refresh) {
    if (state) return state.items;
    if (existingIndex >= 0) {
      const items = parseRelevantContextMessage(conversation[existingIndex]);
      relevantContextState.set(conversation, { items });
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
  relevantContextState.set(conversation, { items: relevant });
  return relevant;
}
