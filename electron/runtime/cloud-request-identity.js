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
  return { scopeId, checkpointScope, identity, result: response?.clientRequestId === identity.clientRequestId ? response.result : null };
}
export const withLoopRequestIdentity = (state, fn) => storage.run(state, fn);
export const currentLoopRequestIdentity = () => storage.getStore();
export async function createRepairRequestIdentity(previous, { corrections, compactions, outputTokenLimit }) {
  const state = { scopeId: previous.scopeId, checkpointScope: previous.checkpointScope, result: null,
    identity: { ...fresh(), repairCount: corrections, compactions, repairMaxTokens: outputTokenLimit,
      ...(previous.identity.serverRequestId ? { retryOf: previous.identity.serverRequestId } : {}) } };
  // Persist the consumed repair budget before another paid inference can start.
  await persist(state);
  return state;
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
function reconcileError(state, reason) {
  const error = new Error(`Aporia Cloud 原请求结果需要核对（${state.identity.serverRequestId || state.identity.clientRequestId}）：${reason}。已保留请求身份，未自动发起第二次付费生成。`);
  return Object.assign(error, { code: "CLOUD_REQUEST_RECONCILIATION_REQUIRED", retryable: false,
    cloudRequestId: state.identity.serverRequestId || null });
}
export async function prepareCloudRequest(state, provider, body, requestTrace, signal) {
  const fingerprint = createHash("sha256").update(JSON.stringify(canonical({ provider: provider.id,
    endpoint: provider.baseUrl, body }))).digest("hex");
  if (state.identity.fingerprint && state.identity.fingerprint !== fingerprint) {
    // A durable complete result plus changed confirmed history is a NEW inference.
    // An uncertain request may never be silently replaced after restart/steering.
    if (!state.result) throw reconcileError(state, "恢复后的模型、端点或请求内容已变化");
    state.identity = { ...fresh(), quotaWindDown: state.identity.quotaWindDown }; state.result = null;
  }
  const identity = state.identity;
  if (!identity.fingerprint) Object.assign(identity, runtimeRequestTrace(), requestTrace, { fingerprint });
  if (state.result) return { trace: identity, result: state.result };
  if (identity.serverRequestId && identity.status === "sent") {
    const response = await provider.authenticatedFetch(`/v1/requests/${encodeURIComponent(identity.serverRequestId)}`,
      { method: "GET", signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(30_000)]) });
    if (response.ok) {
      const payload = await response.json();
      const receipt = payload?.request || payload;
      if (receipt?.requestId !== identity.serverRequestId) throw reconcileError(state, "服务端回执不匹配");
      if (receipt.usageState === "not-dispatched" && receipt.billing === "released" && receipt.chargedMicros === 0) {
        await rotateCloudRequest(identity, receipt.requestId, state);
      } else throw reconcileError(state, `服务端状态为 ${receipt.usageState || "未知"}，无法重放原输出`);
    } else {
      await response.body?.cancel();
      throw reconcileError(state, `暂时无法查询原请求（HTTP ${response.status}）`);
    }
  } else if (identity.status === "sent") {
    // A legacy server may silently ignore Idempotency-Key. Losing its headers is
    // not proof of non-dispatch, so require the dedup contract before retrying.
    const response = await provider.authenticatedFetch("/v1/capabilities", {
      method: "GET", signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(30_000)]) });
    if (!response.ok) {
      await response.body?.cancel();
      throw reconcileError(state, "服务端尚未确认支持请求去重");
    }
    const capability = await response.json();
    if (capability?.protocolVersion !== 1 || capability.modelGateway?.idempotency !== "reject-duplicate-no-replay")
      throw reconcileError(state, "服务端尚未确认支持请求去重");
  }
  identity.status = "sent";
  await persist(state); // Durable identity BEFORE anything can reach the gateway.
  signal?.throwIfAborted();
  return { trace: identity, result: null };
}
export async function rememberCloudReceipt(state, requestId) {
  if (!state || typeof requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(requestId)) return;
  state.identity.serverRequestId = requestId;
  await persist(state);
}
export async function rotateCloudRequest(trace, requestId, state = currentLoopRequestIdentity()) {
  trace.clientRequestId = uuid();
  trace.retryOf = requestId;
  delete trace.serverRequestId;
  trace.status = "sent";
  await persist(state);
}
export async function rememberCloudResult(state, result) {
  if (!state) return;
  // Store the confirmed response in the normal durable context store, not the
  // small metadata checkpoint. It can be reused after a sleep/completion race.
  await saveRuntimeContext(`cloud-response:${state.scopeId}`, { clientRequestId: state.identity.clientRequestId, result });
  state.result = result;
  state.identity.status = "received";
  await persist(state);
}
