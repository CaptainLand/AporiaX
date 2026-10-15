// Model capabilities are independent of the host that transports a request.
// This module deliberately never chooses or changes a provider/protocol.
export function isClaudeModel(modelId) {
  return /(?:^|\/)claude-/i.test(String(modelId || ""));
}

export function claudeReasoningProfile(modelId) {
  if (!/(?:^|\/)claude-opus-5[._-]5(?:[._:-]|$)/i.test(String(modelId || ""))) return null;
  return { thinkingAlwaysOn: true, supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" };
}

export function modelReasoningParameters(provider, { modelId = provider.modelId, thinking = false, effort } = {}) {
  const profile = claudeReasoningProfile(modelId);
  if (profile) {
    const selected = effort ?? profile.defaultEffort;
    if (!profile.supportedEfforts.includes(selected)) {
      throw Object.assign(new Error(`Unsupported Claude reasoning effort: ${selected}`), { code: "PROVIDER_REASONING_EFFORT_INVALID", retryable: false });
    }
    return { reasoning_effort: selected };
  }
  if (!provider.supportsThinking) return {};
  if (provider.thinkingMode === "deepseek") return {
    thinking: { type: thinking ? "enabled" : "disabled" },
    ...(thinking ? { reasoning_effort: effort === "max" ? "max" : "high" } : {}),
  };
  if (provider.thinkingMode === "reasoning-effort" && thinking) return {
    reasoning_effort: effort === "low" ? "low" : effort === "max" ? "high" : "medium",
  };
  return {};
}
