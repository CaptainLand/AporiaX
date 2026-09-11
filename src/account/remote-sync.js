const MAX_SYNCED_TASKS = 12;
const MAX_MESSAGES_PER_TASK = 18;
const MAX_MESSAGE_CONTENT = 1_600;
const MAX_WITNESS_RECORDS = 36;

function text(value, max = 1_000) {
  return String(value || "").trim().slice(0, max);
}

function relativePath(value, workspacePath = "") {
  const raw = text(value, 500).replaceAll("\\", "/");
  const root = text(workspacePath, 500).replaceAll("\\", "/").replace(/\/$/, "");
  if (!raw) return "";
  if (root && raw.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return raw.slice(root.length + 1);
  }
  if (/^[a-z]:\//i.test(raw) || raw.startsWith("/")) {
    return raw.split("/").filter(Boolean).slice(-2).join("/");
  }
  return raw;
}

function sanitizeWitnessRecord(record, workspacePath) {
  if (!record || typeof record !== "object") return null;
  return {
    id: text(record.id, 160),
    eventType: text(record.eventType, 80),
    kind: text(record.kind, 40),
    status: text(record.status, 40),
    actor: text(record.actor, 40),
    role: text(record.role, 40),
    tool: text(record.tool, 80),
    path: relativePath(record.path, workspacePath),
    detail: text(record.detail, 1_000),
    elapsedMs: Math.max(0, Number(record.elapsedMs) || 0),
    longRunning: Boolean(record.longRunning),
    createdAt: record.createdAt || record.startedAt || null,
  };
}

function sanitizeWitness(witness, workspacePath) {
  if (!witness || typeof witness !== "object") return null;
  const records = Array.isArray(witness.records)
    ? witness.records
        .slice(-MAX_WITNESS_RECORDS)
        .map((record) => sanitizeWitnessRecord(record, workspacePath))
        .filter(Boolean)
    : [];
  return {
    status: text(witness.status, 40),
    startedAt: witness.startedAt || null,
    completedAt: witness.completedAt || null,
    current: sanitizeWitnessRecord(witness.current, workspacePath),
    counters: {
      activeAgents: Math.max(0, Number(witness.counters?.activeAgents) || 0),
      completed: Math.max(0, Number(witness.counters?.completed) || 0),
      failed: Math.max(0, Number(witness.counters?.failed) || 0),
    },
    records,
  };
}

function sanitizeMessage(message, workspacePath) {
  if (!message || !["user", "assistant"].includes(message.role)) return null;
  return {
    id: text(message.id, 160),
    role: message.role,
    content: text(message.content, MAX_MESSAGE_CONTENT),
    status: text(message.status, 40),
    error: Boolean(message.error),
    queued: Boolean(message.queued),
    createdAt: message.createdAt || null,
    completedAt: message.completedAt || null,
    witness: message.role === "assistant"
      ? sanitizeWitness(message.witness, workspacePath)
      : null,
    progressUpdates: Array.isArray(message.progressUpdates)
      ? message.progressUpdates.slice(-10).map((entry) => ({
          id: text(entry.id, 160),
          kind: text(entry.kind, 40),
          title: text(entry.title, 240),
          detail: text(entry.detail, 800),
          createdAt: entry.createdAt || null,
        }))
      : [],
  };
}

function progressFor(message) {
  if (!message) return 0;
  if (message.status === "completed") return 100;
  const plan = Array.isArray(message.plan?.steps) ? message.plan.steps : [];
  if (plan.length) {
    const completed = plan.filter((step) => step.status === "completed").length;
    const active = plan.some((step) => step.status === "in_progress") ? 0.35 : 0;
    return Math.min(96, Math.max(2, Math.round(((completed + active) / plan.length) * 100)));
  }
  const route = Array.isArray(message.route) ? message.route : [];
  const completed = route.filter((step) => ["completed", "skipped", "recovered"].includes(step.status)).length;
  return Math.min(96, route.length ? Math.max(4, Math.round((completed / route.length) * 100)) : 8);
}

function taskStatus(task, runningTaskIds, pausedTaskIds) {
  if (pausedTaskIds?.has(task.id)) return "paused";
  if (runningTaskIds?.has(task.id)) return "running";
  const assistant = [...(task.messages || [])].reverse().find((message) => message.role === "assistant");
  if (!assistant) return "idle";
  if (assistant.status === "running") return "running";
  if (assistant.status === "failed" || assistant.error) return "failed";
  if (assistant.status === "interrupted") return "interrupted";
  if (assistant.status === "completed") return "completed";
  return "idle";
}

function taskTimestamp(task) {
  const latest = task.messages?.at(-1);
  return Date.parse(latest?.completedAt || latest?.createdAt || task.createdAt || 0) || 0;
}

export function buildRemoteTaskSyncPayload(tasks, { runningTaskIds, pausedTaskIds } = {}) {
  const records = Array.isArray(tasks) ? tasks.filter((task) => task?.id) : [];
  const detailed = [...records]
    .sort((left, right) => taskTimestamp(right) - taskTimestamp(left))
    .slice(0, MAX_SYNCED_TASKS)
    .map((task) => {
      const workspacePath = task.workspacePath || "";
      const messages = (task.messages || [])
        .slice(-MAX_MESSAGES_PER_TASK)
        .map((message) => sanitizeMessage(message, workspacePath))
        .filter(Boolean);
      const latestAssistant = [...(task.messages || [])]
        .reverse()
        .find((message) => message.role === "assistant") || null;
      const status = taskStatus(task, runningTaskIds, pausedTaskIds);
      const progress = status === "completed" ? 100 : progressFor(latestAssistant);
      const witness = sanitizeWitness(latestAssistant?.witness, workspacePath);
      const route = (latestAssistant?.route || []).slice(-24).map((entry) => ({
        id: text(entry.id, 160),
        stage: text(entry.stage, 40),
        title: text(entry.title, 240),
        detail: text(entry.detail, 800),
        path: relativePath(entry.path, workspacePath),
        status: text(entry.status, 40),
        startedAt: entry.startedAt || null,
        completedAt: entry.completedAt || null,
      }));
      const summary = text(latestAssistant?.content, 1_200) ||
        text(witness?.current?.detail, 1_200) ||
        (status === "running" ? "AporiaX is working on this task." : "");
      return {
        localTaskId: String(task.id),
        projectId: task.projectId || null,
        projectName: task.projectName || task.workspaceName || null,
        workspaceName: task.workspaceName || null,
        title: text(task.title, 240) || "AporiaX Task",
        status,
        progress,
        summary,
        snapshot: {
          messages,
          witness,
          route,
          updatedAt: new Date().toISOString(),
        },
      };
    });
  return {
    tasks: detailed,
    currentTaskIds: records.map((task) => String(task.id)).slice(0, 500),
  };
}
