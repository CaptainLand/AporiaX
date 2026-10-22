// Plan completion is the assistant's work status, not a verification receipt.
// Explicitly blocked steps and unfinished outcomes are never promoted to done.
export function finishExecutionPlan(plan, status, now = new Date().toISOString()) {
  if (!Array.isArray(plan?.steps) || !plan.steps.length) return plan;
  return { ...plan, revision: (plan.revision || 0) + 1, status, finishedAt: now, updatedAt: now,
    steps: plan.steps.map(step => {
      if (status === 'completed' && ['pending', 'in_progress'].includes(step.status)) {
        return { ...step, status: 'completed', completionSource: 'assistant-final' };
      }
      if (status !== 'completed' && step.status === 'in_progress') {
        return { ...step, status: ['blocked', 'needs_input'].includes(status) ? 'blocked' : 'pending' };
      }
      return step;
    }),
  };
}
