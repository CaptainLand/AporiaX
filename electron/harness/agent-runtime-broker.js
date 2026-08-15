const ROLE_PRIORITIES = Object.freeze({
  main: 100,
  verify: 70,
  review: 60,
  curator: 40,
  explore: 30,
  builder: 20,
});

let defaultBroker = null;

function terminalState(result) {
  const status = String(result?.status || "completed");
  if (["interrupted", "cancelled"].includes(status)) return "cancelled";
  if (status === "failed") return "failed";
  return "completed";
}

function compactResult(result) {
  if (!result || typeof result !== "object") return result ?? null;
  return {
    status: result.status || "completed",
    summary: String(result.summary || result.content || "").slice(0, 2_000),
    rounds: Number(result.rounds) || undefined,
    changedFiles: Array.isArray(result.changes) ? result.changes.length : undefined,
  };
}

export function createKernelAgentRuntimeBroker({ kernel } = {}) {
  if (!kernel?.agents || !kernel?.scheduler || !kernel?.sessions) {
    throw new Error("Kernel Agent Runtime Broker requires agents, scheduler, and sessions.");
  }

  return Object.freeze({
    kernel,
    async run({
      agentId,
      role,
      task = "",
      background = false,
      systemOwned = false,
      parentRunId = "",
      taskId = "",
      emit = null,
      execute,
    } = {}) {
      if (typeof execute !== "function") {
        throw new TypeError("Kernel Agent Runtime Broker requires an execute function.");
      }
      const safeAgentId = String(agentId || "").trim();
      const safeRole = String(role || "").trim();
      if (!safeAgentId || !safeRole) {
        throw new Error("Agent id and role are required for kernel routing.");
      }
      const definition = kernel.agents.resolve(safeRole);
      if (!definition) {
        throw new Error(`Agent role is not registered in Harness Kernel: ${safeRole}`);
      }
      if (kernel.sessions.get(safeAgentId)) {
        throw new Error(`Agent session already exists: ${safeAgentId}`);
      }

      const safeEmit = (event) => {
        if (typeof emit !== "function") return;
        try {
          emit({
            agentId: safeAgentId,
            role: safeRole,
            parentRunId: parentRunId || undefined,
            ...event,
          });
        } catch {
          // Journal/renderer observers must not break scheduling.
        }
      };

      kernel.sessions.create({
        id: safeAgentId,
        role: safeRole,
        task: String(task || "").slice(0, 4_000),
        taskId: String(taskId || ""),
        parentRunId: String(parentRunId || ""),
        background: Boolean(background),
        systemOwned: Boolean(systemOwned),
        definitionSource: definition.source,
      });
      kernel.sessions.transition(safeAgentId, "queued");
      safeEmit({
        type: "agent.runtime.queued",
        background: Boolean(background),
        definitionSource: definition.source,
      });

      const scheduled = kernel.scheduler.enqueue({
        id: `agent:${safeAgentId}`,
        kind: `agent:${safeRole}`,
        priority: ROLE_PRIORITIES[safeRole] || 10,
        metadata: {
          agentId: safeAgentId,
          role: safeRole,
          taskId: String(taskId || ""),
          parentRunId: String(parentRunId || ""),
          background: Boolean(background),
        },
        run: async () => {
          kernel.sessions.transition(safeAgentId, "running");
          safeEmit({ type: "agent.runtime.started" });
          try {
            const result = await execute({ definition });
            const state = terminalState(result);
            kernel.sessions.transition(safeAgentId, state, {
              result: compactResult(result),
            });
            safeEmit({
              type: `agent.runtime.${state}`,
              resultStatus: result?.status || state,
            });
            return result;
          } catch (error) {
            const state =
              error?.name === "AbortError" ? "cancelled" : "failed";
            kernel.sessions.transition(safeAgentId, state, {
              error: String(error?.message || error).slice(0, 2_000),
            });
            safeEmit({
              type: `agent.runtime.${state}`,
              error: String(error?.message || error).slice(0, 2_000),
            });
            throw error;
          }
        },
      });
      return scheduled.promise;
    },
  });
}

export function setDefaultAgentRuntimeBroker(broker) {
  defaultBroker = broker || null;
  return defaultBroker;
}

export function getDefaultAgentRuntimeBroker() {
  return defaultBroker;
}

export function clearDefaultAgentRuntimeBroker() {
  defaultBroker = null;
}
