export * from "./agent-context-core.js";

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
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

function isRelevantContextMessage(message) {
  return (
    message?.role === "system" &&
    String(message?.content || "").startsWith(RELEVANT_CONTEXT_PREFIX)
  );
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
  // Old saved runs may contain project recall copied into a checkpoint. Keep
  // task evidence and decisions, but reload optional knowledge from its store.
  const checkpointPrefix = "AporiaX durable context checkpoint:\n";
  for (const message of conversation) {
    if (message?.role !== "system" || typeof message.content !== "string" || !message.content.startsWith(checkpointPrefix)) continue;
    try {
      const checkpoint = JSON.parse(message.content.slice(checkpointPrefix.length));
      if (checkpoint.relevantMemory?.length) {
        checkpoint.relevantMemory = [];
        message.content = checkpointPrefix + JSON.stringify(checkpoint);
      }
    } catch { /* Preserve malformed legacy evidence; recovery reports its integrity separately. */ }
  }
  const state = relevantContextState.get(conversation);
  const history = conversation.filter((message) => message?.role !== "system" && !isRelevantContextMessage(message));
  const query = [
    ...history.slice(-8).map((message) => messageText(message).slice(-2400)),
    ...(plan?.steps || []).filter((step) => step.status === "in_progress").map((step) => `${step.title} ${step.detail || ""}`),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(-24_000);
  const key = createHash("sha256").update(JSON.stringify({ query, checkpoints, memoryFacts })).digest("hex");
  const relevant = !refresh && state?.key === key ? state.items : retrieveRelevantContext({
    query,
    checkpoints,
    memoryFacts,
  }).map(({ kind, value }) => ({ kind, value }));
  // Dynamic retrieval belongs near the tail, never before the stable system
  // prefix. Remove obsolete context, including the old prefix-style injection.
  const existing = conversation.find(isRelevantContextMessage);
  if (existing && existing.aporiaSource === "retrieval" &&
      existing.content === `${RELEVANT_CONTEXT_PREFIX}\n${JSON.stringify(relevant)}`) {
    relevantContextState.set(conversation, { key, items: relevant });
    return relevant;
  }
  removeRelevantContextMessages(conversation);
  if (relevant.length) {
    conversation.push({
      role: "system",
      aporiaSource: "retrieval",
      content: `${RELEVANT_CONTEXT_PREFIX}\n${JSON.stringify(relevant)}`,
    });
  }
  relevantContextState.set(conversation, { key, items: relevant });
  return relevant;
}
