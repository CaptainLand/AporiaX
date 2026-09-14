import { randomUUID } from "node:crypto";
import { withDurableRun } from "../runtime/durable-run.js";
import {
  acknowledgeRecoverableRun,
  appendRunJournalEvents,
  beginRunJournal,
  finishRunJournal,
  getRunRecoveryContext,
  listRecoverableRuns,
  markRunRecoveryStarted,
  updateRunJournalMetadata,
  saveRunCheckpoint,
  saveRunContext,
  saveRunOperation,
  findConfirmedRunOperation,
} from "../run-store.js";

function createAbortError(message = "The task was interrupted.") {
  return Object.assign(new Error(message), { name: "AbortError" });
}

function createRunControl() {
  let paused = false;
  let pauseWaiters = [];
  const steeringQueue = [];
  const steeringListeners = new Set();

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
      for (const listener of steeringListeners) listener();
      return steeringQueue.length;
    },
    hasSteering: () => steeringQueue.length > 0,
    onSteering(listener) {
      steeringListeners.add(listener);
      return () => steeringListeners.delete(listener);
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

  #publish(record, payload, { journal = true } = {}) {
    try {
      record.onEvent?.(payload);
    } catch {
      // Client/renderer observers are not part of task ownership.
    }
    try {
      this.#eventBus?.emit({
        runId: record.runId,
        taskId: record.taskId,
        ...payload,
      });
    } catch {
      // Observability is best-effort.
    }
    if (journal) {
      this.#queueJournal(record, payload);
    }
    return payload;
  }

  #queueJournal(record, event) {
    if (record.persistenceError) return;
    record.pendingEvents.push(event);
    record.pendingBytes += Buffer.byteLength(JSON.stringify(event));
    const stream = ["response.delta", "witness.updated"].includes(event.type);
    if (!stream || record.pendingEvents.length >= 64 || record.pendingBytes >= 64_000) {
      this.#flushJournal(record);
    } else if (!record.journalTimer) {
      record.journalTimer = setTimeout(() => this.#flushJournal(record), 100);
      record.journalTimer.unref?.();
    }
  }

  #flushJournal(record) {
    clearTimeout(record.journalTimer);
    record.journalTimer = null;
    const events = record.pendingEvents.splice(0);
    record.pendingBytes = 0;
    if (events.length) record.journalTail = record.journalTail
      .then(() => {
        if (record.persistenceError) throw record.persistenceError;
        return appendRunJournalEvents(this.#directory(), record.runId, events);
      })
      .catch((error) => this.#persistenceFailed(record, error));
    return record.journalTail;
  }

  #persistenceFailed(record, cause) {
    if (record.persistenceError) return;
    record.persistenceError = Object.assign(new Error("RUN_PERSISTENCE_FAILED: 无法保存任务进度，已停止执行。请检查磁盘空间和数据目录权限。", { cause }), { code: "RUN_PERSISTENCE_FAILED" });
    try { record.onEvent?.({ type: "run.persistence_failed", error: record.persistenceError.message }); } catch {}
    try { this.#eventBus?.emit({ runId: record.runId, taskId: record.taskId, type: "run.persistence_failed", error: record.persistenceError.message }); } catch {}
    record.controller.abort();
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
      pendingEvents: [],
      pendingBytes: 0,
      journalTimer: null,
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
      this.#queueJournal(record, event);
      return event;
    };

    const requestApproval = async (details = {}) => {
      if (controller.signal.aborted) {
        return Promise.resolve({ approved: false, interrupted: true });
      }
      const grantKey = details?.kind === "recovery-reconciliation" ? "" : String(this.#approvalGrantKey(details) || "");
      if (grantKey && record.approvalGrants.has(grantKey)) {
        return Promise.resolve({ approved: true, remembered: true });
      }
      const approvalId = randomUUID();
      try {
        await this.#flushJournal(record);
        if (record.persistenceError) throw record.persistenceError;
        await saveRunCheckpoint(this.#directory(), safeRunId, {
          scopeId: "approval:" + approvalId, phase: "approval-pending",
          approval: { id: approvalId, kind: details.kind, tool: details.tool, title: details.title,
            command: String(details.command || "").slice(0, 4000), cwd: details.cwd },
          requiresFreshApproval: true,
        });
      } catch (error) {
        this.#persistenceFailed(record, error);
        throw record.persistenceError;
      }
      if (controller.signal.aborted) return { approved: false, interrupted: true };
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
      const durableWrite = async (write) => {
        try {
          await this.#flushJournal(record);
          if (record.persistenceError) throw record.persistenceError;
          return await write();
        } catch (cause) {
          this.#persistenceFailed(record, cause);
          throw record.persistenceError;
        }
      };
      try {
        for (const [scopeId, checkpoint] of Object.entries(recoveryContext?.checkpoint?.agents || {})) {
          await durableWrite(() => saveRunCheckpoint(this.#directory(), safeRunId, { ...checkpoint, scopeId: scopeId === recoveryContext.runId ? safeRunId : scopeId }));
        }
        for (const [scopeId, state] of Object.entries(recoveryContext?.contexts || {})) {
          await durableWrite(() => saveRunContext(this.#directory(), safeRunId, scopeId === recoveryContext.runId ? safeRunId : scopeId, state));
        }
        const inheritedOperations = new Map([...(recoveryContext?.operations || []), ...(recoveryContext?.unresolvedOperations || [])].map((operation) => [operation.operationId, operation]));
        const copiedOperations = [];
        for (const operation of inheritedOperations.values()) {
          const copied = { ...operation, operationId: randomUUID(), recoveredFrom: operation.operationId };
          await durableWrite(() => saveRunOperation(this.#directory(), safeRunId, copied));
          copiedOperations.push(copied);
        }
        if (recoveryContext?.runId) {
          await durableWrite(() => markRunRecoveryStarted(this.#directory(), recoveryContext.runId, safeRunId));
        }
        const result = await withDurableRun({
          workspacePath: metadata?.workspacePath || recoveryContext?.workspacePath,
          unresolved: copiedOperations.filter((operation) => ["started", "uncertain"].includes(operation.state)),
          confirmed: copiedOperations.filter((operation) => operation.state === "confirmed"),
          findConfirmed: recoveryContext?.runId
            ? (fingerprint) => durableWrite(() => findConfirmedRunOperation(this.#directory(), safeRunId, fingerprint))
            : null,
          signal: controller.signal,
          checkpoint: (value) => durableWrite(() => saveRunCheckpoint(this.#directory(), safeRunId, value)),
          context: (scopeId, state) => durableWrite(() => saveRunContext(this.#directory(), safeRunId, scopeId, state)),
          operation: (value) => durableWrite(() => saveRunOperation(this.#directory(), safeRunId, value)),
        }, () => execute({
          signal: controller.signal,
          control,
          emit,
          requestApproval,
        }));
        await this.#flushJournal(record);
        if (record.persistenceError) throw record.persistenceError;
        await finishRunJournal(this.#directory(), safeRunId, result);
        return result;
      } catch (error) {
        await this.#flushJournal(record);
        await finishRunJournal(this.#directory(), safeRunId, {
          status: controller.signal.aborted ? "interrupted" : "failed",
          changes: [],
        }).catch(() => undefined);
        throw error;
      } finally {
        clearTimeout(record.journalTimer);
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
    this.#publish(record, payload);
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
    this.#publish(record, payload);
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
      message: steeringMessage,
      queued,
    };
    this.#publish(record, payload);
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
    const record = this.#activeRuns.get(approval.runId);
    if (record) {
      record.journalTail = record.journalTail
        .then(() => saveRunCheckpoint(this.#directory(), approval.runId, {
          scopeId: "approval:" + approval.approvalId, phase: "approval-resolved",
          approved: Boolean(approved), requiresFreshApproval: true,
        }))
        .catch((error) => this.#persistenceFailed(record, error));
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
