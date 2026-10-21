// Model capabilities are independent of the host that transports a request.
// This module deliberately never chooses or changes a provider/protocol.
export function isClaudeModel(modelId) {
  return /(?:^|\/)claude-/i.test(String(modelId || ""));
}

export function claudeReasoningProfile(modelId) {
  if (!/(?:^|\/)claude-opus-5[._-]5(?:[._:-]|$)/i.test(String(modelId || ""))) return null;
  return { thinkingAlwaysOn: true, supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" };
}

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function normalizeReasoningEfforts(values) {
  if (!Array.isArray(values)) return [];
  return REASONING_EFFORTS.filter(value => values.includes(value));
}
export function isGptReasoningModel(modelId) {
  return /(?:^|\/)(?:gpt-[5-9](?:[.\-/:]|$)|o[134](?:[-/:]|$))/i.test(String(modelId || ''));
}

// Checked against OpenAI's model pages on 2026-10-21. Only known IDs and dated
// snapshots inherit these profiles; unrecognized/pro variants are not guessed.
export function gptReasoningProfile(modelId) {
  const id = String(modelId || '').toLowerCase().split('/').at(-1).replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const profiles = {
    'gpt-5': ['minimal', 'low', 'medium', 'high'],
    'gpt-5.1': ['none', 'low', 'medium', 'high'],
    'gpt-5.2': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.3-codex': ['low', 'medium', 'high', 'xhigh'],
    'gpt-5.4': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.5': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.6': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-5.6-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-6-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  };
  if (!Object.hasOwn(profiles, id)) return null;
  const supportedEfforts = profiles[id];
  return { supportsThinking: true, thinkingMode: 'openai-reasoning', supportedEfforts: [...supportedEfforts],
    defaultEffort: 'medium', thinkingAlwaysOn: !supportedEfforts.includes('none') };
}

export function effectiveReasoningProfile(model = {}, modelId = model.modelId || model.id) {
  if (model.reasoningCapabilitySource === 'explicit' && model.supportsThinking === false) return null;
  const known = gptReasoningProfile(modelId);
  const personal = model.thinkingMode === 'personal-chatgpt';
  if (!known && !personal && model.thinkingMode !== 'openai-reasoning' && !(model.supportsThinking && isGptReasoningModel(modelId))) return null;
  // Account/server/explicit capabilities take precedence over static profiles.
  const advertised = normalizeReasoningEfforts(model.supportedEfforts);
  const supportedEfforts = advertised.length ? advertised : known?.supportedEfforts || ['low', 'medium', 'high'];
  return { ...known, supportsThinking: model.supportsThinking !== false, thinkingMode: personal ? 'personal-chatgpt' : 'openai-reasoning', supportedEfforts,
    defaultEffort: supportedEfforts.includes(model.defaultEffort) ? model.defaultEffort : supportedEfforts.includes('medium') ? 'medium' : supportedEfforts[0] };
}

export function chatReasoningParameters(model, { thinking = false } = {}) {
  const profile = effectiveReasoningProfile(model, model.id);
  const efforts = profile?.supportedEfforts || normalizeReasoningEfforts(model.supportedEfforts);
  const effort = efforts.length && !efforts.includes('low') ? profile?.defaultEffort || model.defaultEffort || efforts[0] : 'low';
  return modelReasoningParameters({ ...model, supportsThinking: model.supportsThinking ?? Boolean(profile || ['deepseek', 'reasoning-effort', 'personal-chatgpt', 'openai-reasoning'].includes(model.thinkingMode)) }, { modelId: model.id, thinking, effort });
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
  const gpt = effectiveReasoningProfile(provider, modelId);
  if (gpt) {
    const selected = effort ?? gpt.defaultEffort;
    if (!gpt.supportedEfforts.includes(selected)) throw Object.assign(new Error(`PROVIDER_REASONING_EFFORT_INVALID: ${modelId} does not support ${selected}; choose ${gpt.supportedEfforts.join(', ')}.`), { code: 'PROVIDER_REASONING_EFFORT_INVALID', retryable: false });
    return { reasoning_effort: selected };
  }
  if (provider.thinkingMode === "deepseek") return {
    thinking: { type: thinking ? "enabled" : "disabled" },
    ...(thinking ? { reasoning_effort: effort === "max" ? "max" : "high" } : {}),
  };
  if (provider.thinkingMode === "reasoning-effort" && thinking) return {
    reasoning_effort: effort === "low" ? "low" : effort === "max" ? "high" : "medium",
  };
  return {};
}
