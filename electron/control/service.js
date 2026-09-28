import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createControlStore } from "./store.js";
import { writePrivateJson } from "./credentials.js";
import { createLocalControlOpenApi } from "./openapi.js";
import {
  ACTIVE_STATES, CONTROL_API_PATH, CONTROL_API_VERSION, CONTROL_PROFILES, DEFAULT_LIMITS,
  TERMINAL_STATES, camelCase, fail, integer, normalizeLimits, object, requestHash,
  snakeCase, stringArray, terminalStatus, text, tokenHash,
} from "./contracts.js";

const MAX_QUEUED = 64;
const MAX_CLIENT_QUEUED = 16;
const MAX_ACTIVE = 4;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const now = () => new Date().toISOString();
const ownedContext = clientId => ({ clientId: `external:${clientId}` });
const within = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const artifactDto = ({ id, name, mimeType, bytes, source, changed, truncated }) => ({
  id, artifactId: id, name, mimeType, bytes, source, ...(changed ? { changed } : {}), ...(truncated ? { truncated } : {}),
});

function safeResult(value) {
  const source = value && typeof value === "object" ? value : { content: String(value ?? "") };
  const result = {};
  // Results may contain runtime-only objects, credentials, and internal handles. Only delivery fields are public.
  for (const key of ["status", "content", "summary", "changes", "workspaceChanges", "steps", "usage", "cumulativeUsage", "usageHistoryComplete", "artifacts", "error", "errorDetails", "warnings", "risks", "verification", "selfCheck", "acceptance", "workspace", "persistence", "controlUsage", "resultStorage", "truncated"])
    if (source[key] !== undefined) result[key] = source[key];
  try {
    const encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded) <= MAX_RESULT_BYTES) return JSON.parse(encoded);
  } catch { /* produce a bounded delivery record below */ }
  return { status: terminalStatus(source), content: String(source.content || source.summary || "").slice(0, 400000),
    changes: [], artifacts: [], truncated: true,
    resultStorage: { version: 1, truncated: true, redacted: source.resultStorage?.redacted === true, maxBytes: MAX_RESULT_BYTES },
    warnings: ["The final delivery exceeded the local API result limit. Read task events and workspace artifacts for details."] };
}
function publicProviders(value) {
  const rows = Array.isArray(value) ? value : value?.providers || [];
  return rows.filter(provider => provider && typeof provider.id === "string").map(provider => ({
    id: provider.id, name: String(provider.name || provider.label || provider.id),
    models: (Array.isArray(provider.models) ? provider.models : []).map(model => typeof model === "string"
      ? { id: model, name: model } : { id: String(model.id || model.modelId || ""), name: String(model.name || model.label || model.id || "") }).filter(model => model.id),
    ...(typeof provider.available === "boolean" ? { available: provider.available } : {}),
  }));
}
function normalizeAnswer(answer) {
  if (typeof answer === "string") return { text: text(answer, "answer", 4000) };
  object(answer, ["optionId", "text"], "answer");
  if (answer.optionId !== undefined) {
    if (answer.text !== undefined) fail(400, "invalid_answer", "Specify optionId or text, not both.");
    return { optionId: text(answer.optionId, "optionId", 100) };
  }
  return { text: text(answer.text, "answer.text", 4000) };
}

