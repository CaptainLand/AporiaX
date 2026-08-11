import {
  closeRunningRouteEntries,
  getRouteToolMeta,
  updateRunAssistant,
} from "../p0-model.js";

export const PURE_TASK_EVENT_TYPES = new Set([
  "skill.activated",
  "skill.unresolved",
  "plan.updated",
  "witness.updated",
  "response.reset",
  "subagent.tool.started",
  "subagent.tool.completed",
  "tool.started",
  "tool.completed",
  "file.changed",
]);

function defaultTranslate(zh, en, values = {}) {
  const source = en || zh;
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    source,
  );
}

function routeId(event, suffix = "tool") {
  const call = String(event?.callId || "").trim();
  if (call) return `${event.runId}-${suffix}-${call}`;
  return `${event.runId}-${suffix}-${String(event?.timestamp || "event")}`;
}

export function reduceHarnessTaskEvent(
  tasks,
  run,
  event,
  {
    language = "zh-CN",
    tr = defaultTranslate,
    now = () => new Date().toISOString(),
  } = {},
) {
  if (!run || !event || !PURE_TASK_EVENT_TYPES.has(event.type)) return tasks;

  if (event.type === "skill.activated") {
    return updateRunAssistant(tasks, run, (message) => ({
      ...message,
      activatedSkills: Array.isArray(event.skills) ? event.skills : [],
      unresolvedSkills: Array.isArray(event.unresolved) ? event.unresolved : [],
    }));
  }

  if (event.type === "skill.unresolved") {
    return updateRunAssistant(tasks, run, (message) => ({
      ...message,
      unresolvedSkills: Array.isArray(event.unresolved) ? event.unresolved : [],
    }));
  }

  if (event.type === "plan.updated") {
    return updateRunAssistant(tasks, run, (message) => ({
      ...message,
      plan: event.plan,
    }));
  }

  if (event.type === "witness.updated") {
    return updateRunAssistant(tasks, run, (message) => ({
      ...message,
      witness: event.witness || message.witness || null,
    }));
  }

  if (event.type === "response.reset") {
    return updateRunAssistant(tasks, run, (message) => ({
      ...message,
      content: "",
    }));
  }

  if (event.type === "subagent.tool.started") {
    const phase = ["review", "verify"].includes(event.role)
      ? "self-check"
      : "work";
    const meta = getRouteToolMeta(
      event.tool,
      phase,
      language,
      event.capability,
    );
    const roleLabel =
      event.role === "review"
        ? tr("审查", "Review")
        : event.role === "verify"
          ? tr("验证", "Verify")
          : tr("探索", "Explore");
    const startedAt = now();
    return updateRunAssistant(tasks, run, (message) => ({
      ...message,
      route: [
        ...(message.route || []),
        {
          id: routeId(event, "subagent-tool"),
          callId: `${event.agentId}:${event.callId || ""}`,
          agentId: event.agentId,
          stage: meta.stage,
          title: `${roleLabel} · ${meta.title}`,
          tool: event.tool,
          capability: event.capability || null,
          path: event.path || "",
          command: event.command || "",
          detail: event.detail || "",
          status: "running",
          parallel: Boolean(event.parallel),
          startedAt,
        },
      ],
    }));
  }

  if (event.type === "subagent.tool.completed") {
    const finishedAt = now();
    const callId = `${event.agentId}:${event.callId || ""}`;
    return updateRunAssistant(tasks, run, (message) => {
      const route = [...(message.route || [])];
      const routeIndex = route.findLastIndex(
        (entry) =>
          entry.agentId === event.agentId &&
          (event.callId ? entry.callId === callId : entry.tool === event.tool) &&
          entry.status === "running",
      );
      if (routeIndex < 0) return message;
      route[routeIndex] = {
        ...route[routeIndex],
        capability: event.capability || route[routeIndex].capability || null,
        status: event.success ? "completed" : "failed",
        detail: event.detail || route[routeIndex].detail,
        path: event.path || route[routeIndex].path,
        command: event.command || route[routeIndex].command,
        exitCode: event.exitCode,
        completedAt: finishedAt,
      };
      return { ...message, route };
    });
  }

  if (event.type === "tool.started") {
    const meta = getRouteToolMeta(
      event.tool,
      event.phase,
      language,
      event.capability,
    );
    const startedAt = now();
    return updateRunAssistant(tasks, run, (message) => {
      const previousRoute = event.parallel
        ? [...(message.route || [])]
        : (message.route || []).map((entry) =>
            entry.tool === "complete_self_check" && entry.status === "running"
              ? entry
              : closeRunningRouteEntries([entry], startedAt)[0],
          );
      return {
        ...message,
        route: [
          ...previousRoute,
          {
            id: routeId(event),
            callId: event.callId || null,
            stage: meta.stage,
            title: meta.title,
            tool: event.tool,
            capability: event.capability || null,
            phase: event.phase,
            path: event.path || "",
            command: event.command || "",
            detail: event.detail || "",
            planStepId: event.planStepId || null,
            status: "running",
            parallel: Boolean(event.parallel),
            startedAt,
          },
        ],
      };
    });
  }

  if (event.type === "tool.completed") {
    const finishedAt = now();
    return updateRunAssistant(tasks, run, (message) => {
      const route = [...(message.route || [])];
      const routeIndex = route.findLastIndex(
        (entry) =>
          (event.callId ? entry.callId === event.callId : entry.tool === event.tool) &&
          ["running", "waiting"].includes(entry.status),
      );
      if (routeIndex >= 0) {
        route[routeIndex] = {
          ...route[routeIndex],
          capability: event.capability || route[routeIndex].capability || null,
          status: event.skipped
            ? "skipped"
            : event.retry
              ? "retry"
              : event.success
                ? "completed"
                : "failed",
          detail: event.detail || route[routeIndex].detail,
          finishedAt,
        };
      }
      if (event.success && !event.skipped && routeIndex >= 0) {
        for (let index = 0; index < routeIndex; index += 1) {
          if (
            route[index].tool === event.tool &&
            ["failed", "retry"].includes(route[index].status)
          ) {
            route[index] = {
              ...route[index],
              status: "recovered",
              detail:
                route[index].detail ||
                tr("后续重试已成功", "A later retry succeeded"),
            };
          }
        }
      }
      return { ...message, route };
    });
  }

  if (event.type === "file.changed") {
    return updateRunAssistant(tasks, run, (message) => {
      const route = [...(message.route || [])];
      const routeIndex = route.findLastIndex(
        (entry) =>
          entry.stage === "forge" &&
          ["running", "waiting"].includes(entry.status),
      );
      if (routeIndex >= 0) {
        route[routeIndex] = {
          ...route[routeIndex],
          path: event.path,
          additions: event.additions || 0,
          deletions: event.deletions || 0,
          artifact: event.artifact || null,
        };
      }
      return { ...message, route };
    });
  }

  return tasks;
}
