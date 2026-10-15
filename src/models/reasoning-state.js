// Keep the menu, compact label and outgoing request on the same model capabilities.
export function reasoningState(model, task = {}) {
  const supportsThinking = Boolean(model?.supportsThinking);
  const efforts = model?.supportedEfforts?.length ? model.supportedEfforts : ['high', 'max'];
  const defaultEffort = efforts.includes(model?.defaultEffort) ? model.defaultEffort : efforts.includes('high') ? 'high' : efforts[0];
  return {
    thinking: supportsThinking && Boolean(model.thinkingAlwaysOn || task.thinking),
    effort: efforts.includes(task.effort) ? task.effort : defaultEffort,
    defaultEffort,
    efforts,
  };
}

export function modelSelectionPatch(model, task) {
  const changed = model.id !== task.modelId || model.providerId !== task.providerId;
  const state = reasoningState(model, { ...task, ...(changed ? { effort: undefined } : {}) });
  return { providerId: model.providerId, modelId: model.id, thinking: state.thinking, effort: state.effort };
}
