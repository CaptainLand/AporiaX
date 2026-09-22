import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateApprovalResponse } from "./approval-response.js";
import { withDurableRun } from "../runtime/durable-run.js";
import { createRunControl } from "../runtime/run-control.js";
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
  putRunEvidence,
  readRunEvidence,
} from "../run-store.js";

function createAbortError(message = "The task was interrupted.") {
  return Object.assign(new Error(message), { name: "AbortError" });
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
  #startingRuns = new Map();
  #activeListeners = new Set();
  subscribeActiveRuns(listener) {
    this.#activeListeners.add(listener);
    listener(this.listActiveRuns());
    return () => this.#activeListeners.delete(listener);
  }
  #notifyActive() {
    for (const listener of this.#activeListeners) {
      try { listener(this.listActiveRuns()); } catch { /* observers cannot change task state */ }
    }
  }
  #pendingApprovals = new Map();
  #approvalGrantKey;
  #onIdle;
  #taskStarter = null;
  #environment = { online: true, sleeping: false };

  setEnvironment(patch) {
    Object.assign(this.#environment, patch);
    for (const record of [...this.#activeRuns.values(), ...this.#startingRuns.values()]) {
      if (this.#environment.sleeping) record.control.suspend();
      else if (patch.sleeping === false) record.control.wake(this.#environment.online);
      record.control.setOnline(this.#environment.online);
    }
  }

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
    const last = record.lastSuccessfulContext;
    const reason = /RUN_CONTEXT_TOO_(?:LARGE|DEEP)/.test(String(cause?.message)) ? "任务存储容量或结构超过上限。" : "请检查磁盘空间和数据目录权限。";
    record.persistenceError = Object.assign(new Error(`RUN_PERSISTENCE_FAILED: 无法保存任务进度，已停止执行。${reason}最后成功快照：${last?.savedAt || "本轮尚未保存"}。不要直接重复未知结果的操作。`, { cause }),
      { code: "RUN_PERSISTENCE_FAILED", lastSuccessfulContext: last || null });
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
    return this.#activeRuns.size + this.#startingRuns.size > 0;
  }

  getActiveRun(runId) {
    const key = String(runId || "");
    const record = this.#activeRuns.get(key) || this.#startingRuns.get(key);
    if (!record) return null;
    return {
      runId: record.runId,
      taskId: record.taskId,
      clientId: record.clientId || null,
      workspacePath: record.workspacePath || "",
      phase: this.#startingRuns.has(record.runId) ? "preparing" : "running",
      paused: record.control.paused,
      pauseReasons: record.control.snapshot().pauseReasons,
      startedAt: record.startedAt,
      pendingApprovals: [...this.#pendingApprovals.values()].filter(
        (approval) => approval.runId === record.runId,
      ).length,
    };
  }

  listActiveRuns() {
    return [...new Set([...this.#activeRuns.keys(), ...this.#startingRuns.keys()])]
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
    if (this.#activeRuns.has(safeRunId) || this.#startingRuns.has(safeRunId)) {
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
      workspacePath: metadata?.workspacePath || "",
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

    this.#startingRuns.set(safeRunId, record);
    this.#notifyActive();
    try { await beginRunJournal(this.#directory(), {
      runId: safeRunId,
      taskId,
      assistantId: metadata?.assistantId,
      sourceUserId: metadata?.sourceUserId,
      prompt: metadata?.prompt,
      workspacePath: metadata?.workspacePath,
      providerId: metadata?.providerId,
      modelId: metadata?.modelId,
      recoveryOfRunId: recoveryContext?.runId,
    }); } catch (error) {
      this.#startingRuns.delete(safeRunId); this.#notifyActive(); throw error;
    }
    this.#activeRuns.set(safeRunId, record);
    this.#startingRuns.delete(safeRunId);
    let lastPauseKey = "";
    const unsubscribeControl = control.onChange((state) => {
      if (record.controller.signal.aborted) return;
      const key = state.pauseReasons.join("|");
      if (lastPauseKey !== key) {
        lastPauseKey = key;
        this.#publish(record, { type: state.paused ? "control.paused" : "control.resumed",
          pauseReasons: state.pauseReasons, timestamp: new Date().toISOString() });
      }
      record.journalTail = this.#flushJournal(record).then(async () => {
        if (record.persistenceError) throw record.persistenceError;
        await saveRunCheckpoint(this.#directory(), safeRunId, { scopeId: "run-control", phase: "control", ...state });
        await updateRunJournalMetadata(this.#directory(), safeRunId, { status: state.paused ? "paused" : "running" });
      }).catch((error) => { this.#persistenceFailed(record, error); throw record.persistenceError; });
      record.journalTail.catch(() => {});
      this.#notifyActive();
      return record.journalTail;
    });
    if (this.#environment.sleeping) control.suspend();
    control.setOnline(this.#environment.online);
    this.#notifyActive();

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
      const grantKey = details?.kind === "recovery-reconciliation" ? ""
        : details?.kind === "project-script-trust"
          ? (details.projectFingerprint ? `project-script:${details.projectFingerprint}` : "")
          : String(this.#approvalGrantKey(details) || "");
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
          requestTrace: { taskId: record.taskId, runId: safeRunId },
          control,
          recoveryDirectory: join(this.#directory(), "workspace-recovery"),
          workspacePath: metadata?.workspacePath || recoveryContext?.workspacePath,
          unresolved: copiedOperations.filter((operation) => ["started", "uncertain"].includes(operation.state)),
          confirmed: copiedOperations.filter((operation) => operation.state === "confirmed"),
          findConfirmed: recoveryContext?.runId
            ? (fingerprint) => durableWrite(() => findConfirmedRunOperation(this.#directory(), safeRunId, fingerprint))
            : null,
          signal: controller.signal,
          checkpoint: (value) => durableWrite(() => saveRunCheckpoint(this.#directory(), safeRunId, value)),
          context: async (scopeId, state) => {
            await durableWrite(() => saveRunContext(this.#directory(), safeRunId, scopeId, state));
            if (scopeId === safeRunId) record.lastSuccessfulContext = { runId: safeRunId, scopeId, savedAt: new Date().toISOString() };
          },
          evidenceStore: {
            put: (text) => durableWrite(() => putRunEvidence(this.#directory(), safeRunId, text)),
            read: (page) => readRunEvidence(this.#directory(), safeRunId, page),
          },
          operation: (value) => durableWrite(() => saveRunOperation(this.#directory(), safeRunId, value)),
        }, async () => {
          await control.waitIfPaused(controller.signal);
          return execute({
          signal: controller.signal,
          control,
          emit,
          requestApproval,
          });
        });
        await control.flush();
        await this.#flushJournal(record);
        if (record.persistenceError) return { ...result, status: "blocked", error: true, content: record.persistenceError.message,
          persistence: { failed: true, lastSuccessfulContext: record.persistenceError.lastSuccessfulContext } };
        await finishRunJournal(this.#directory(), safeRunId, result);
        return result;
      } catch (error) {
        await this.#flushJournal(record);
        await finishRunJournal(this.#directory(), safeRunId, {
          status: controller.signal.aborted ? "interrupted" : "failed",
          changes: [],
        }).catch(() => undefined);
        if (record.persistenceError) return { status: "blocked", error: true, content: record.persistenceError.message, changes: [],
          persistence: { failed: true, lastSuccessfulContext: record.persistenceError.lastSuccessfulContext } };
        throw error;
      } finally {
        clearTimeout(record.journalTimer);
        unsubscribeControl();
        control.abort();
        this.#activeRuns.delete(safeRunId);
        this.#notifyActive();
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
    record.control.pause();
    await record.control.flush();
    return true;
  }

  async resume(runId, { clientId = "" } = {}) {
    const record = this.#activeRuns.get(String(runId || ""));
    if (!record || !clientCanControl(record, clientId)) return false;
    record.control.resume();
    record.control.retryNetwork();
    await record.control.flush();
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
    response,
  ) {
    const { approved, scope, clientId } = validateApprovalResponse(runId, approvalId, response);
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
      approved && scope === "run" && Boolean(approval.grantKey);
    if (shouldRemember) {
      this.#activeRuns.get(approval.runId)?.approvalGrants.add(approval.grantKey);
    }
    const record = this.#activeRuns.get(approval.runId);
    if (record) {
      record.journalTail = record.journalTail
        .then(() => saveRunCheckpoint(this.#directory(), approval.runId, {
          scopeId: "approval:" + approval.approvalId, phase: "approval-resolved",
          approved, requiresFreshApproval: true,
        }))
        .catch((error) => this.#persistenceFailed(record, error));
    }
    approval.resolve({ approved, remembered: shouldRemember });
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