export async function createLocalControlService({
  dataDirectory, taskRuntime, startRun, steerRun, listProviders = () => [], onRunCreated = null,
  connectionDirectory = "", maxActiveRuns = MAX_ACTIVE,
} = {}) {
  const directory = join(typeof dataDirectory === "function" ? dataDirectory() : dataDirectory, "local-control");
  if (!taskRuntime || typeof startRun !== "function") throw new TypeError("Local control requires a task runtime and task starter.");
  const store = await createControlStore(directory);
  const instanceId = randomUUID();
  const discoveryPath = join(directory, "discovery.json");
  const connectionsPath = connectionDirectory || join(directory, "connections");
  const listeners = new Set();
  const running = new Map();
  const finishing = new Map();
  let enabled = store.setting("enabled", false) === true;
  let endpoint = null;
  let stopped = false;
  let storeClosed = false;
  let pumping = false;
  let initializing = true;
  const globalConcurrentLimit = Math.min(MAX_ACTIVE, Math.max(1, maxActiveRuns));
  const notify = (type, value = {}) => {
    for (const listener of listeners) { try { listener({ type, ...value }); } catch {} }
  };
  const discovery = () => ({ version: CONTROL_API_VERSION, baseUrl: endpoint, apiPath: CONTROL_API_PATH, instanceId, enabled: enabled && !stopped });
  const writeDiscovery = () => writePrivateJson(discoveryPath, discovery());
  const appendEvent = (runId, type, payload = {}) => {
    let safe = payload;
    try {
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized) > MAX_EVENT_BYTES) safe = { truncated: true, preview: serialized.slice(0, MAX_EVENT_BYTES / 2), originalBytes: Buffer.byteLength(serialized) };
      else safe = JSON.parse(serialized);
    } catch { safe = { omitted: true, reason: "unserializable_event" }; }
    const event = store.event(runId, type, safe);
    notify("run.event", { runId, event });
    return event;
  };
  const updateRun = (runId, patch) => {
    const previous = store.run(runId);
    if (!previous) return null;
    const updated = store.updateRun({ ...previous, ...patch, updatedAt: now() });
    notify("run.updated", { runId, run: publicRun(updated) });
    return updated;
  };
  const publicRun = run => {
    const { request, ...publicFields } = run;
    return publicFields;
  };
  const requireEnabled = () => { if (!enabled || stopped) fail(503, "local_control_disabled", "Enable External control in AporiaX desktop settings."); };
  const freshClient = supplied => {
    const client = supplied?.id ? store.client(supplied.id) : null;
    if (!client || client.revokedAt) fail(401, "invalid_client", "The client credential is invalid or revoked.");
    return client;
  };
  const requireRun = (client, runId) => {
    const run = store.run(text(runId, "runId", 100));
    // Missing and unauthorized resources deliberately have identical responses.
    if (!run || client && run.clientId !== client.id) fail(404, "run_not_found", "This run is not available to the client.");
    return run;
  };
  const requireControllable = run => {
    if (TERMINAL_STATES.has(run.status)) fail(409, "run_finished", "The run has finished; create a new run to continue work.");
  };
  const providersFor = async client => (await Promise.resolve(listProviders()).then(publicProviders))
    .filter(provider => !client || client.providerIds.includes(provider.id))
    .map(provider => ({ ...provider, models: provider.models.filter(model => !client?.modelIds?.length || client.modelIds.includes(model.id)) }));

  function virtualArtifacts(run, result) {
    const content = String(result?.content || result?.summary || "");
    const resultJson = JSON.stringify(result, null, 2);
    return [
      ["result", "result.json", "application/json", resultJson],
      ["report", "report.md", "text/markdown", content],
    ].map(([suffix, name, mimeType, value]) => ({ id: `${run.runId}_${suffix}`, runId: run.runId, name, mimeType,
      source: "virtual", value, bytes: Buffer.byteLength(value) }));
  }
  async function collectFileArtifacts(run, result) {
    const artifacts = [];
    let root;
    try { root = await realpath(run.executionWorkspacePath || run.workspacePath); } catch { return artifacts; }
    const candidates = [...(Array.isArray(result?.artifacts) ? result.artifacts : []), ...(Array.isArray(result?.changes) ? result.changes : [])];
    const seen = new Set();
    for (const candidate of candidates.slice(0, 200)) {
      const input = typeof candidate === "string" ? candidate : candidate?.path || candidate?.filePath || candidate?.file;
      if (typeof input !== "string" || !input || input.includes("\0")) continue;
      try {
        const path = await realpath(isAbsolute(input) ? input : resolve(root, input));
        if (!within(root, path) || seen.has(path)) continue;
        const metadata = await stat(path);
        if (!metadata.isFile() || metadata.size > MAX_ARTIFACT_BYTES) continue;
        seen.add(path);
        artifacts.push({ id: `art_${randomUUID()}`, runId: run.runId, name: relative(root, path),
          mimeType: mimeTypeFor(path), source: "file", path, root, bytes: metadata.size,
          mtimeMs: metadata.mtimeMs, ino: String(metadata.ino), dev: String(metadata.dev) });
      } catch { /* nonexistent or inaccessible outputs are not API-readable artifacts */ }
    }
    return artifacts;
  }

  async function finishRun(runId, result) {
    if (storeClosed) return;
    const run = store.run(runId);
    if (!run || TERMINAL_STATES.has(run.status)) return;
    const safe = safeResult(result);
    // Resolve and inspect every file first. A terminal run must never expose an incomplete artifact index.
    const files = await collectFileArtifacts(run, safe);
    const current = store.run(runId);
    if (!current || TERMINAL_STATES.has(current.status)) return;
    // Cancellation and deadlines may arrive while filesystem checks are in progress.
    const status = current.cancelRequestedAt ? (current.error === "duration_limit_exceeded" ? "interrupted" : "cancelled") : terminalStatus(safe);
    safe.status = status;
    const updated = { ...current, status, updatedAt: now(), completedAt: now() };
    store.completeRun(updated, safe, [...virtualArtifacts(updated, safe), ...files]);
    appendEvent(runId, "run.completed", { status, summary: String(safe.summary || safe.content || "").slice(0, 12000) });
    const active = running.get(runId);
    if (active) clearTimeout(active.timer);
    running.delete(runId);
    notify("run.completed", { runId, run: publicRun(updated) });
    queueMicrotask(() => void pump());
  }
  function completeRun(runId, result) {
    if (storeClosed) return Promise.resolve();
    if (finishing.has(runId)) return finishing.get(runId);
    const promise = finishRun(runId, result).finally(() => finishing.delete(runId));
    finishing.set(runId, promise);
    return promise;
  }

  function activeStatus(runId, payload = {}) {
    const active = taskRuntime.getActiveRun?.(runId);
    const questions = payload.questions || active?.clarifications || [];
    if (questions.some(question => question.status === "pending")) return "waiting_question";
    const pauseReasons = active?.pauseReasons || payload.pauseReasons || [];
    if (pauseReasons.some(reason => reason !== "clarification") || active?.paused && !pauseReasons.length) return "paused";
    if (taskRuntime.getPendingApprovals?.(runId)?.length) return "waiting_approval";
    return "running";
  }

  function observeEvent(runId, payload = {}) {
    if (stopped || storeClosed) return;
    const run = store.run(runId);
    if (!run || TERMINAL_STATES.has(run.status)) return;
    const type = typeof payload.type === "string" ? payload.type : "runtime.event";
    appendEvent(runId, type, payload);
    let status = null;
    if (type === "clarification.required") status = "waiting_question";
    if (type === "approval.required" || type === "control.paused") status = activeStatus(runId, payload);
    if (type === "approval.resolved" || type === "control.resumed" || type === "clarification.updated") status = activeStatus(runId, payload);
    if (status && run.status !== "cancelling") updateRun(runId, { status });
    if (type === "local_control.usage" && payload.usage) updateRun(runId, { controlUsage: payload.usage });
  }

  async function begin(run) {
    const client = store.client(run.clientId);
    const workspace = store.workspace(run.workspaceId);
    if (!client || client.revokedAt || !workspace || !client.workspaceIds.includes(workspace.id)) {
      await completeRun(run.runId, { status: "blocked", error: "authorization_revoked", content: "The client or workspace authorization was revoked before execution." });
      return;
    }
    const controller = new AbortController();
    const deadlineAt = new Date(Date.now() + run.limits.maxDurationSeconds * 1000).toISOString();
    const active = { controller, timer: null };
    running.set(run.runId, active);
    updateRun(run.runId, { status: "starting", startedAt: now(), deadlineAt });
    active.timer = setTimeout(() => {
      const current = store.run(run.runId);
      if (!current || TERMINAL_STATES.has(current.status)) return;
      updateRun(run.runId, { cancelRequestedAt: now(), status: "cancelling", error: "duration_limit_exceeded" });
      controller.abort();
      taskRuntime.interrupt(run.runId, ownedContext(client.id));
      appendEvent(run.runId, "run.deadline_exceeded", { deadlineAt });
    }, run.limits.maxDurationSeconds * 1000);
    active.timer.unref?.();
    try {
      const canonicalWorkspace = await realpath(workspace.path);
      if (canonicalWorkspace !== workspace.path) fail(409, "workspace_changed", "The workspace location changed. Register it again in desktop settings.");
      if (controller.signal.aborted) throw Object.assign(new Error("Run cancelled during preparation."), { name: "AbortError" });
      const permissionProfile = CONTROL_PROFILES.find(profile => profile.id === run.profile).permissionProfile;
      const preparedRequest = {
        runId: run.runId, taskId: run.taskId, prompt: run.instruction, instruction: run.instruction,
        workspacePath: workspace.path, providerId: run.providerId, modelId: run.modelId,
        externalControl: {
          clientId: client.id, permissionProfile, workspaceRoot: workspace.path,
          capabilities: { ...client.capabilities }, allowedMcpServerIds: [...client.allowedMcpServerIds],
          allowedProviderIds: [...client.providerIds], allowedModelIds: [...client.modelIds],
          limits: { ...run.limits }, deadlineAt,
        },
      };
      const onPrepared = async ({ workspacePath, workspace: executionWorkspace } = {}) => {
        if (stopped || storeClosed) return;
        if (typeof workspacePath !== "string" || !workspacePath) return;
        const trustedRoot = await realpath(workspacePath);
        if (!(await stat(trustedRoot)).isDirectory()) fail(500, "invalid_execution_workspace", "The execution workspace is not a directory.");
        updateRun(run.runId, { executionWorkspacePath: trustedRoot,
          ...(executionWorkspace ? { executionWorkspace } : {}) });
      };
      const descriptor = await startRun(preparedRequest, {
        ...ownedContext(client.id), detached: true, signal: controller.signal,
        onEvent: event => {
          try { return observeEvent(run.runId, event); }
          catch (error) { failPersistence(run.runId, error); throw error; }
        }, onPrepared,
        onResult: delivery => completeRun(run.runId, delivery?.result ?? delivery).catch(error => failPersistence(run.runId, error)),
      });
      if (descriptor?.workspacePath) await onPrepared(descriptor);
      const current = store.run(run.runId);
      if (current && !TERMINAL_STATES.has(current.status)) {
        if (current.cancelRequestedAt || controller.signal.aborted) taskRuntime.interrupt(run.runId, ownedContext(client.id));
        else if (current.status === "starting") updateRun(run.runId, { status: "running" });
      }
      // Test/embedded starters may return a result directly instead of a detached descriptor.
      if (descriptor && !descriptor.runId && (descriptor.content !== undefined || TERMINAL_STATES.has(descriptor.status)))
        await completeRun(run.runId, descriptor);
    } catch (error) {
      await completeRun(run.runId, { status: controller.signal.aborted ? "interrupted" : "failed",
        error: String(error.code || (controller.signal.aborted ? "run_cancelled" : "start_failed")),
        content: String(error.message || "The task could not start.").slice(0, 12000) });
    }
  }

  function failPersistence(runId, error) {
    if (stopped || storeClosed) return;
    for (const [id, active] of running) {
      active.controller.abort();
      try { taskRuntime.interrupt(id); } catch {}
    }
    notify("control.error", { runId, message: "Cannot persist local control task state. Execution was stopped.", code: "persistence_failed" });
    // Do not continue accepting tasks after a durable write failure.
    enabled = false;
    try { store.setSetting("enabled", false); } catch {}
    void writeDiscovery().catch(() => {});
  }
  async function pump() {
    if (pumping || !enabled || stopped || initializing) return;
    pumping = true;
    try {
      for (const run of store.unfinished().filter(item => item.status === "queued")) {
        if (running.size >= globalConcurrentLimit) break;
        const client = store.client(run.clientId);
        const count = [...running.keys()].filter(id => store.run(id)?.clientId === run.clientId).length;
        if (client && count >= client.maxConcurrentRuns) continue;
        // begin registers itself synchronously before its first await; concurrent pumping cannot duplicate it.
        void begin(run).catch(error => failPersistence(run.runId, error));
      }
    } finally { pumping = false; }
  }

  async function createRun(client, input) {
    object(input, ["instruction", "workspaceId", "profile", "providerId", "modelId", "idempotencyKey", "limits"]);
    const workspaceId = text(input.workspaceId, "workspace_id", 100);
    const profile = text(input.profile, "profile", 50);
    const instruction = text(input.instruction, "instruction", 60000);
    const key = text(input.idempotencyKey, "idempotency_key", 160);
    if (!/^[\w.:-]+$/.test(key)) fail(400, "invalid_request", "idempotency_key must use letters, digits, underscore, dash, colon, or dot.");
    const requestedProviderId = text(input.providerId, "provider_id", 200, { optional: true });
    const requestedModelId = text(input.modelId, "model_id", 200, { optional: true });
    const limits = normalizeLimits(input.limits || {}, client.limits, client.limits);
    // Hash caller intent before resolving mutable provider defaults. A lost response can be retried after a settings change.
    const hash = requestHash({ instruction, workspaceId, profile, providerId: requestedProviderId, modelId: requestedModelId, limits });
    const prior = store.findRun(client.id, key);
    if (prior) {
      if (prior.hash !== hash) fail(409, "idempotency_conflict", "This idempotency key already belongs to a different request.");
      if (prior.run.status === "queued") queueMicrotask(() => void pump());
      return { ...publicRun(prior.run), idempotentReplay: true };
    }
    if (!client.workspaceIds.includes(workspaceId) || !client.profiles.includes(profile)) fail(403, "scope_denied", "This workspace or profile was not granted to the client.");
    const workspace = store.workspace(workspaceId);
    if (!workspace) fail(404, "workspace_not_found", "The workspace is no longer registered.");
    const providers = await providersFor(client);
    const providerId = requestedProviderId || providers.find(provider => provider.available !== false)?.id || "";
    if (!providerId || !client.providerIds.includes(providerId)) fail(403, "provider_denied", "Select an authorized provider configured in AporiaX.");
    const provider = providers.find(item => item.id === providerId);
    if (!provider || provider.available === false) fail(409, "provider_unavailable", "The selected provider is not currently available.");
    const modelId = requestedModelId || provider.models[0]?.id || "";
    if (client.modelIds.length && (!modelId || !client.modelIds.includes(modelId))) fail(403, "model_denied", "This model was not granted to the client.");
    if (modelId && provider.models.length && !provider.models.some(model => model.id === modelId)) fail(400, "unknown_model", "The model is not listed for this provider.");
    const request = { instruction, workspaceId, profile, providerId, modelId, limits };
    // Provider enumeration is asynchronous. Recheck both revocation and dedupe immediately before committing.
    freshClient(client);
    const concurrent = store.findRun(client.id, key);
    if (concurrent) {
      if (concurrent.hash !== hash) fail(409, "idempotency_conflict", "This idempotency key already belongs to a different request.");
      return { ...publicRun(concurrent.run), idempotentReplay: true };
    }
    const unfinished = store.unfinished();
    if (unfinished.filter(run => run.status === "queued").length >= MAX_QUEUED || unfinished.filter(run => run.clientId === client.id && run.status === "queued").length >= MAX_CLIENT_QUEUED)
      fail(429, "queue_full", "The task queue is full. Wait for an existing run before creating another.");
    const run = {
      runId: `run_${randomUUID()}`, taskId: `external_${randomUUID()}`, clientId: client.id, clientName: client.name,
      workspaceId, workspacePath: workspace.path, executionWorkspacePath: workspace.path,
      profile, instruction, providerId, modelId, limits, status: "queued", createdAt: now(), updatedAt: now(),
      startedAt: null, completedAt: null, request,
    };
    // The ID and normalized request are committed before any model, tool, or workspace work starts.
    store.insertRun(run, key, hash);
    appendEvent(run.runId, "run.queued", { instruction, profile, workspaceId, clientId: client.id });
    try { await onRunCreated?.(publicRun(run)); } catch { /* GUI observers cannot undo a committed task */ }
    notify("run.created", { runId: run.runId, run: publicRun(run) });
    queueMicrotask(() => void pump());
    return publicRun(run);
  }

  async function cancel(run, reason = "client_cancelled") {
    if (TERMINAL_STATES.has(run.status)) return { ok: true, status: run.status };
    const updated = updateRun(run.runId, { cancelRequestedAt: now(), status: run.status === "queued" ? "queued" : "cancelling", cancellationReason: reason });
    appendEvent(run.runId, "run.cancel_requested", { reason });
    if (run.status === "queued") await completeRun(run.runId, { status: "cancelled", content: "The queued task was cancelled before execution." });
    else {
      running.get(run.runId)?.controller.abort();
      taskRuntime.interrupt(run.runId, ownedContext(run.clientId));
    }
    return { ok: true, status: store.run(updated.runId).status };
  }
  async function controlRun(run, action) {
    if (action === "cancel") return cancel(run);
    requireControllable(run);
    if (run.status === "queued" || run.status === "starting") fail(409, "run_not_ready", "The run is still preparing. It can be cancelled now.");
    const ok = await taskRuntime[action](run.runId, ownedContext(run.clientId));
    if (!ok) fail(409, "run_not_active", "The task is not active in the desktop runtime.");
    updateRun(run.runId, { status: action === "pause" ? "paused" : activeStatus(run.runId) });
    appendEvent(run.runId, `run.${action}_requested`, {});
    return { ok: true };
  }
  async function sendMessage(run, content) {
    requireControllable(run);
    content = text(content, "content", 60000);
    if (run.status === "queued" || run.status === "starting") fail(409, "run_not_ready", "Wait until the run starts before sending guidance.");
    const message = { id: randomUUID(), role: "user", content, createdAt: now() };
    const context = ownedContext(run.clientId);
    const accepted = await (steerRun ? steerRun(run.runId, message, context) : taskRuntime.steer(run.runId, message, context));
    if (!accepted) fail(409, "run_not_active", "The task cannot accept guidance right now.");
    appendEvent(run.runId, "message.sent", { message });
    return { ok: true, messageId: message.id };
  }
  async function answerQuestion(run, questionId, answer) {
    requireControllable(run);
    const value = normalizeAnswer(answer);
    const accepted = await taskRuntime.respondClarification(run.runId, text(questionId, "questionId", 100), value, ownedContext(run.clientId));
    appendEvent(run.runId, "question.answered", { questionId, answer: value });
    return { ok: true, ...(accepted && typeof accepted === "object" ? accepted : {}) };
  }
  function questions(run) {
    const active = taskRuntime.getActiveRun?.(run.runId);
    return { questions: active?.clarifications || store.latestEvent(run.runId, "clarification.updated")?.questions || store.latestEvent(run.runId, "clarification.required")?.questions || [] };
  }
  function approvals(run) {
    return { approvals: (taskRuntime.getPendingApprovals?.(run.runId) || []).map(item => ({ approvalId: item.approvalId, runId: item.runId, approval: item.approval })) };
  }
  function agents(run) {
    const found = new Map();
    let afterSeq = 0, hasMore = true;
    while (hasMore) {
      const page = store.events(run.runId, { afterSeq, limit: 1000 });
      for (const event of page.events) {
        const payload = event.payload;
        const agent = payload.agent || payload.session;
        const id = agent?.id || agent?.agentId || payload.agentId;
        if (typeof id !== "string" || !id) continue;
        const previous = found.get(id) || { id };
        found.set(id, { ...previous, id, role: String(agent?.role || payload.role || previous.role || ""),
          name: String(agent?.name || payload.agentName || previous.name || id),
          status: String(agent?.status || payload.status || previous.status || "active"), lastEventType: event.type, updatedAt: event.at });
      }
      afterSeq = page.nextSeq; hasMore = page.hasMore;
    }
    return { agents: [...found.values()] };
  }

  async function readArtifact(run, artifactId, query = {}) {
    const artifact = store.artifact(text(artifactId, "artifactId", 160));
    if (!artifact || artifact.runId !== run.runId) fail(404, "artifact_not_found", "The artifact is not available for this run.");
    const offset = integer(query.offset, "offset", 0, 0, MAX_ARTIFACT_BYTES);
    const limit = integer(query.limit, "limit", 65536, 1, 65536);
    let bytes;
    if (artifact.source === "virtual") bytes = Buffer.from(artifact.value, "utf8");
    else {
      const root = await realpath(run.executionWorkspacePath || run.workspacePath).catch(() => null);
      const path = await realpath(artifact.path).catch(() => null);
      if (!root || root !== artifact.root || !path || path !== artifact.path || !within(root, path))
        fail(409, "artifact_changed", "The artifact path changed since the task completed.");
      let handle;
      try {
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const metadata = await handle.stat();
        const checkedPath = await realpath(artifact.path);
        const checkedMetadata = await stat(checkedPath);
        if (checkedPath !== path || !within(root, checkedPath) || !metadata.isFile() || metadata.size > MAX_ARTIFACT_BYTES ||
            metadata.size !== artifact.bytes || metadata.mtimeMs !== artifact.mtimeMs || String(metadata.ino) !== artifact.ino || String(metadata.dev) !== artifact.dev ||
            metadata.ino !== checkedMetadata.ino || metadata.dev !== checkedMetadata.dev)
          fail(409, "artifact_changed", "The artifact changed since the task completed; request a new review before reading it.");
        if (offset > metadata.size) fail(400, "invalid_offset", "Offset is beyond the artifact length.");
        bytes = Buffer.alloc(Math.min(limit, metadata.size - offset));
        const read = await handle.read(bytes, 0, bytes.length, offset);
        bytes = bytes.subarray(0, read.bytesRead);
      } finally { await handle?.close(); }
    }
    const totalBytes = artifact.bytes;
    if (offset > totalBytes) fail(400, "invalid_offset", "Offset is beyond the artifact length.");
    const chunk = artifact.source === "virtual" ? bytes.subarray(offset, Math.min(totalBytes, offset + limit)) : bytes;
    // Bytes use base64 for exact pagination, including slices through multibyte UTF-8 characters.
    return { artifactId: artifact.id, name: artifact.name, mimeType: artifact.mimeType,
      encoding: "base64", content: chunk.toString("base64"), offset, nextOffset: offset + chunk.length,
      totalBytes, hasMore: offset + chunk.length < totalBytes };
  }

  async function resultFor(run) {
    return { runId: run.runId, status: run.status, result: store.result(run.runId), artifacts: store.artifacts(run.runId).map(artifactDto) };
  }
  const eventPage = (run, query) => store.events(run.runId, {
    afterSeq: integer(query.afterSeq, "after_seq", 0, 0, Number.MAX_SAFE_INTEGER),
    limit: integer(query.limit, "limit", 200, 1, 1000),
  });

  const unsubscribeFinished = taskRuntime.subscribeRunFinished?.(delivery => {
    if (!delivery?.runId || !store.run(delivery.runId)) return;
    void completeRun(delivery.runId, delivery.result).catch(error => failPersistence(delivery.runId, error));
  });
  // A restart never silently replays unfinished work or reuses an old approval.
  for (const run of store.unfinished()) {
    let persisted = null;
    try { persisted = await taskRuntime.getRunResult?.(run.runId); } catch {}
    await completeRun(run.runId, persisted || { status: "interrupted", content: "AporiaX stopped before this task completed. Review its events and workspace before creating a follow-up task.", error: "desktop_restarted" });
  }
  await writeDiscovery();
  initializing = false;

  const service = {
    get enabled() { return enabled && !stopped; },
    get discoveryPath() { return discoveryPath; },
    get instanceId() { return instanceId; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async setEndpoint(url) { endpoint = url || null; await writeDiscovery(); notify("control.updated"); },
    authenticate(token) {
      requireEnabled();
      if (typeof token !== "string" || !/^apx_client_[a-f0-9]{64}$/.test(token)) fail(401, "unauthorized", "A valid local client Bearer token is required.");
      const client = store.clientForToken(tokenHash(token));
      return freshClient(client);
    },
    async dispatch(suppliedClient, method, pathname, query = {}, body = {}) {
      requireEnabled();
      const client = freshClient(suppliedClient);
      const parts = pathname.slice(CONTROL_API_PATH.length).split("/").filter(Boolean);
      if (!pathname.startsWith(CONTROL_API_PATH + "/") && pathname !== CONTROL_API_PATH) fail(404, "not_found", "Unknown local control endpoint.");
      let value;
      if (method === "GET" && parts.length === 1) {
        // OpenAPI uses reserved camelCase keys; do not pass the document through application DTO conversion.
        if (parts[0] === "openapi") return createLocalControlOpenApi({ baseUrl: endpoint });
        if (parts[0] === "meta") value = { apiVersion: CONTROL_API_VERSION, name: "AporiaX local control", instanceId, clientId: client.id,
          openapiPath: `${CONTROL_API_PATH}/openapi`,
          capabilities: { durableRuns: true, events: true, artifacts: true, steering: true, clarification: true, approvals: "desktop_only", transports: ["http", "mcp-stdio"] }, limits: client.limits };
        if (parts[0] === "workspaces") value = { workspaces: store.workspaces().filter(workspace => client.workspaceIds.includes(workspace.id)) };
        if (parts[0] === "profiles") value = { profiles: CONTROL_PROFILES.filter(profile => client.profiles.includes(profile.id)) };
        if (parts[0] === "providers") value = { providers: await providersFor(client) };
        if (parts[0] === "runs") {
          const limit = integer(query.limit, "limit", 100, 1, 200);
          const before = text(query.before, "before", 100, { optional: true });
          if (before) requireRun(client, before);
          const rows = store.runs({ clientId: client.id, limit: limit + 1, before });
          const runs = rows.slice(0, limit).map(publicRun);
          value = { runs, nextBefore: runs.at(-1)?.runId || null, hasMore: rows.length > limit };
        }
      } else if (method === "POST" && parts.length === 1 && parts[0] === "runs") {
        object(body, ["instruction", "workspace_id", "profile", "provider_id", "model_id", "idempotency_key", "limits"]);
        if (body.limits !== undefined) object(body.limits, ["max_duration_seconds", "max_model_calls", "max_tool_calls", "max_parallel_agents", "max_subagents"], "limits");
        value = await createRun(client, camelCase(body));
      }
      if (value === undefined && parts[0] === "runs" && parts[1]) {
        const run = requireRun(client, parts[1]);
        const action = parts[2];
        if (method === "GET" && parts.length === 2) value = publicRun(run);
        if (method === "GET" && parts.length === 3) {
          if (action === "result") value = await resultFor(run);
          if (action === "events") value = eventPage(run, camelCase(query));
          if (action === "agents") value = agents(run);
          if (action === "questions") value = questions(run);
          if (action === "approvals") value = approvals(run);
          if (action === "artifacts") value = { artifacts: store.artifacts(run.runId).map(artifactDto) };
        }
        if (method === "GET" && parts.length === 4 && action === "artifacts") value = await readArtifact(run, parts[3], query);
        if (method === "POST" && parts.length === 3) {
          if (["pause", "resume", "cancel"].includes(action)) { object(body, []); value = await controlRun(run, action); }
          if (action === "messages") { object(body, ["content"]); value = await sendMessage(run, body.content); }
        }
        if (method === "POST" && parts.length === 5 && action === "questions" && parts[4] === "answer") {
          object(body, ["answer"]); value = await answerQuestion(run, parts[3], camelCase(body.answer));
        }
        if (method !== "GET" && action === "approvals") fail(403, "human_approval_required", "Tool approvals can only be answered in the AporiaX desktop by the user.");
      }
      if (value === undefined) fail(404, "not_found", "Unknown local control endpoint or method.");
      return snakeCase(value);
    },
    async admin(action, input = {}) {
      if (stopped) fail(503, "local_control_stopped", "Local control is shutting down.");
      if (action === "status") return { enabled, endpoint, instanceId, discoveryPath,
        workspaces: store.workspaces(), clients: store.clients(), runs: store.runs({ limit: 100 }).map(publicRun),
        profiles: CONTROL_PROFILES, providers: await providersFor(null), limits: DEFAULT_LIMITS,
        queue: { maxQueued: MAX_QUEUED, maxClientQueued: MAX_CLIENT_QUEUED, maxActive: globalConcurrentLimit } };
      if (action === "setEnabled") {
        object(input, ["enabled"]);
        if (typeof input.enabled !== "boolean") fail(400, "invalid_request", "enabled must be boolean.");
        enabled = input.enabled; store.setSetting("enabled", enabled);
        if (!enabled) for (const run of store.unfinished()) await cancel(run, "control_disabled");
        await writeDiscovery(); if (enabled) void pump(); notify("control.updated"); return { enabled };
      }
      if (action === "registerWorkspace") {
        object(input, ["path", "label"]);
        const path = await realpath(text(input.path, "path", 4096));
        if (!(await stat(path)).isDirectory()) fail(400, "invalid_workspace", "Select a workspace directory.");
        const previous = store.workspaces().find(workspace => workspace.path === path);
        const workspace = { id: previous?.id || `ws_${randomUUID()}`, path, label: text(input.label, "label", 200, { optional: true }) || basename(path), createdAt: previous?.createdAt || now() };
        store.putWorkspace(workspace); notify("control.updated"); return workspace;
      }
      if (action === "removeWorkspace") {
        object(input, ["workspaceId"]); const id = text(input.workspaceId, "workspaceId", 100);
        if (store.unfinished().some(run => run.workspaceId === id)) fail(409, "workspace_busy", "Cancel active tasks before removing this workspace.");
        store.removeWorkspace(id); notify("control.updated"); return { ok: true };
      }
      if (action === "createClient") {
        object(input, ["name", "workspaceIds", "profiles", "providerIds", "modelIds", "capabilities", "allowedMcpServerIds", "limits", "maxConcurrentRuns"]);
        const name = text(input.name, "name", 100);
        const workspaceIds = stringArray(input.workspaceIds, "workspaceIds");
        if (workspaceIds.some(id => !store.workspace(id))) fail(400, "unknown_workspace", "Register every granted workspace first.");
        const profiles = stringArray(input.profiles, "profiles", { max: CONTROL_PROFILES.length });
        if (profiles.some(id => !CONTROL_PROFILES.some(profile => profile.id === id))) fail(400, "unknown_profile", "Unknown agent profile.");
        const providerIds = stringArray(input.providerIds, "providerIds");
        const available = await providersFor(null);
        if (providerIds.some(id => !available.some(provider => provider.id === id))) fail(400, "unknown_provider", "Select a configured provider.");
        const modelIds = stringArray(input.modelIds, "modelIds", { optional: true });
        const capabilities = { commands: false, browser: false, mcp: false };
        if (input.capabilities) {
          object(input.capabilities, Object.keys(capabilities), "capabilities");
          for (const key of Object.keys(capabilities)) {
            if (input.capabilities[key] !== undefined && typeof input.capabilities[key] !== "boolean") fail(400, "invalid_request", "Capability grants must be boolean.");
            capabilities[key] = input.capabilities[key] === true;
          }
        }
        const allowedMcpServerIds = stringArray(input.allowedMcpServerIds, "allowedMcpServerIds", { optional: true });
        if (capabilities.mcp && !allowedMcpServerIds.length) fail(400, "missing_mcp_allowlist", "Select explicit MCP server IDs before enabling MCP tools.");
        const client = { id: `client_${randomUUID()}`, name, workspaceIds, profiles, providerIds, modelIds, capabilities,
          allowedMcpServerIds, limits: normalizeLimits(input.limits || {}),
          maxConcurrentRuns: integer(input.maxConcurrentRuns, "maxConcurrentRuns", 1, 1, MAX_ACTIVE), createdAt: now(), revokedAt: null };
        const token = `apx_client_${randomBytes(32).toString("hex")}`;
        const connectionFile = join(connectionsPath, `${client.id}.json`);
        await writePrivateJson(connectionFile, { version: CONTROL_API_VERSION, clientId: client.id, token, discoveryPath });
        try { store.putClient({ ...client, connectionFile }, tokenHash(token)); }
        catch (error) { await rm(connectionFile, { force: true }); throw error; }
        notify("control.updated"); return { client, token, connectionFile, discoveryPath };
      }
      if (action === "revokeClient") {
        object(input, ["clientId"]); const client = store.client(text(input.clientId, "clientId", 100));
        if (!client) fail(404, "client_not_found", "The client does not exist.");
        if (!client.revokedAt) {
          store.putClient({ ...client, revokedAt: now() });
          for (const run of store.unfinished().filter(run => run.clientId === client.id)) await cancel(run, "client_revoked");
          if (client.connectionFile) await rm(client.connectionFile, { force: true }).catch(() => {});
        }
        notify("control.updated"); return { ok: true };
      }
      if (action === "listRuns") return { runs: store.runs({ limit: integer(input.limit, "limit", 100, 1, 200), before: input.before || "" }).map(publicRun) };
      const runActions = ["getRun", "getEvents", "getResult", "getAgents", "getQuestions", "getApprovals", "getArtifacts", "pauseRun", "resumeRun", "cancelRun", "answerQuestion", "respondApproval", "sendMessage"];
      if (runActions.includes(action)) {
        const run = requireRun(null, input.runId);
        if (action === "getRun") return publicRun(run);
        if (action === "getEvents") return eventPage(run, input);
        if (action === "getResult") return resultFor(run);
        if (action === "getAgents") return agents(run);
        if (action === "getQuestions") return questions(run);
        if (action === "getApprovals") return approvals(run);
        if (action === "getArtifacts") return { artifacts: store.artifacts(run.runId).map(artifactDto) };
        if (action === "sendMessage") return sendMessage(run, input.content);
        if (action === "answerQuestion") return answerQuestion(run, input.questionId, input.answer);
        if (["pauseRun", "resumeRun", "cancelRun"].includes(action)) return controlRun(run, action.replace("Run", ""));
        if (action === "respondApproval") {
          requireControllable(run);
          if (typeof input.approved !== "boolean" || !["once", "run"].includes(input.scope || "once")) fail(400, "invalid_approval", "Invalid approval decision.");
          const accepted = taskRuntime.respondApproval(run.runId, text(input.approvalId, "approvalId", 100), {
            approved: input.approved, scope: input.scope || "once", ...ownedContext(run.clientId),
          });
          if (!accepted) fail(409, "approval_stale", "This approval is no longer pending.");
          appendEvent(run.runId, "approval.answered_by_user", { approvalId: input.approvalId, approved: input.approved, scope: input.scope || "once" });
          updateRun(run.runId, { status: activeStatus(run.runId) }); return { ok: true };
        }
      }
      fail(400, "unknown_admin_action", "Unknown desktop control action.");
    },
    async shutdown() {
      if (stopped) return;
      stopped = true;
      unsubscribeFinished?.();
      for (const run of store.unfinished()) {
        running.get(run.runId)?.controller.abort();
        taskRuntime.interrupt(run.runId, ownedContext(run.clientId));
        await completeRun(run.runId, { status: "interrupted", error: "desktop_shutdown", content: "AporiaX shut down before the task completed. Its recorded work has been retained." });
      }
      await Promise.allSettled([...finishing.values()]);
      for (const active of running.values()) { active.controller.abort(); clearTimeout(active.timer); }
      running.clear();
      endpoint = null; await writeDiscovery(); listeners.clear(); storeClosed = true; store.close();
    },
  };
  return service;
}

function mimeTypeFor(path) {
  const ext = path.split(".").at(-1)?.toLowerCase();
  return ({ md: "text/markdown", txt: "text/plain", json: "application/json", csv: "text/csv", html: "text/html", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", diff: "text/x-diff", patch: "text/x-diff" })[ext] || "application/octet-stream";
}
