const DEFAULT_HEARTBEAT_MS = 15_000;
const LONG_RUNNING_MS = 45_000;
const STALLED_MS = 120_000;
const MAX_RECORDS = 500;
const MAX_ALERTS = 8;

function clipped(value, max = 600) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function eventTime(event, now) {
  const parsed = Date.parse(event?.timestamp || "");
  return Number.isFinite(parsed) ? parsed : now();
}

function isoTime(value) {
  return new Date(value).toISOString();
}

function recordDetail(event) {
  return clipped(
    event?.path ||
      event?.command ||
      event?.detail ||
      event?.task ||
      event?.summary ||
      event?.error ||
      "",
  );
}

function publicRecord(record, currentTime) {
  return {
    id: record.id,
    kind: record.kind,
    eventType: record.eventType,
    actor: record.actor,
    role: record.role || null,
    agentId: record.agentId || null,
    callId: record.callId || null,
    tool: record.tool || null,
    phase: record.phase || null,
    capability: record.capability || null,
    status: record.status,
    detail: record.detail || "",
    path: record.path || "",
    command: record.command || "",
    parallel: Boolean(record.parallel),
    startedAt: record.startedAt,
    completedAt: record.completedAt || null,
    elapsedMs: Math.max(
      0,
      (record.completedAt
        ? Date.parse(record.completedAt)
        : currentTime) - Date.parse(record.startedAt),
    ),
    longRunning: Boolean(record.longRunning),
  };
}

