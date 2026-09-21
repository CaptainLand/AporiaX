const ROLES = ['main', 'explore', 'review', 'verify', 'curator', 'builder'];
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Lifetime counters are independent of Witness's bounded record window.
// A continuation is another activation; model rounds/heartbeats are not.
export function createAgentActivityTracker(saved = null) {
  const roles = Object.fromEntries(ROLES.map((role) => [role, { activations: count(saved?.roles?.[role]?.activations) ?? 0, active: 0, peak: count(saved?.roles?.[role]?.peak) ?? 0 }]));
  const workers = new Map(), seen = new Set();
  let mainStarted = false, terminal = false;
  const builder = { limit: count(saved?.builder?.limit), running: 0, queued: 0, peak: count(saved?.builder?.peak) ?? 0 };
  const recompute = () => {
    for (const role of ROLES.slice(1)) {
      roles[role].active = terminal ? 0 : [...workers.values()].filter((worker) => worker.role === role && worker.active).length;
      roles[role].peak = Math.max(roles[role].peak, roles[role].active);
    }
  };
  return {
    observe(event) {
      if (event.type === 'turn.started') {
        if (!mainStarted) roles.main.activations++;
        mainStarted = true; terminal = false; roles.main.active = 1; roles.main.peak = 1;
        builder.limit = count(event.agentBudget?.builderConcurrency) ?? count(event.agentBudget?.limits?.roles?.builder);
      } else if (['agent_budget.queue', 'agent_budget.planned', 'agent_budget.escalated'].includes(event.type)) {
        builder.limit = count(event.builderConcurrency) ?? count(event.limits?.roles?.builder) ?? builder.limit;
        if (!terminal && event.type === 'agent_budget.queue') {
          builder.running = count(event.runningBuilders) ?? builder.running;
          builder.queued = count(event.queuedBuilders) ?? builder.queued;
          builder.peak = Math.max(builder.peak, builder.running);
        }
      } else if (event.type === 'subagent.started' && event.agentId && ROLES.includes(event.role)) {
        if (terminal) return;
        const previous = workers.get(event.agentId);
        const activation = event.activationId || `${event.agentId}:${event.timestamp || (previous?.active ? 'active' : roles[event.role].activations + 1)}`;
        if (seen.has(activation)) return;
        seen.add(activation);
        roles[event.role].activations++;
        workers.set(event.agentId, { role: event.role, activation, active: !terminal });
        recompute();
        builder.running = Math.max(builder.running, roles.builder.active);
        builder.peak = Math.max(builder.peak, builder.running);
      } else if (['subagent.completed', 'subagent.failed', 'subagent.cancelled'].includes(event.type)) {
        const worker = workers.get(event.agentId);
        if (worker && (!event.activationId || event.activationId === worker.activation)) worker.active = false;
        recompute();
        // Queue telemetry is authoritative for the brief integration/admission
        // interval; completion also works without the optional budget wrapper.
        if (worker?.role === 'builder') builder.running = roles.builder.active;
      } else if (['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.type)) {
        terminal = true; roles.main.active = 0; recompute(); builder.running = 0; builder.queued = 0;
      }
    },
    snapshot() { return { version: 1, roles: Object.fromEntries(ROLES.map((role) => [role, { ...roles[role] }])), builder: { ...builder } }; },
  };
}
