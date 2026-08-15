import { randomUUID } from "node:crypto";
import {
  acknowledgeRecoverableRun,
  appendRunJournalEvent,
  beginRunJournal,
  finishRunJournal,
  getRunRecoveryContext,
  listRecoverableRuns,
  markRunRecoveryStarted,
  updateRunJournalMetadata,
} from "../run-store.js";

function createAbortError(message = "The task was interrupted.") {
  return Object.assign(new Error(message), { name: "AbortError" });
}

function createRunControl() {
  let paused = false;
  let pauseWaiters = [];
  const steeringQueue = [];

  const settlePauseWaiters = () => {
    const waiters = pauseWaiters;
    pauseWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  };

  return {
    get paused() {
      return paused;
    },
    pause() {
      if (paused) return false;
      paused = true;
      return true;
    },
    resume() {
      if (!paused) return false;
      paused = false;
      settlePauseWaiters();
      return true;
    },
    enqueueSteering(message) {
      steeringQueue.push(message);
      return steeringQueue.length;
    },
    consumeSteering() {
      return steeringQueue.splice(0, steeringQueue.length);
    },
    async waitIfPaused(signal) {
      if (!paused) return;
      if (signal?.aborted) throw createAbortError();
      await new Promise((resolveWait, rejectWait) => {
        let waiterEntry = null;
        const handleAbort = () => {
          pauseWaiters = pauseWaiters.filter((waiter) => waiter !== waiterEntry);
          rejectWait(createAbortError());
        };
        signal?.addEventListener("abort", handleAbort, { once: true });
        waiterEntry = {
          resolve: () => {
            signal?.removeEventListener("abort", handleAbort);
            resolveWait();
          },
        };
        pauseWaiters.push(waiterEntry);
      });
    },
    abort() {
      paused = false;
      settlePauseWaiters();
    },
  };
}

function normalizeSteeringMessage(message = {}) {
  const content = String(message?.content || "").trim();
  const attachments = Array.isArray(message?.attachments)
    ? message.attachments.slice(0, 6)
    : [];
  if (!content && attachments.length === 0) return null;
  return {
    id: String(message?.id || randomUUID()),
    role: "user",
    content,
    attachments,
    createdAt: String(message?.createdAt || new Date().toISOString()),
  };
}

function clientCanControl(record, clientId) {
  if (!clientId) return true;
  return !record.clientId || record.clientId === String(clientId);
}

export class HarnessTaskRuntime {
  #dataDirectory;
  #eventBus;
  #activeRuns = new Map();
  #pendingApprovals = new Map();
  #approvalGrantKey;
  #onIdle;
  #taskStarter = null;

  constructor({
    dataDirectory,
    eventBus = null,
    approvalGrantKey = () => "",
    onIdle = null,
  } = {}) {
    this.#dataDirectory = dataDirectory;
    this.#eventBus = eventBus;
    this.#approvalGrantKey = approvalGrantKey;
    this.#onIdle = onIdle;
  }

