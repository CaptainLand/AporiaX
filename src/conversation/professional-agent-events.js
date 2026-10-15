export function applyProfessionalAgentEvent(items = [], event) {
  if (!event.agentId || !event.type.startsWith('subagent.')) return items;
  const index = items.findIndex(item => item.agentId === event.agentId);
  const previous = index < 0 ? { agentId: event.agentId, role: event.role, status: 'running' } : items[index];
  let patch = {};
  if (event.type === 'subagent.profile') patch = { profileId: event.profileId, profileName: event.profileName, task: event.task, phase: event.phase, dependsOn: event.dependsOn, systemOwned: event.systemOwned };
  else if (event.type === 'subagent.configured') patch = { configuration: { provider: event.provider, model: event.model, thinking: event.thinking, effort: event.effort, tools: event.tools }, profileName: event.profileName || previous.profileName };
  else if (event.type === 'subagent.started') patch = { status: 'running', phase: 'model', task: event.task, startedAt: event.timestamp || new Date().toISOString() };
  else if (event.type === 'subagent.budget') patch = { budget: event.budget };
  else if (event.type === 'subagent.phase') patch = { phase: event.phase };
  else if (event.type === 'subagent.profile_result') { const { type, ...result } = event; patch = result; }
  else if (event.type === 'subagent.reviewed') patch = { acceptance: event.acceptance };
  else if (event.type === 'subagent.tool.started') patch = { phase: 'tool', currentTool: event.tool };
  else if (event.type === 'subagent.tool.completed') patch = { phase: 'model', currentTool: null, toolCount: (previous.toolCount || 0) + 1 };
  else if (event.type === 'subagent.cancelled') patch = { status: 'interrupted' };
  else if (event.type === 'subagent.failed') patch = { status: 'failed', summary: event.error };
  else if (event.type === 'subagent.completed') patch = { status: event.status || 'completed', summary: event.summary, acceptance: event.acceptance };
  else return items;
  const next = { ...previous, ...patch };
  return index < 0 ? [...items, next] : items.map((item, i) => i === index ? next : item);
}
