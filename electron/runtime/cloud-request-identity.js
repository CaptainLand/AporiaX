import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { runtimeRecoveryCheckpoint, runtimeRecoveryContext, runtimeRequestTrace, saveRuntimeCheckpoint, saveRuntimeContext } from "./durable-run.js";

// One identity per logical inference, not per provider invocation. Async-local
// isolation prevents concurrently running Builders from borrowing Main's key.
const storage = new AsyncLocalStorage();
const uuid = () => randomUUID();
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fresh = () => ({ logicalRequestId: uuid(), clientRequestId: uuid(), status: "new" });
export function createLoopRequestIdentity(scopeId) {
  const checkpointScope = `cloud-request:${scopeId}`;
  const saved = runtimeRecoveryCheckpoint(checkpointScope);
  const response = runtimeRecoveryContext(`cloud-response:${scopeId}`);
  const identity = saved?.identity ? { ...saved.identity } : fresh();
  const matches = response?.clientRequestId === identity.clientRequestId;
  return { scopeId, checkpointScope, identity, result: matches ? response.result : null, draft: matches ? response.draft : null };
}
export const withLoopRequestIdentity = (state, fn) => storage.run(state, fn);
export const currentLoopRequestIdentity = () => storage.getStore();
export async function rememberModelResponseRecovery(state, recovery) {
  if (!state) return;
  state.identity.modelResponseRecovery = { attempt: recovery.attempt, responseId: recovery.responseId,
    receivedModelData: recovery.receivedModelData === true };
  await persist(state);
}
export async function createRepairRequestIdentity(previous, { corrections, compactions, outputTokenLimit, repairState = previous.identity.repairState }) {
  const state = { scopeId: previous.scopeId, checkpointScope: previous.checkpointScope, result: null,
    identity: { ...fresh(), repairCount: corrections, compactions, repairMaxTokens: outputTokenLimit, repairState,
      ...(previous.identity.continuationId ? { continuationId: previous.identity.continuationId } : {}),
      ...(previous.identity.serverRequestId ? { retryOf: previous.identity.serverRequestId } : {}) } };
  // Persist the consumed repair budget before another paid inference can start.
  await persist(state);
  return state;
}
export async function rememberSuccessfulLoopRequest(state) {
  if (!state.identity.repairCount && !state.identity.compactions && !state.identity.repairState) return;
  // Keep the exact wire token limit for a completed-but-not-yet-consumed receipt.
  // Clearing it here changes the request fingerprint after a crash and could
  // turn replay of a saved result into another paid generation.
  Object.assign(state.identity, { repairCount: 0, compactions: 0, repairState: null });
  await persist(state);
}
async function persist(state) {
  if (state) await saveRuntimeCheckpoint({ scopeId: state.checkpointScope, phase: "cloud-request", identity: { ...state.identity } });
}
export async function rememberCloudQuotaPause(state, quota) {
  if (quota) state.identity.quotaPause = quota;
  else {
    if (state.identity.quotaPause?.afterResponse) state.identity.quotaResponseAcknowledged = true;
    delete state.identity.quotaPause;
  }
  await persist(state);
}
export function reconcileError(state, reason) {
  const error = new Error(`Aporia Cloud 原请求结果需要核对（${state.identity.serverRequestId || state.identity.clientRequestId}）：${reason}。已保留请求身份，未自动发起第二次付费生成。`);
  return Object.assign(error, { code: "CLOUD_REQUEST_RECONCILIATION_REQUIRED", retryable: false, safeToRepair: false,
    cloudRequestId: state.identity.serverRequestId || null });
}
const providerBinding = provider => createHash('sha256').update(JSON.stringify([provider.id, provider.baseUrl])).digest('hex');
const matchesNoDispatch = receipt => receipt?.usageState === 'not-dispatched' && receipt.billing === 'released' &&
  receipt.chargedMicros === 0 && !receipt.accountingPending &&
  !['completed', 'queued', 'running', 'active', 'processing', 'dispatching'].includes(receipt.status);