export function createWitnessMonitor({
  emit,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const startedAtMs = now();
  const records = [];
  const recordIndex = new Map();
  const agents = new Map();
  const alerts = [];
  const failureStreaks = new Map();
  let revision = 0;
  let recordCounter = 0;
  let status = "starting";
  let phase = "preparing";
  let lastMeaningfulAt = startedAtMs;
  let disposed = false;
  let plan = null;

  const trimRecords = () => {
    while (records.length > MAX_RECORDS) {
      const removableIndex = records.findIndex(
        (record) => record.status !== "running" && record.status !== "waiting",
      );
      const index = removableIndex >= 0 ? removableIndex : 0;
      const [removed] = records.splice(index, 1);
      if (recordIndex.get(removed.key) === removed) {
        recordIndex.delete(removed.key);
      }
    }
  };

  const addRecord = ({ key, timestamp, ...input }) => {
    recordCounter += 1;
    const record = {
      id: `witness-${recordCounter}`,
      key,
      kind: input.kind || "status",
      eventType: input.eventType || "status",
      actor: input.actor || "main",
      role: input.role || null,
      agentId: input.agentId || null,
      callId: input.callId || null,
      tool: input.tool || null,
      phase: input.phase || null,
      capability: input.capability || null,
      status: input.status || "completed",
      detail: clipped(input.detail),
      path: clipped(input.path, 320),
      command: clipped(input.command, 700),
      parallel: Boolean(input.parallel),
      startedAt: isoTime(timestamp),
      completedAt:
        input.status === "running" || input.status === "waiting"
          ? null
          : isoTime(timestamp),
      longRunning: false,
    };
    records.push(record);
    if (key) recordIndex.set(key, record);
    trimRecords();
    return record;
  };

  const finishRecord = (key, event, success = true) => {
    const timestamp = eventTime(event, now);
    const record = recordIndex.get(key);
    if (!record) return null;
    record.eventType = event?.type || record.eventType;
    record.status = event?.skipped
      ? "skipped"
      : success
        ? "completed"
        : "failed";
    record.completedAt = isoTime(timestamp);
    record.detail = recordDetail(event) || record.detail;
    record.path = clipped(event?.path, 320) || record.path;
    record.command = clipped(event?.command, 700) || record.command;
    record.phase = event?.phase || record.phase || null;
    record.capability = event?.capability || record.capability || null;
    return record;
  };

  const closeThinkingRecords = (timestamp) => {
    for (const record of records) {
      if (record.kind !== "thinking" || record.status !== "running") continue;
      record.status = "completed";
      record.completedAt = isoTime(timestamp);
    }
  };

  const closeAllRunning = (timestamp, nextStatus) => {
    for (const record of records) {
      if (!["running", "waiting"].includes(record.status)) continue;
      record.status = nextStatus;
      record.completedAt = isoTime(timestamp);
    }
  };

  const addAlert = ({ code, severity = "notice", detail, timestamp }) => {
    if (alerts.some((alert) => alert.code === code)) return;
    alerts.push({
      code,
      severity,
      detail: clipped(detail),
      createdAt: isoTime(timestamp),
    });
    if (alerts.length > MAX_ALERTS) alerts.splice(0, alerts.length - MAX_ALERTS);
    addRecord({
      key: `alert:${code}`,
      timestamp,
      kind: "warning",
      eventType: code,
      actor: "witness",
      status: severity === "warning" ? "failed" : "completed",
      detail,
    });
  };

  const snapshot = () => {
    const currentTime = now();
    const publicRecords = records.map((record) =>
      publicRecord(record, currentTime),
    );
    const runningRecords = publicRecords.filter((record) =>
      ["running", "waiting"].includes(record.status),
    );
    const current = runningRecords.at(-1) || publicRecords.at(-1) || null;
    const completedActions = publicRecords.filter(
      (record) =>
        record.kind === "tool" &&
        ["completed", "skipped"].includes(record.status),
    ).length;
    const failedActions = publicRecords.filter(
      (record) => record.kind === "tool" && record.status === "failed",
    ).length;
    return {
      version: 1,
      revision,
      status,
      phase,
      startedAt: isoTime(startedAtMs),
      updatedAt: isoTime(currentTime),
      elapsedMs: Math.max(0, currentTime - startedAtMs),
      lastMeaningfulAt: isoTime(lastMeaningfulAt),
      current,
      records: publicRecords,
      agents: [...agents.values()].map((agent) => ({ ...agent })),
      alerts: alerts.map((alert) => ({ ...alert })),
      plan,
      counters: {
        completedActions,
        failedActions,
        runningActions: runningRecords.filter(
          (record) => record.kind === "tool",
        ).length,
        activeAgents: [...agents.values()].filter(
          (agent) => agent.status === "running",
        ).length,
        totalAgents: agents.size,
      },
    };
  };

  const publish = (reason) => {
    if (disposed) return;
    revision += 1;
    emit?.({
      type: "witness.updated",
      reason,
      witness: snapshot(),
    });
  };

  const observe = (event) => {
    if (disposed || !event || event.type === "witness.updated") return;
    const timestamp = eventTime(event, now);
    let meaningful = true;

    switch (event.type) {
      case "turn.started":
        status = "running";
        phase = "preparing";
        addRecord({
          key: "turn:started",
          timestamp,
          kind: "status",
          eventType: "turn.started",
          status: "completed",
        });
        break;
      case "response.reset":
        if (status === "waiting") status = "running";
        phase = event.phase === "self-check" ? "self-check" : "work";
        closeThinkingRecords(timestamp);
        addRecord({
          key: `thinking:${event.round || recordCounter + 1}`,
          timestamp,
          kind: "thinking",
          eventType: "response.reset",
          status: "running",
          detail: event.phase || "work",
        });
        break;
      case "plan.updated":
        plan = event.plan || null;
        addRecord({
          key: `plan:${event.plan?.revision || recordCounter + 1}`,
          timestamp,
          kind: "checkpoint",
          eventType: "plan.updated",
          status: "completed",
          detail:
            event.plan?.steps?.find((step) => step.status === "in_progress")
              ?.title || "",
        });
        break;
      case "parallel_batch.started":
        addRecord({
          key: `parallel:${timestamp}`,
          timestamp,
          kind: "checkpoint",
          eventType: "parallel_batch.started",
          status: "completed",
          detail: `${event.count || 0}`,
          parallel: true,
        });
        break;
      case "tool.started": {
        status = "running";
        for (const record of records) {
          if (
            record.eventType === "approval.required" &&
            record.status === "waiting"
          ) {
            record.status = "completed";
            record.completedAt = isoTime(timestamp);
          }
        }
        closeThinkingRecords(timestamp);
        const key = `tool:main:${event.callId || timestamp}`;
        addRecord({
          key,
          timestamp,
          kind: "tool",
          eventType: "tool.started",
          actor: "main",
          callId: event.callId || null,
          tool: event.tool,
          phase: event.phase || null,
          capability: event.capability || null,
          status: "running",
          detail: recordDetail(event),
          path: event.path,
          command: event.command,
          parallel: event.parallel,
        });
        break;
      }
      case "tool.completed": {
        const key = `tool:main:${event.callId || ""}`;
        const success = Boolean(event.success || event.skipped);
        finishRecord(key, event, success);
        const streak = success
          ? 0
          : (failureStreaks.get(event.tool) || 0) + 1;
        failureStreaks.set(event.tool, streak);
        if (streak >= 3) {
          addAlert({
            code: `repeated-failure:${event.tool}`,
            severity: "warning",
            detail: `${event.tool || "tool"} failed ${streak} consecutive times.`,
            timestamp,
          });
        }
        break;
      }
      case "witness.command.slow":
        addAlert({
          code: `slow-command:${clipped(event.command, 80)}`,
          severity: "notice",
          detail:
            event.advice ||
            `Command has been running for ${Math.round((event.elapsedMs || 0) / 1000)} seconds.`,
          timestamp,
        });
        break;
      case "witness.command.intervention":
        addAlert({
          code: `command-intervention:${clipped(event.command, 80)}`,
          severity: "warning",
          detail:
            event.advice ||
            "Witness stopped a command that exceeded the execution boundary.",
          timestamp,
        });
        break;
      case "subagent.started": {
        const agent = {
          agentId: event.agentId,
          role: event.role || "explore",
          task: clipped(event.task, 500),
          background: Boolean(event.background),
          status: "running",
          startedAt: isoTime(timestamp),
          completedAt: null,
        };
        agents.set(event.agentId, agent);
        addRecord({
          key: `agent:${event.agentId}`,
          timestamp,
          kind: "agent",
          eventType: "subagent.started",
          actor: "subagent",
          role: event.role,
          agentId: event.agentId,
          status: "running",
          detail: event.task,
        });
        break;
      }
      case "subagent.tool.started":
        addRecord({
          key: `tool:${event.agentId}:${event.callId || timestamp}`,
          timestamp,
          kind: "tool",
          eventType: "subagent.tool.started",
          actor: "subagent",
          role: event.role,
          agentId: event.agentId,
          callId: event.callId || null,
          tool: event.tool,
          phase: event.phase || null,
          capability: event.capability || null,
          status: "running",
          detail: recordDetail(event),
          path: event.path,
          command: event.command,
          parallel: event.parallel,
        });
        break;
      case "subagent.tool.completed":
        finishRecord(
          `tool:${event.agentId}:${event.callId || ""}`,
          event,
          Boolean(event.success),
        );
        break;
      case "subagent.completed":
      case "subagent.failed": {
        const success = event.type === "subagent.completed";
        const agent = agents.get(event.agentId);
        if (agent) {
          agent.status = success ? event.status || "completed" : "failed";
          agent.completedAt = isoTime(timestamp);
          agent.summary = clipped(event.summary || event.error, 700);
        }
        finishRecord(`agent:${event.agentId}`, event, success);
        break;
      }
      case "instructions.loaded":
      case "memory.updated":
      case "context.compacted":
        addRecord({
          key: `${event.type}:${timestamp}`,
          timestamp,
          kind: "checkpoint",
          eventType: event.type,
          actor: event.type === "memory.updated" ? "witness" : "main",
          status: "completed",
          detail:
            event.fact?.content ||
            event.files?.join(", ") ||
            `${event.compactedMessages || 0}`,
        });
        break;
      case "self_check.started":
        phase = "self-check";
        addRecord({
          key: "self-check",
          timestamp,
          kind: "checkpoint",
          eventType: "self_check.started",
          status: "running",
          detail: `${event.paths?.length || 0}`,
        });
        break;
      case "self_check.segment.started":
        addRecord({
          key: `self-check:${event.segmentId}`,
          timestamp,
          kind: "checkpoint",
          eventType: "self_check.segment.started",
          actor: "subagent",
          role: "review",
          status: "running",
          detail: `${event.paths?.length || 0}`,
          planStepId: event.planStepId || null,
        });
        break;
      case "self_check.segment.completed":
        finishRecord(
          `self-check:${event.segmentId}`,
          {
            ...event,
            detail:
              event.findings?.[0]?.message ||
              `${event.paths?.length || 0}`,
          },
          event.verdict === "pass",
        );
        break;
      case "self_check.fallback":
        addRecord({
          key: `self-check-fallback:${timestamp}`,
          timestamp,
          kind: "warning",
          eventType: "self_check.fallback",
          actor: "witness",
          status: "completed",
          detail: event.reason || "incomplete-evidence",
        });
        break;
      case "self_check.sealed":
        addRecord({
          key: `self-check-seal:${event.seal?.id || timestamp}`,
          timestamp,
          kind: "checkpoint",
          eventType: "self_check.sealed",
          actor: "witness",
          status: "completed",
          detail: `${event.seal?.reviewedFiles?.length || 0}`,
        });
        break;
      case "self_check.completed":
        finishRecord("self-check", event, true);
        break;
      case "approval.required":
        status = "waiting";
        addRecord({
          key: `approval:${event.approval?.id || timestamp}`,
          timestamp,
          kind: "checkpoint",
          eventType: "approval.required",
          status: "waiting",
          command: event.approval?.command,
        });
        break;
      case "control.paused":
        status = "paused";
        addRecord({
          key: `paused:${timestamp}`,
          timestamp,
          kind: "status",
          eventType: "control.paused",
          status: "completed",
        });
        break;
      case "control.resumed":
        status = "running";
        addRecord({
          key: `resumed:${timestamp}`,
          timestamp,
          kind: "status",
          eventType: "control.resumed",
          status: "completed",
        });
        break;
      case "turn.completed":
        status = "completed";
        phase = "delivery";
        closeAllRunning(timestamp, "completed");
        addRecord({
          key: `turn:completed:${timestamp}`,
          timestamp,
          kind: "status",
          eventType: "turn.completed",
          status: "completed",
          detail: recordDetail(event),
        });
        break;
      case "turn.cancelled":
        status = "interrupted";
        closeAllRunning(timestamp, "interrupted");
        addRecord({
          key: `turn:cancelled:${timestamp}`,
          timestamp,
          kind: "status",
          eventType: "turn.cancelled",
          status: "interrupted",
          detail: recordDetail(event),
        });
        break;
      case "turn.failed":
        status = "failed";
        closeAllRunning(timestamp, "failed");
        addRecord({
          key: `turn:failed:${timestamp}`,
          timestamp,
          kind: "status",
          eventType: "turn.failed",
          status: "failed",
          detail: recordDetail(event),
        });
        break;
      default:
        meaningful = false;
        break;
    }

    if (!meaningful) return;
    lastMeaningfulAt = timestamp;
    publish(event.type);
  };

  const heartbeat = () => {
    if (disposed || !["running", "waiting"].includes(status)) return;
    const timestamp = now();
    const active = records.filter((record) =>
      ["running", "waiting"].includes(record.status),
    );
    for (const record of active) {
      const age = timestamp - Date.parse(record.startedAt);
      if (age >= LONG_RUNNING_MS) record.longRunning = true;
      if (age >= STALLED_MS) {
        addAlert({
          code: `stalled:${record.id}`,
          severity: "warning",
          detail: `${record.tool || record.eventType} has made no observable progress for ${Math.round(age / 1000)} seconds.`,
          timestamp,
        });
      }
    }
    publish("heartbeat");
  };

  const interval =
    heartbeatMs > 0 ? setIntervalFn(heartbeat, heartbeatMs) : null;
  interval?.unref?.();

  return {
    observe,
    snapshot,
    heartbeat,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (interval) clearIntervalFn(interval);
    },
  };
}