  #directory() {
    const value =
      typeof this.#dataDirectory === "function"
        ? this.#dataDirectory()
        : this.#dataDirectory;
    if (!value) throw new Error("Harness Task Runtime requires a data directory.");
    return String(value);
  }

  attachEventBus(eventBus) {
    this.#eventBus = eventBus || null;
    return this;
  }

  setTaskStarter(starter) {
    if (starter != null && typeof starter !== "function") {
      throw new TypeError("Task starter must be a function.");
    }
    this.#taskStarter = starter || null;
    return this;
  }

  canStartTasks() {
    return typeof this.#taskStarter === "function";
  }

  startFromRpc(request = {}) {
    if (!this.#taskStarter) {
      throw new Error("Task creation is not available through Core RPC.");
    }
    return this.#taskStarter(request, {
      clientId: "core-http",
      detached: true,
      onEvent: null,
    });
  }

  hasActiveRuns() {
    return this.#activeRuns.size > 0;
  }

  getActiveRun(runId) {
    const record = this.#activeRuns.get(String(runId || ""));
    if (!record) return null;
    return {
      runId: record.runId,
      taskId: record.taskId,
      clientId: record.clientId || null,
      paused: record.control.paused,
      startedAt: record.startedAt,
      pendingApprovals: [...this.#pendingApprovals.values()].filter(
        (approval) => approval.runId === record.runId,
      ).length,
    };
  }

  listActiveRuns() {
    return [...this.#activeRuns.keys()]
      .map((runId) => this.getActiveRun(runId))
      .filter(Boolean);
  }

  async listRecoverableRuns() {
    return listRecoverableRuns(this.#directory());
  }

  async recoveryContext(runId) {
    return getRunRecoveryContext(this.#directory(), runId);
  }

  async acknowledgeRecovery(runId) {
    await acknowledgeRecoverableRun(this.#directory(), runId);
    return true;
  }

  async start({
    runId,
    taskId = "",
    clientId = "",
    metadata = {},
    recoveryContext = null,
    onEvent = null,
    execute,
    detached = false,
  } = {}) {
    const safeRunId = String(runId || "").trim();
    if (!safeRunId || safeRunId.length > 100) {
      throw new Error("A valid run id is required.");
    }
    if (this.#activeRuns.has(safeRunId)) {
      throw new Error("This Harness run is already active.");
    }
    if (typeof execute !== "function") {
      throw new TypeError("Harness Task Runtime requires an execute function.");
    }

    const controller = new AbortController();
    const control = createRunControl();
    const record = {
      runId: safeRunId,
      taskId: String(taskId || ""),
      clientId: String(clientId || ""),
      controller,
      control,
      journalTail: Promise.resolve(),
      approvalGrants: new Set(),
      startedAt: new Date().toISOString(),
      onEvent,
    };

    await beginRunJournal(this.#directory(), {
      runId: safeRunId,
      taskId,
      assistantId: metadata?.assistantId,
      sourceUserId: metadata?.sourceUserId,
      prompt: metadata?.prompt,
      workspacePath: metadata?.workspacePath,
      providerId: metadata?.providerId,
      modelId: metadata?.modelId,
      recoveryOfRunId: recoveryContext?.runId,
    });
    this.#activeRuns.set(safeRunId, record);

    if (recoveryContext?.runId) {
      await markRunRecoveryStarted(
        this.#directory(),
        recoveryContext.runId,
        safeRunId,
      ).catch(() => undefined);
    }

    const emit = (payload = {}) => {
      const event = {
        timestamp: payload?.timestamp || new Date().toISOString(),
        ...payload,
      };
      try {
        record.onEvent?.(event);
      } catch {
        // A renderer/client disappearing must never terminate the task.
      }
      try {
        this.#eventBus?.emit({ runId: safeRunId, taskId: record.taskId, ...event });
      } catch {
        // Observability is best-effort; task execution remains authoritative.
      }
      record.journalTail = record.journalTail
        .then(() => appendRunJournalEvent(this.#directory(), safeRunId, event))
        .catch(() => undefined);
      return event;
    };

    const requestApproval = (details = {}) => {
      if (controller.signal.aborted) {
        return Promise.resolve({ approved: false, interrupted: true });
      }
      const grantKey = String(this.#approvalGrantKey(details) || "");
      if (grantKey && record.approvalGrants.has(grantKey)) {
        return Promise.resolve({ approved: true, remembered: true });
      }
      const approvalId = randomUUID();
      return new Promise((resolveApproval) => {
        const handleAbort = () => {
          this.#pendingApprovals.delete(approvalId);
          resolveApproval({ approved: false, interrupted: true });
        };
        controller.signal.addEventListener("abort", handleAbort, { once: true });
        this.#pendingApprovals.set(approvalId, {
          approvalId,
          runId: safeRunId,
          clientId: record.clientId,
          grantKey,
          resolve: (response) => {
            controller.signal.removeEventListener("abort", handleAbort);
            resolveApproval(response);
          },
        });
        emit({
          type: "approval.required",
          approval: {
            id: approvalId,
            canRememberForRun: Boolean(grantKey),
            ...details,
          },
        });
      });
    };

    const runPromise = (async () => {
      try {
        const result = await execute({
          signal: controller.signal,
          control,
          emit,
          requestApproval,
        });
        await record.journalTail;
        await finishRunJournal(this.#directory(), safeRunId, result);
        return result;
      } catch (error) {
        await record.journalTail;
        await finishRunJournal(this.#directory(), safeRunId, {
          status: controller.signal.aborted ? "interrupted" : "failed",
          changes: [],
        }).catch(() => undefined);
        throw error;
      } finally {
        control.abort();
        this.#activeRuns.delete(safeRunId);
        for (const [approvalId, approval] of this.#pendingApprovals) {
          if (approval.runId !== safeRunId) continue;
          this.#pendingApprovals.delete(approvalId);
          approval.resolve({ approved: false, interrupted: true });
        }
        if (this.#activeRuns.size === 0) {
          try {
            this.#onIdle?.();
          } catch {
            // Idle hooks are advisory only.
          }
        }
      }
    })();

    if (!detached) return runPromise;
    runPromise.catch(() => undefined);
    return {
      runId: safeRunId,
      taskId: record.taskId,
      status: "running",
      startedAt: record.startedAt,
    };
  }

  interrupt(runId, { clientId = "" } = {}) {
    const record = this.#activeRuns.get(String(runId || ""));
    if (!record || !clientCanControl(record, clientId)) return false;
    record.controller.abort();
    record.control.abort();
    return true;
  }

  async pause(runId, { clientId = "" } = {}) {
    const record = this.#activeRuns.get(String(runId || ""));
    if (!record || !clientCanControl(record, clientId)) return false;
    if (!record.control.pause()) return true;
    const payload = { type: "control.paused" };
    record.onEvent?.(payload);
    this.#eventBus?.emit({ runId: record.runId, taskId: record.taskId, ...payload });
    record.journalTail = record.journalTail
      .then(() => appendRunJournalEvent(this.#directory(), record.runId, payload))
      .catch(() => undefined);
    await updateRunJournalMetadata(this.#directory(), record.runId, {
      status: "paused",
      lastEventType: payload.type,
    }).catch(() => undefined);
    return true;
  }

  async resume(runId, { clientId = "" } = {}) {
    const record = this.#activeRuns.get(String(runId || ""));
    if (!record || !clientCanControl(record, clientId)) return false;
    if (!record.control.resume()) return true;
    const payload = { type: "control.resumed" };
    record.onEvent?.(payload);
    this.#eventBus?.emit({ runId: record.runId, taskId: record.taskId, ...payload });
    record.journalTail = record.journalTail
      .then(() => appendRunJournalEvent(this.#directory(), record.runId, payload))
      .catch(() => undefined);
    await updateRunJournalMetadata(this.#directory(), record.runId, {
      status: "running",
      lastEventType: payload.type,
    }).catch(() => undefined);
    return true;
  }

  steer(runId, message, { clientId = "" } = {}) {
    const record = this.#activeRuns.get(String(runId || ""));
    if (!record || !clientCanControl(record, clientId)) return false;
    const steeringMessage = normalizeSteeringMessage(message);
    if (!steeringMessage) return false;
    const queued = record.control.enqueueSteering(steeringMessage);
    const payload = {
      type: "steering.queued",
      messageId: steeringMessage.id,
      queued,
    };
    record.onEvent?.(payload);
    this.#eventBus?.emit({ runId: record.runId, taskId: record.taskId, ...payload });
    record.journalTail = record.journalTail
      .then(() => appendRunJournalEvent(this.#directory(), record.runId, payload))
      .catch(() => undefined);
    return true;
  }

  respondApproval(
    runId,
    approvalId,
    { approved = false, scope = "once", clientId = "" } = {},
  ) {
    const approval = this.#pendingApprovals.get(String(approvalId || ""));
    if (
      !approval ||
      approval.runId !== String(runId || "") ||
      (clientId && approval.clientId && approval.clientId !== String(clientId))
    ) {
      return false;
    }
    this.#pendingApprovals.delete(approval.approvalId);
    const shouldRemember =
      Boolean(approved) && scope === "run" && Boolean(approval.grantKey);
    if (shouldRemember) {
      this.#activeRuns.get(approval.runId)?.approvalGrants.add(approval.grantKey);
    }
    approval.resolve({ approved: Boolean(approved), remembered: shouldRemember });
    return true;
  }

  async snapshot() {
    return {
      active: this.listActiveRuns(),
      recoverable: await this.listRecoverableRuns(),
      pendingApprovals: [...this.#pendingApprovals.values()].map((approval) => ({
        approvalId: approval.approvalId,
        runId: approval.runId,
      })),
      canStartTasks: this.canStartTasks(),
    };
  }
}

export function createHarnessTaskRuntime(options) {
  return new HarnessTaskRuntime(options);
}
