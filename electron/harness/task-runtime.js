import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateApprovalResponse } from "./approval-response.js";
import { withDurableRun } from "../runtime/durable-run.js";
import { createRunControl } from "../runtime/run-control.js";
import { clarificationScope, createClarificationSession } from "../runtime/user-clarification.js";
import {
  acknowledgeRecoverableRun,
  appendRunJournalEvents,
  beginRunJournal,
  finishRunJournal,
  getRunRecoveryContext,
  listRecoverableRuns,
  listRunRecords,
  readRunResult,
  readRunEvents,
  sanitizeRunResult,
  markRunRecoveryStarted,
  updateRunJournalMetadata,
  saveRunCheckpoint,
  saveRunContext,
  saveRunOperation,
  findConfirmedRunOperation,
  putRunEvidence,
  readRunEvidence,
  readClarificationLedger,
  writeClarificationLedger,
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
  #finishedListeners = new Set();
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
  subscribeRunFinished(listener) {
    if (typeof listener !== "function") throw new TypeError("Run result listener must be a function.");
    this.#finishedListeners.add(listener);
    return () => this.#finishedListeners.delete(listener);
  }
  async #notifyFinished(record) {
    const result = await readRunResult(this.#directory(), record.runId);
    if (!result) return;
    const notification = { runId: record.runId, taskId: record.taskId, clientId: record.clientId || null, result };
    for (const listener of new Set([record.onResult, ...this.#finishedListeners])) {
      if (typeof listener !== "function") continue;
      try { Promise.resolve(listener(notification)).catch(() => undefined); } catch { /* observers do not own execution */ }
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
    if (this.#startingRuns.has(record.runId)) return;
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

  startFromRpc(request = {}, { clientId = "core-http", onEvent = null, onResult = null } = {}) {
    if (!this.#taskStarter) {
      throw new Error("Task creation is not available through Core RPC.");
    }
    return this.#taskStarter(request, {
      clientId: String(clientId),
      detached: true,
      onEvent,
      onResult,
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
      clarifications: record.clarification?.snapshot() || [],
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

  listRuns(options = {}) {
    return listRunRecords(this.#directory(), options);
  }

  getRunResult(runId) {
    return readRunResult(this.#directory(), runId);
  }

  async readEvents(runId, options = {}) {
    const record = this.#activeRuns.get(String(runId || ""));
    if (record) await this.#flushJournal(record);
    return readRunEvents(this.#directory(), runId, options);
  }

  getPendingApprovals(runId) {
    return [...this.#pendingApprovals.values()]
      .filter(approval => runId === undefined || approval.runId === String(runId))
      .map(approval => ({ approvalId: approval.approvalId, runId: approval.runId, clientId: approval.clientId || null,
        approval: { ...approval.publicDetails } }));
  }

  async listRecoverableRuns() {
    const records = await listRecoverableRuns(this.#directory());
    return Promise.all(records.map(async record => {
      const key = clarificationScope({ taskId: record.taskId, sourceUserId: record.sourceUserId, runId: record.runId });
      const ledger = await readClarificationLedger(this.#directory(), key);
      return { ...record, clarifications: (ledger?.questions || []).map((question, index) => ({
        ...question, runId: record.runId, taskId: record.taskId, ordinal: index + 1, limit: 2,
      })) };
    }));
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
    onResult = null,
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
    const clarificationKey = recoveryContext?.checkpoint?.agents?.clarification?.key || clarificationScope({
      taskId, sourceUserId: recoveryContext?.sourceUserId || metadata?.sourceUserId, runId: recoveryContext?.runId || safeRunId,
    });
    if ([...this.#activeRuns.values(), ...this.#startingRuns.values()].some(item => item.clarificationKey === clarificationKey)) {
      throw new Error("This user request is already running.");
    }
    const record = {
      clarificationKey,
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
      onResult,
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
    this.#flushJournal(record);
    let lastPauseKey = "";
    const onControlChange = (state) => {
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
    };
    const unsubscribeControl = control.onChange(onControlChange);
    if (control.paused) onControlChange(control.snapshot());
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
          publicDetails: sanitizeRunResult({ id: approvalId, canRememberForRun: Boolean(grantKey),
            ...Object.fromEntries(["kind", "tool", "title", "command", "cwd", "path", "description", "reason", "capability"]
              .filter(key => details[key] !== undefined).map(key => [key, details[key]])) }, { maxBytes: 32_000 }),
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
        record.clarification = createClarificationSession({
          state: await readClarificationLedger(this.#directory(), clarificationKey),
          runId: safeRunId, taskId: record.taskId, control, signal: controller.signal, emit,
          persist: (state, revision) => durableWrite(() => writeClarificationLedger(this.#directory(), clarificationKey, state, revision)),
          onFailure: (error) => this.#persistenceFailed(record, error),
        });
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
        await durableWrite(() => saveRunCheckpoint(this.#directory(), safeRunId, { scopeId: "clarification", key: clarificationKey }));
        const result = await withDurableRun({
          requestTrace: { taskId: record.taskId, runId: safeRunId },
          requestCheckpoints: { ...recoveryContext?.checkpoint?.agents },
          recoveryContexts: recoveryContext?.contexts || {},
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
          await record.clarification.restore();
          await control.waitIfPaused(controller.signal);
          return execute({
          signal: controller.signal,
          control,
          emit,
          requestApproval,
          clarification: record.clarification,
          });
        });
        await control.flush();
        await record.clarification.flush();
        await this.#flushJournal(record);
        if (record.persistenceError) return { ...result, status: "blocked", error: true, content: record.persistenceError.message,
          persistence: { failed: true, lastSuccessfulContext: record.persistenceError.lastSuccessfulContext } };
        await finishRunJournal(this.#directory(), safeRunId, result);
        await this.#notifyFinished(record);
        return result;
      } catch (error) {
        await this.#flushJournal(record);
        await finishRunJournal(this.#directory(), safeRunId, {
          status: record.persistenceError ? "blocked" : controller.signal.aborted ? "interrupted" : "failed",
          content: record.persistenceError?.message || error?.message || "Harness run failed.",
          error: !controller.signal.aborted || Boolean(record.persistenceError),
          errorDetails: { name: error?.name || "Error", ...(error?.code ? { code: error.code } : {}) },
          changes: [],
          ...(record.persistenceError ? { persistence: { failed: true, lastSuccessfulContext: record.persistenceError.lastSuccessfulContext } } : {}),
        }).then(() => this.#notifyFinished(record)).catch(() => undefined);
        if (record.persistenceError) return { status: "blocked", error: true, content: record.persistenceError.message, changes: [],
          persistence: { failed: true, lastSuccessfulContext: record.persistenceError.lastSuccessfulContext } };
        throw error;
      } finally {
        await record.clarification?.flush();
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
    const record = this.#activeRuns.get(String(runId || "")) || this.#startingRuns.get(String(runId || ""));
    if (!record || !clientCanControl(record, clientId)) return false;
    record.clarification?.cancel().catch((error) => this.#persistenceFailed(record, error));
    record.controller.abort();
    record.control.abort();
    return true;
  }

  async pause(runId, { clientId = "" } = {}) {
    const record = this.#activeRuns.get(String(runId || "")) || this.#startingRuns.get(String(runId || ""));
    if (!record || !clientCanControl(record, clientId)) return false;
    record.control.pause();
    await record.control.flush();
    return true;
  }

  async resume(runId, { clientId = "" } = {}) {
    const record = this.#activeRuns.get(String(runId || "")) || this.#startingRuns.get(String(runId || ""));
    if (!record || !clientCanControl(record, clientId)) return false;
    record.control.resume();
    record.control.resume("quota");
    record.control.resume("quota-wait");
    record.control.resume("provider-budget-wait");
    record.control.resume("daily-budget");
    record.control.resume("no-progress");
    record.control.retryNetwork();
    await record.control.flush();
    return true;
  }

  steer(runId, message, { clientId = "" } = {}) {
    const record = this.#activeRuns.get(String(runId || "")) || this.#startingRuns.get(String(runId || ""));
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
    const record = this.#activeRuns.get(approval.runId);
    if (!record) return false;
    this.#pendingApprovals.delete(approval.approvalId);
    const shouldRemember =
      approved && scope === "run" && Boolean(approval.grantKey);
    const event = { type: "approval.resolved", approval: { id: approval.approvalId, approved, scope }, approved, scope };
    record.journalTail = record.journalTail
      .then(async () => {
        await saveRunCheckpoint(this.#directory(), approval.runId, {
          scopeId: "approval:" + approval.approvalId, phase: "approval-resolved",
          approved, scope, requiresFreshApproval: true,
        });
        await appendRunJournalEvents(this.#directory(), approval.runId, [event]);
        this.#publish(record, event, { journal: false });
        if (shouldRemember) record.approvalGrants.add(approval.grantKey);
        approval.resolve({ approved, remembered: shouldRemember });
      })
      .catch((error) => this.#persistenceFailed(record, error));
    return true;
  }

  async respondClarification(runId, questionId, answer, { clientId = "" } = {}) {
    const record = this.#activeRuns.get(String(runId || ""));
    if (!record || !clientCanControl(record, clientId) || !record.clarification) throw new Error("CLARIFICATION_STALE");
    return record.clarification.respond(questionId, answer);
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
