const finishedStates = new Set(['completed', 'partial', 'blocked', 'needs_input', 'failed', 'interrupted']);

// A delivered reply is not proof that the task completed. Only explicit outcome
// states and completed plan steps contribute; tool counts never predict progress.
export function getLiveRunProgress(message) {
  const witness = message?.witness;
  const status = message?.error ? 'failed'
    : finishedStates.has(message?.status) ? message.status
    : witness?.status || message?.status || 'starting';
  const plan = message?.plan?.steps?.length ? message.plan : witness?.plan;
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const entries = Array.isArray(message?.route) ? message.route : [];
  const completedCount = steps.filter(step => step.status === 'completed').length;
  const currentStep = steps.find(step => step.status === 'in_progress')
    || steps.find(step => step.status === 'pending') || steps.at(-1);
  const finished = finishedStates.has(status);
  const active = ['starting', 'running'].includes(status);
  const completed = status === 'completed';
  return {
    status, finished, active, completed,
    plan: steps.length ? plan : null,
    completedCount, totalCount: steps.length,
    blockedCount: steps.filter(step => step.status === 'blocked').length,
    currentEntry: currentStep || [...entries].reverse()
      .find(entry => ['running', 'waiting', 'retry'].includes(entry.status)) || entries.at(-1) || null,
    // When all planned steps are done but the outcome is still pending, show
    // activity rather than a full task-completion bar. No invented 96% ceiling.
    progress: completed ? 100 : steps.length && completedCount < steps.length
      ? completedCount / steps.length * 100 : null,
  };
}