async function readCloudRecovery(state, provider, path, signal, timeoutMs) {
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    return await provider.authenticatedFetch(path, { method: 'GET', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw reconcileError(state, error?.message === 'DESKTOP_ACCOUNT_SIGNED_OUT'
      ? '请重新登录 Aporia Cloud 后再继续核对原请求' : '暂时无法读取原请求的状态或回复，请稍后继续');
  }
}
async function parseCloudRecovery(state, response) {
  try { return await response.json(); }
  catch { throw reconcileError(state, '原请求回执无法读取，请稍后继续'); }
}

// Only recorded for the first dispatch of a fresh key, from the gateway's
// explicit pre-inference auth rejection. A timeout, plain 401 or 404 alone is not proof.
export async function rememberCloudAuthRejection(state) {
  if (!state) return;
  state.identity.preDispatchAuthRejected = true;
  await persist(state);
}
// A finish frame is not proof of settlement. Keep this candidate only on the
// desktop, outside tool execution. Never promote partial text/tool arguments.
export async function saveCloudCandidate(state, requestId, message, finishReason, usage) {
  if (!state || !requestId || requestId !== state.identity.serverRequestId || !["stop", "tool_calls"].includes(finishReason)) return;
  const calls = message.tool_calls || [];
  if ((!calls.length && (!message.content?.trim() || finishReason === "tool_calls")) ||
      new Set(calls.map(c => c.id)).size !== calls.length || calls.some(c => {
        try { const args = JSON.parse(c.function.arguments); return !c.id || !c.function.name || !args || typeof args !== "object" || Array.isArray(args); }
        catch { return true; }
      })) return;
  const draft = { requestId, message: structuredClone(message), finishReason, usage };
  await saveRuntimeContext(`cloud-response:${state.scopeId}`, { clientRequestId: state.identity.clientRequestId, draft });
  state.draft = draft;
}
export async function restoreCloudCandidate(state, receipt, recoveredForFingerprint) {
  const draft = state?.draft;
  if (!draft || draft.requestId !== state.identity.serverRequestId || receipt?.requestId !== draft.requestId ||
      receipt.status !== "completed" || receipt.billing !== "settled" || !["provider","reconciled"].includes(receipt.usageState) ||
      receipt.finishReason !== draft.finishReason) return null;
  const usage = receipt.usage ? { prompt_tokens: receipt.usage.inputTokens, completion_tokens: receipt.usage.outputTokens,
    total_tokens: receipt.usage.inputTokens + receipt.usage.outputTokens, prompt_cache_hit_tokens: receipt.usage.cachedInputTokens } : draft.usage;
  const result = { message: draft.message, finishReason: draft.finishReason, usage, attemptUsage: usage, streamComplete: true,
    ...(receipt.quota ? {cloudQuotaSnapshot:receipt.quota} : {}), ...(receipt.quota?.policy === 'actual-usage-v1' && receipt.quota.exhausted === true &&
      Number.isSafeInteger(receipt.quota.remainingMicros) && receipt.quota.remainingMicros <= 0 ? {cloudQuota:{temporary:false,reason:"quota",afterResponse:true}} : {}) };
  await rememberCloudResult(state, result, recoveredForFingerprint);
  return result;
}
export function cloudRequestFingerprint(provider, body) {
  return createHash("sha256").update(JSON.stringify(canonical({ provider: provider.id,
    endpoint: provider.baseUrl, body }))).digest("hex");
}
export async function prepareCloudRequest(state, provider, body, requestTrace, signal) {
  const fingerprint = cloudRequestFingerprint(provider, body);
  const binding = providerBinding(provider);
  const differs = () => Boolean(state.identity.fingerprint && state.identity.fingerprint !== fingerprint);
  if (state.result && differs() && !state.identity.reconciledFingerprint) {
    // Confirmed history after a completed request is a new logical inference.
    state.identity = fresh(); state.result = null; state.draft = null;
  }
  const identity = state.identity;
  if (!identity.fingerprint) Object.assign(identity, runtimeRequestTrace(), requestTrace, { fingerprint, providerBinding: binding });
  if (identity.providerBinding && identity.providerBinding !== binding)
    throw reconcileError(state, 'Cloud 接入地址已变化，请切回原接入核对未完成的请求');
  if (state.result) return { trace: identity, result: state.result };
  const recoveredForFingerprint = differs() ? fingerprint : undefined;
  let newDispatch = identity.status === 'new';
  const replace = async (retryOf) => {
    await rotateCloudRequest(identity, retryOf, state, { fingerprint, providerBinding: binding });
    newDispatch = true;
  };
  if (identity.serverRequestId && identity.status === "sent") {
    const requestId = identity.serverRequestId;
    const path = `/v1/requests/${encodeURIComponent(requestId)}`;
    const response = await readCloudRecovery(state, provider, path, signal, 30_000);
    if (response.ok) {
      const payload = await parseCloudRecovery(state, response);
      const receipt = payload?.request || payload;
      if (receipt?.requestId !== requestId) throw reconcileError(state, "服务端回执不匹配");
      identity.providerBinding ||= binding;
      const recovered = await restoreCloudCandidate(state, receipt, recoveredForFingerprint);
      if (recovered) return {trace:identity, result:recovered};
      if (receipt.outputAvailable && receipt.status === 'completed' && receipt.billing === 'settled' && ['provider', 'reconciled'].includes(receipt.usageState)) {
        const replay = await readCloudRecovery(state, provider, `${path}/output`, signal, 10_000);
        if (replay.ok && replay.headers.get('x-aporia-request-id')===requestId)
          return {trace:identity,replay,recoveredForFingerprint};
        await replay.body?.cancel();
      }
      if (matchesNoDispatch(receipt)) await replace(requestId);
      else throw reconcileError(state, `服务端状态为 ${receipt.usageState || "未知"}，无法重放原输出`);
    } else {
      await response.body?.cancel();
      if (response.status === 404 && identity.preDispatchAuthRejected) await replace(null);
      else if ([401, 403].includes(response.status)) throw reconcileError(state, '请重新登录 Aporia Cloud 后再继续核对原请求');
      else throw reconcileError(state, `暂时无法查询原请求（HTTP ${response.status}）`);
    }
  } else if (identity.status === 'sent' && identity.preDispatchAuthRejected) {
    await replace(null);
  } else if (identity.status === "sent") {
    if (recoveredForFingerprint) throw reconcileError(state, '请求内容已变化且缺少服务端回执，无法确认旧请求是否执行');
    // A legacy server may silently ignore Idempotency-Key. Losing its headers is
    // not proof of non-dispatch, so require the dedup contract before retrying.
    const response = await readCloudRecovery(state, provider, '/v1/capabilities', signal, 30_000);
    if (!response.ok) {
      await response.body?.cancel();
      throw reconcileError(state, "服务端尚未确认支持请求去重");
    }
    const capability = await parseCloudRecovery(state, response);
    if (capability?.protocolVersion !== 1 || capability.modelGateway?.idempotency !== "reject-duplicate-no-replay")
      throw reconcileError(state, "服务端尚未确认支持请求去重");
  }
  identity.status = "sent";
  await persist(state); // Durable identity BEFORE anything can reach the gateway.
  signal?.throwIfAborted();
  return { trace: identity, result: null, newDispatch };
}
export async function rememberCloudReceipt(state, requestId) {
  if (!state || typeof requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(requestId)) return;
  state.identity.serverRequestId = requestId;
  await persist(state);
}
export async function rotateCloudRequest(trace, requestId, state = currentLoopRequestIdentity(), binding = null) {
  if (state) state.draft = null;
  trace.clientRequestId = uuid();
  if (requestId) trace.retryOf = requestId; else delete trace.retryOf;
  delete trace.serverRequestId;
  delete trace.preDispatchAuthRejected;
  delete trace.reconciledFingerprint;
  if (binding) Object.assign(trace, binding);
  trace.status = "sent";
  await persist(state);
}
export async function rememberCloudResult(state, result, recoveredForFingerprint) {
  if (!state) return;
  if (recoveredForFingerprint) {
    // Recovered text is safe to surface. Old tool actions cannot be attached to
    // a different request body, where their context or authorizations may differ.
    if (result.message?.tool_calls?.length)
      throw reconcileError(state, '找回了原请求的工具操作，但它基于旧上下文，未执行；如需继续，请按当前工作区另发指令');
    state.identity.reconciledFingerprint = recoveredForFingerprint;
    await persist(state);
  }
  // Store the confirmed response in the normal durable context store, not the
  // small metadata checkpoint. It can be reused after a sleep/completion race.
  await saveRuntimeContext(`cloud-response:${state.scopeId}`, { clientRequestId: state.identity.clientRequestId, result });
  state.result = result;
  state.identity.status = "received";
  await persist(state);
}
