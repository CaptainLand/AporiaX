import {
  compactConversationForRequest,
  createTokenAccounting,
  estimateConversationTokens,
  mergeTokenUsage,
  recordProviderUsage,
  upsertRelevantContextMessage,
} from "../agent-context.js";

export class HarnessContextController {
  #contextWindowTokens;
  #accounting;
  #checkpoints = [];
  #usage = null;
  #eventBus;

  constructor({ contextWindowTokens = 128_000, eventBus = null } = {}) {
    this.#contextWindowTokens = Math.max(32_000, Number(contextWindowTokens) || 128_000);
    this.#accounting = createTokenAccounting();
    this.#eventBus = eventBus;
  }

  get checkpoints() {
    return [...this.#checkpoints];
  }

  ensureRelevant(conversation, { memoryFacts = [], plan = null, refresh = false } = {}) {
    return upsertRelevantContextMessage(conversation, {
      checkpoints: this.#checkpoints,
      memoryFacts,
      plan,
      refresh,
    });
  }

  compact(conversation, { plan = null, relevantMemory = [] } = {}) {
    return compactConversationForRequest({
      conversation,
      onEvent: (event) => this.#eventBus?.emit(event),
      contextCheckpoints: this.#checkpoints,
      contextWindowTokens: this.#contextWindowTokens,
      accounting: this.#accounting,
      plan,
      relevantMemory,
    });
  }

  recordUsage(usage, conversation) {
    recordProviderUsage(this.#accounting, usage, conversation);
    this.#usage = mergeTokenUsage(this.#usage, usage);
    this.#eventBus?.emit({
      type: "context.usage.recorded",
      usage,
      totalUsage: this.#usage,
      estimatedPromptTokens: estimateConversationTokens(conversation, this.#accounting),
      contextWindowTokens: this.#contextWindowTokens,
    });
    return this.#usage;
  }

  estimate(conversation) {
    return estimateConversationTokens(conversation, this.#accounting);
  }

  snapshot(conversation = []) {
    return {
      contextWindowTokens: this.#contextWindowTokens,
      checkpoints: this.#checkpoints.length,
      estimatedPromptTokens: this.estimate(conversation),
      usage: this.#usage,
      accounting: { ...this.#accounting },
    };
  }
}

export function createHarnessContextController(options) {
  return new HarnessContextController(options);
}
