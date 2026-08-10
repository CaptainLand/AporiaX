const DEFAULT_CACHE_BYTES = 3_500_000;
const DEFAULT_CACHE_MESSAGES = 50;
const DEFAULT_CACHE_TASKS = 20;

function asTasks(value) {
  return Array.isArray(value) ? value : [];
}

function byteLength(value) {
  return new TextEncoder().encode(String(value || "")).byteLength;
}

export function createLightweightTaskSnapshot(
  tasks,
  {
    maxMessages = DEFAULT_CACHE_MESSAGES,
    maxTasks = Infinity,
    maxContentChars = 60_000,
    maxAttachmentContentChars = 20_000,
  } = {},
) {
  return asTasks(tasks)
    .slice(0, Math.max(0, Number(maxTasks) || 0))
    .map((task) => ({
      ...task,
      anchorRestores: (task?.anchorRestores || []).slice(-10),
      messages: (task?.messages || []).slice(-Math.max(0, maxMessages)).map((message) => ({
        ...message,
        content: String(message?.content || "").slice(-maxContentChars),
        changes: [],
        anchor: message?.anchor
          ? {
              ...message.anchor,
              warning: "Snapshot payload is stored in the desktop task history.",
            }
          : null,
        attachments: (message?.attachments || []).map((attachment) => ({
          ...attachment,
          dataUrl: undefined,
          data: undefined,
          content: String(attachment?.content || "").slice(
            0,
            maxAttachmentContentChars,
          ),
        })),
      })),
    }));
}

export function serializeTaskCache(
  tasks,
  {
    maxBytes = DEFAULT_CACHE_BYTES,
    maxMessages = DEFAULT_CACHE_MESSAGES,
    maxTasks = DEFAULT_CACHE_TASKS,
  } = {},
) {
  const records = asTasks(tasks);
  const full = JSON.stringify(records);
  if (byteLength(full) <= maxBytes) {
    return {
      json: full,
      lightweight: false,
      taskCount: records.length,
      messageCount: records.reduce(
        (total, task) => total + (task?.messages?.length || 0),
        0,
      ),
    };
  }

  const lightweightRecords = createLightweightTaskSnapshot(records, {
    maxMessages,
    maxTasks,
  });
  return {
    json: JSON.stringify(lightweightRecords),
    lightweight: true,
    taskCount: lightweightRecords.length,
    messageCount: lightweightRecords.reduce(
      (total, task) => total + (task?.messages?.length || 0),
      0,
    ),
  };
}

export function chooseHydratedTasks({
  desktopLoaded = false,
  desktopTasks = [],
  cachedTasks = [],
} = {}) {
  // localStorage is only a startup cache. Once the desktop store has completed
  // a successful read, that durable snapshot becomes authoritative even when
  // it is empty. This prevents stale/truncated browser caches from becoming a
  // second live source of truth.
  return desktopLoaded ? asTasks(desktopTasks) : asTasks(cachedTasks);
}

export function updateTaskById(tasks, taskId, updater) {
  if (typeof updater !== "function") return asTasks(tasks);
  let changed = false;
  const next = asTasks(tasks).map((task) => {
    if (task?.id !== taskId) return task;
    const updated = updater(task);
    if (!updated || updated === task) return task;
    changed = true;
    return updated;
  });
  return changed ? next : asTasks(tasks);
}

export function updateTaskMessageById(
  tasks,
  taskId,
  messageId,
  updater,
) {
  return updateTaskById(tasks, taskId, (task) => {
    const messages = Array.isArray(task?.messages) ? task.messages : [];
    let changed = false;
    const nextMessages = messages.map((message) => {
      if (message?.id !== messageId) return message;
      const updated = updater(message);
      if (!updated || updated === message) return message;
      changed = true;
      return updated;
    });
    return changed ? { ...task, messages: nextMessages } : task;
  });
}

export function appendTaskMessage(tasks, taskId, message) {
  if (!message || typeof message !== "object") return asTasks(tasks);
  return updateTaskById(tasks, taskId, (task) => ({
    ...task,
    messages: [...(task?.messages || []), message],
  }));
}

export class AporiaXTaskStore {
  #tasks;
  #listeners = new Set();
  #revision = 0;
  #lastMutation = null;

  constructor(initialTasks = []) {
    this.#tasks = asTasks(initialTasks);
  }

  getSnapshot = () => this.#tasks;

  get revision() {
    return this.#revision;
  }

  get lastMutation() {
    return this.#lastMutation;
  }

  subscribe = (listener) => {
    if (typeof listener !== "function") return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  replace(tasks, metadata = {}) {
    const next = asTasks(tasks);
    if (next === this.#tasks) return this.#tasks;
    this.#commit(next, { type: "replace", ...metadata });
    return this.#tasks;
  }

  update(updater, metadata = {}) {
    if (typeof updater !== "function") return this.#tasks;
    const next = updater(this.#tasks);
    if (!Array.isArray(next) || next === this.#tasks) return this.#tasks;
    this.#commit(next, { type: "update", ...metadata });
    return this.#tasks;
  }

  updateTask(taskId, updater, metadata = {}) {
    return this.update(
      (tasks) => updateTaskById(tasks, taskId, updater),
      { type: "task.update", taskId, ...metadata },
    );
  }

  updateMessage(taskId, messageId, updater, metadata = {}) {
    return this.update(
      (tasks) => updateTaskMessageById(tasks, taskId, messageId, updater),
      {
        type: "message.update",
        taskId,
        messageId,
        ...metadata,
      },
    );
  }

  appendMessage(taskId, message, metadata = {}) {
    return this.update(
      (tasks) => appendTaskMessage(tasks, taskId, message),
      {
        type: "message.append",
        taskId,
        messageId: message?.id || null,
        ...metadata,
      },
    );
  }

  #commit(next, metadata) {
    this.#tasks = next;
    this.#revision += 1;
    this.#lastMutation = {
      revision: this.#revision,
      timestamp: new Date().toISOString(),
      ...metadata,
    };
    for (const listener of [...this.#listeners]) listener();
  }
}

export function createTaskStore(initialTasks = []) {
  return new AporiaXTaskStore(initialTasks);
}
