import { compileProviderWire, normalizeNativeResponse } from "./native-provider-codec.js";
import { mergeTokenUsage } from "./token-usage.js";
import { providerChatEndpoint } from "../provider-config.js";
import { providerMessages } from "./task-conversation.js";
import { providerErrorCategory, providerRetryDelay, retryAfterMilliseconds } from "./provider-errors.js";
import { compileModelRequest } from "./request-compiler.js";
import { randomUUID } from "node:crypto";
import { runtimeRequestTrace, runtimeRunControl } from "./durable-run.js";
import { isTemporaryNetworkError } from "./run-control.js";
import { currentLoopRequestIdentity, prepareCloudRequest, rememberCloudReceipt, rememberCloudResult, rotateCloudRequest } from "./cloud-request-identity.js";
import { modelOutputBudget } from "./output-budget.js";
import { prepareCloudWindDown, observeCloudQuota } from "./cloud-wind-down.js";

const PROVIDER_IDLE_TIMEOUT_MS = 180_000;
const PROVIDER_MAX_ATTEMPTS = 3;
const PROVIDER_TIMEOUT_MAX_ATTEMPTS = 2;

function isProviderTimeoutError(error) {
  return (
    Number(error?.status) === 504 ||
    /(?:^|_)TIMEOUT(?:$|_)/i.test(String(error?.code || ""))
  );
}

function createAbortError(message = "The run was interrupted.") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function appendToolCallDelta(toolCalls, incomingCall) {
  const index = Number.isInteger(incomingCall.index)
    ? incomingCall.index
    : toolCalls.length;
  const current = toolCalls[index] || {
    id: "",
    type: "function",
    function: { name: "", arguments: "" },
  };
  if (incomingCall.id) current.id = incomingCall.id;
  if (incomingCall.type) current.type = incomingCall.type;
  if (incomingCall.function?.name) {
    current.function.name += incomingCall.function.name;
  }
  if (incomingCall.function?.arguments) {
    current.function.arguments += incomingCall.function.arguments;
  }
  toolCalls[index] = current;
}

function cloudErrorMessage(code) {
  if (code === "PROVIDER_BUDGET_TEMPORARILY_HELD") return "Cloud 全站费用保护正在等待在途请求结算，当前任务进度会保留；这不是个人额度预占。";
  if (code === "QUOTA_TEMPORARILY_HELD") return "Cloud 额度正在被其他请求使用，等待结算后继续；当前进度会保留。";
  if (code === "PROVIDER_FINISH_LENGTH") return "模型达到单次输出上限，本轮尚未完成。已保留确认过的工作；请缩小下一步或明确继续，不要反复重跑整轮。";
  if (code === "APORIA_CONTEXT_LENGTH_EXCEEDED") return "模型上下文过长，需要整理上下文后继续。";
  if (code === "QUOTA_RESERVATION_INSUFFICIENT") return "可用额度不足以预留本次模型请求的最大费用（不代表额度已经扣完）。请等待其他请求释放额度，或切换自己的 API。";
  if (code === "WEEKLY_QUOTA_EXHAUSTED") {
    return "Aporia Cloud 本周额度已用完。请切换到 Your Providers 或 Local 模型继续使用。";
  }
  if (code === "DESKTOP_ACCOUNT_SIGNED_OUT" || code === "APORIA_DEVICE_SESSION_REQUIRED") {
    return "请先登录 Aporia Account，再使用 Aporia Cloud 模型。";
  }
  if (code === "APORIA_RATE_LIMITED") {
    return "Aporia Cloud 当前并发请求较多，请稍后重试。";
  }
  if (code === "APORIA_MODEL_BUSY") {
    return "Aporia Cloud 模型当前繁忙，请稍后重试。";
  }
  if (code === "APORIA_PROVIDER_DAILY_BUDGET_EXHAUSTED") {
    return "Aporia Cloud 今日模型服务暂时不可用，你仍可切换到自己的 Provider 或本地模型。";
  }
  if (code === "APORIA_PROVIDER_TIMEOUT") {
    return "Aporia Cloud 模型响应超时，请稍后重试。";
  }
  if (code?.startsWith("APORIA_PROVIDER_")) {
    return "Aporia Cloud 上游模型服务暂时不可用，你仍可切换到自己的 Provider 或本地模型。";
  }
  return String(code || "APORIA_CLOUD_MODEL_FAILED");
}

function createProviderError(provider, code, status = 0) {
  const normalizedCode = String(code || "PROVIDER_REQUEST_FAILED");
  const error = new Error(
    provider.kind === "aporia-cloud"
      ? cloudErrorMessage(normalizedCode)
      : normalizedCode,
  );
  error.code = normalizedCode;
  error.status = status;
  error.retryable =
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500;
  if (
    provider.kind === "aporia-cloud" &&
    [
      "REQUEST_ALREADY_EXISTS", "IDEMPOTENCY_KEY_CONFLICT", "RETRY_PARENT_NOT_FOUND",
      "PRICING_REVIEW_REQUIRED", "APORIA_USAGE_RECONCILIATION_REQUIRED", "INSUFFICIENT_CREDITS",
      "WEEKLY_QUOTA_EXHAUSTED",
      "DESKTOP_ACCOUNT_SIGNED_OUT",
      "APORIA_DEVICE_SESSION_REQUIRED",
      "APORIA_PROVIDER_DAILY_BUDGET_EXHAUSTED",
    ].includes(normalizedCode)
  ) {
    error.retryable = false;
  }
  return error;
}

function responseError(provider, payload, status, headers, streaming = false) {
  const detail = payload?.error?.message || payload?.error || payload?.message ||
    `${provider.name} API returned HTTP ${status}.`;
  const error = createProviderError(provider, typeof detail === "string" ? detail : JSON.stringify(detail), status);
  error.providerCode = payload?.error?.code || payload?.code || null;
  error.retryAfterMs = retryAfterMilliseconds(headers);
  if (Number.isSafeInteger(payload?.retryAfterMs) && payload.retryAfterMs >= 0)
    error.retryAfterMs = Math.max(error.retryAfterMs || 0, payload.retryAfterMs);
  error.category = providerErrorCategory(error);
  if (["context", "quota", "authorization"].includes(error.category)) error.retryable = false;
  if (provider.kind === "aporia-cloud") {
    const request = payload?.request;
    error.cloudRequestId = headers?.get("x-aporia-request-id") || payload?.requestId || request?.requestId || null;
    error.cloudUsageState = request?.usageState || (payload?.accountingPending ? "pending" : null);
    // HTTP errors can originate in a proxy after inference was accepted. A new
    // key is safe only with a matching, durably released no-dispatch receipt.
    error.retryWithNewCloudRequest = Boolean(!payload?.accountingPending && error.cloudRequestId &&
      request?.requestId === error.cloudRequestId && request.usageState === "not-dispatched" &&
      request.billing === "released" && request.chargedMicros === 0);
    error.safeToRepair = error.retryWithNewCloudRequest;
    if (error.retryWithNewCloudRequest && ["PROVIDER_BUDGET_TEMPORARILY_HELD", "QUOTA_TEMPORARILY_HELD", "WEEKLY_QUOTA_EXHAUSTED", "INSUFFICIENT_CREDITS", "APORIA_PROVIDER_DAILY_BUDGET_EXHAUSTED"].includes(error.code)) {
      error.cloudQuota = { temporary: ["QUOTA_TEMPORARILY_HELD", "PROVIDER_BUDGET_TEMPORARILY_HELD"].includes(error.code), reason: ["APORIA_PROVIDER_DAILY_BUDGET_EXHAUSTED", "PROVIDER_BUDGET_TEMPORARILY_HELD"].includes(error.code) ? "daily-budget" : "quota" };
      error.retryable = false; // Durable task pause owns this, not the HTTP retry loop.
    }
    if (error.retryWithNewCloudRequest && error.code === "REQUEST_ALREADY_EXISTS") error.retryable = true;
    if (payload?.accountingPending || ((request || streaming) && !error.retryWithNewCloudRequest))
      error.retryable = false;
  }
  return error;
}

function settledQuotaExhausted(receipt) {
  return receipt?.billing === "settled" && ["provider", "reconciled"].includes(receipt.usageState) &&
    receipt.quota?.policy === "actual-usage-v1" && receipt.quota.exhausted === true &&
    Number.isSafeInteger(receipt.quota.remainingMicros) && receipt.quota.remainingMicros <= 0;
}

async function fetchProviderResponse(provider, init, wire) {
  if (provider.kind === "aporia-cloud") {
    if (typeof provider.authenticatedFetch !== "function") {
      throw createProviderError(provider, "DESKTOP_ACCOUNT_SIGNED_OUT", 401);
    }
    return provider.authenticatedFetch("/v1/chat/completions", init);
  }
  return normalizeNativeResponse(await fetch(wire.url, init), wire);
}

export async function callModelProvider({
  provider,
  body,
  signal,
  onEvent,
  requestTrace = {},
}) {
  body = compileModelRequest(body);
  const identity = provider.kind === "aporia-cloud" ? currentLoopRequestIdentity() : null;
  body = await prepareCloudWindDown(provider, body, identity, onEvent, signal);
  const prepared = identity ? await prepareCloudRequest(identity, provider, body, requestTrace, signal) : null;
  if (prepared?.result) {
    await observeCloudQuota(prepared.result.cloudQuotaSnapshot, onEvent);
    return prepared.result;
  }
  const cloudTrace = prepared?.trace || { ...runtimeRequestTrace(), ...requestTrace, logicalRequestId: randomUUID(), clientRequestId: randomUUID() };
  let attemptUsage = null;
  for (let attempt = 1; attempt <= PROVIDER_MAX_ATTEMPTS; attempt += 1) {
    const started = performance.now();
    onEvent?.({ type: "response.attempt.started", attempt });
    try {
      const result = await callModelProviderOnce({
        provider,
        body,
        signal,
        onEvent,
        cloudTrace,
      });
      onEvent?.({ type: "response.attempt.completed", attempt, durationMs: performance.now() - started,
        status: "completed", usage: result.usage, finishReason: result.finishReason });
      attemptUsage = mergeTokenUsage(attemptUsage, result.usage);
      const completed = { ...result, attemptUsage };
      await rememberCloudResult(identity, completed);
      if (provider.kind === "aporia-cloud") await observeCloudQuota(completed.cloudQuotaSnapshot, onEvent);
      return completed;
    } catch (error) {
      if (provider.kind === "aporia-cloud") await observeCloudQuota(error.cloudQuotaSnapshot, onEvent);
      attemptUsage = mergeTokenUsage(attemptUsage, error.usage);
      error.attemptUsage = attemptUsage;
      error.category = providerErrorCategory(error);
      onEvent?.({ type: "response.attempt.completed", attempt, durationMs: performance.now() - started,
        status: "failed", category: error.category, usage: error.usage || null });
      const maxAttempts = isProviderTimeoutError(error)
        ? PROVIDER_TIMEOUT_MAX_ATTEMPTS
        : PROVIDER_MAX_ATTEMPTS;
      if (
        signal?.aborted ||
        (runtimeRunControl() && isTemporaryNetworkError(error)) ||
        !error?.retryable ||
        ["quota", "authorization", "context", "output-limit", "tool-protocol"].includes(error.category) ||
        attempt >= maxAttempts
      ) {
        throw error;
      }
      const delayMs = providerRetryDelay(attempt, error.retryAfterMs);
      if (delayMs > 120_000) {
        error.retryDeferred = true;
        error.message += " Retry-After exceeds the automatic wait budget; retry later rather than ignoring the server delay.";
        throw error;
      }
      if (provider.kind === "aporia-cloud" && error.retryWithNewCloudRequest) {
        await rotateCloudRequest(cloudTrace, error.cloudRequestId, identity);
      }
      onEvent?.({
        type: "response.retry",
        attempt: attempt + 1,
        maxAttempts,
        delayMs,
        reason: error.message,
        provider: provider.name,
      });
      try { await waitForAbortableDelay(delayMs, signal); }
      catch (error) { error.attemptUsage = attemptUsage; throw error; }
    }
  }
  throw new Error(
    `${provider.name} request failed after automatic retries.`,
  );
}

export function createOpenAICompatibleProvider({
  config,
  model,
  onEvent,
}) {
  return Object.freeze({
    id: config.id,
    kind: config.kind,
    name: config.name,
    vendor: config.vendor,
    supportsImages: Boolean(model.supportsImages),
    supportsTools: model.supportsTools !== false,
    supportsThinking: Boolean(model.supportsThinking),
    thinkingMode: model.thinkingMode || "none",
    supportsModel: (modelId) => model.id === modelId,
    complete: ({ body, signal, onStreamEvent, requestTrace = {} }) =>
      callModelProvider({
        provider: { ...config, nativeModel: model },
        body,
        signal,
        requestTrace,
        onEvent:
          typeof onStreamEvent === "function"
            ? onStreamEvent
            : onEvent,
      }),
  });
}

function waitForAbortableDelay(delayMs, signal) {
  throwIfAborted(signal);
  return new Promise((resolveDelay, rejectDelay) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolveDelay();
    }, delayMs);
    const handleAbort = () => {
      clearTimeout(timeout);
      rejectDelay(createAbortError());
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

export async function callModelProviderOnce({
  provider,
  body,
  signal,
  onEvent,
  cloudTrace,
}) {
  throwIfAborted(signal);
  // All callers, including subagents and side chat, share this last boundary.
  if (Array.isArray(body.messages)) body = { ...body, messages: providerMessages(body.messages) };
  const wire = compileProviderWire(provider, body);
  const controller = new AbortController();
  const handleAbort = () => controller.abort();
  signal?.addEventListener("abort", handleAbort, { once: true });
  let idleTimedOut = false;
  let receivedStreamBytes = false;
  let observedUsage = null;
  let receivedContent = "";
  let idleTimeout = null;
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => {
      idleTimedOut = true;
      controller.abort();
    }, PROVIDER_IDLE_TIMEOUT_MS);
  };
  resetIdleTimeout();

  try {
    const response = await fetchProviderResponse(provider, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...wire.headers,
        ...(provider.kind === "aporia-cloud" ? cloudTraceHeaders(cloudTrace || { ...runtimeRequestTrace(), logicalRequestId: randomUUID(), clientRequestId: randomUUID() }) : {}),
      },
      body: JSON.stringify(wire.body),
      signal: controller.signal,
      ...(provider.kind === "aporia-cloud" ? { onCloudQueue: (queue) => {
        if (queue.state === "queued") clearTimeout(idleTimeout); else resetIdleTimeout();
        onEvent?.({ type: `response.cloud.${queue.state}`, ...queue });
      } } : {}),
    }, wire);

    if (provider.kind === "aporia-cloud") {
      try { await rememberCloudReceipt(currentLoopRequestIdentity(), response.headers.get("x-aporia-request-id")); }
      catch (error) { await response.body?.cancel(); throw error; }
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw responseError(provider, payload, response.status, response.headers);
    }
    if (!response.body) {
      throw new Error(
        `${provider.name} API returned an empty response stream.`,
      );
    }

    let content = "";
    let reasoningContent = "";
    let nativeState = null;
    let usage = null;
    let buffer = "";
    const toolCalls = [];
    const decoder = new TextDecoder();
    let finishReason = null;
    let sawDone = false;
    let cloudBilling = null;
    let lastActivityAt = 0;
    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (!data) return;
      if (data === "[DONE]") { sawDone = true; return; }
      const payload = JSON.parse(data);
      if (provider.kind === "aporia-cloud" && ["queued", "admitted"].includes(payload.aporiaQueue?.state)) {
        const queue = payload.aporiaQueue;
        onEvent?.({ type: `response.cloud.${queue.state}`, state: queue.state, source: "gateway",
          reason: ["quota", "provider-budget"].includes(queue.reason) ? queue.reason : "concurrency",
          limit: Math.min(...[queue.perUser, queue.perDevice, queue.global].filter(v => Number.isSafeInteger(v) && v > 0)),
          waitedMs: Number.isSafeInteger(queue.waitedMs) ? queue.waitedMs : null });
        return;
      }
      const streamError = typeof payload?.error === "string" ? payload.error : payload?.error?.message;
      if (streamError) {
        const status = provider.kind === "aporia-cloud" && Number.isInteger(payload.status) && payload.status >= 400 && payload.status <= 599
          ? payload.status : 0;
        throw responseError(provider, payload, status, response.headers, true);
      }
      if (payload.aporia_native_state && ["responses", "anthropic-messages"].includes(wire.protocol)) nativeState = payload.aporia_native_state;
      if (provider.kind === "aporia-cloud" && typeof payload.requestId === "string" && typeof payload.usageState === "string") {
        if (payload.requestId === response.headers.get("x-aporia-request-id")) cloudBilling = payload;
        onEvent?.({ type: "response.cloud.billing", requestId: payload.requestId, usageState: payload.usageState,
          chargedMicros: Number.isSafeInteger(payload.chargedMicros) ? payload.chargedMicros : null });
        return; // Billing uses a different usage schema; never overwrite model usage.
      }
      if (payload.usage) { usage = payload.usage; observedUsage = payload.usage; }
      const choice = payload?.choices?.[0];
      if (choice?.finish_reason != null) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      if (!delta) return;
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        receivedContent = content;
        onEvent?.({ type: "response.delta", delta: delta.content });
      }
      if (typeof delta.reasoning_content === "string") reasoningContent += delta.reasoning_content;
      for (const toolCall of delta.tool_calls || []) appendToolCallDelta(toolCalls, toolCall);
    };

    for await (const chunk of response.body) {
      throwIfAborted(signal);
      if (chunk?.byteLength) receivedStreamBytes = true;
      resetIdleTimeout();
      const activityAt = Date.now();
      if (chunk?.byteLength && activityAt - lastActivityAt >= 1000) {
        lastActivityAt = activityAt;
        onEvent?.({ type: "response.activity" });
      }
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        processLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);
    const failIncomplete = (code) => {
      const error = createProviderError(provider, code, 0);
      error.retryable = false;
      error.usage = usage;
      if (sawDone && cloudBilling?.billing === "settled" && ["provider", "reconciled"].includes(cloudBilling.usageState))
        error.cloudQuotaSnapshot = cloudBilling.quota;
      error.streamComplete = sawDone || Boolean(finishReason);
      const budget = modelOutputBudget(provider, body);
      error.outputTokenLimit = budget.limit;
      error.maxOutputTokens = budget.maximum;
      // Repairing a Cloud response requires the complete, settled stream.
        error.safeToRepair = provider.kind !== "aporia-cloud" || sawDone;
        if (sawDone && settledQuotaExhausted(cloudBilling)) {
          error.cloudQuota = { temporary: false, reason: "quota", truncated: true };
        } else if (code === "PROVIDER_FINISH_LENGTH" && sawDone && cloudBilling?.billing === "settled" &&
            ["provider", "reconciled"].includes(cloudBilling.usageState) &&
            ["quota", "daily-budget"].includes(cloudBilling.admission?.limitReason)) {
          error.cloudQuota = { temporary: false, reason: cloudBilling.admission.limitReason, truncated: true };
        }
      error.partialToolCalls = toolCalls.some(Boolean);
      error.partialMessage = { content, ...(reasoningContent ? { reasoning_content: reasoningContent } : {}), ...(nativeState ? { aporiaNative: nativeState } : {}) };
      onEvent?.({ type: "response.incomplete", code, finishReason, usage });
      throw error;
    };
    if ((!sawDone && provider.kind === "aporia-cloud") || (!sawDone && !finishReason)) failIncomplete("PROVIDER_STREAM_INCOMPLETE");
    if (finishReason && !["stop", "tool_calls"].includes(finishReason)) failIncomplete(`PROVIDER_FINISH_${String(finishReason).toUpperCase()}`);
    const callIds = new Set();
    for (const call of toolCalls.filter(Boolean)) {
      try {
        if (!call.id || !call.function?.name || callIds.has(call.id)) throw new Error();
        callIds.add(call.id);
        const args = JSON.parse(call.function.arguments);
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
      } catch { failIncomplete("PROVIDER_TOOL_CALL_INCOMPLETE"); }
    }
    if (finishReason === "tool_calls" && !toolCalls.filter(Boolean).length) failIncomplete("PROVIDER_TOOL_CALL_INCOMPLETE");
    if (!toolCalls.filter(Boolean).length && !content.trim()) failIncomplete("MODEL_EMPTY_RESPONSE");

    return {
      finishReason: finishReason || (toolCalls.length ? "tool_calls" : "stop"),
      streamComplete: true,
      ...(sawDone && cloudBilling?.billing === "settled" && ["provider", "reconciled"].includes(cloudBilling.usageState)
        ? { cloudQuotaSnapshot: cloudBilling.quota } : {}),
      ...(sawDone && settledQuotaExhausted(cloudBilling) ? { cloudQuota: { temporary: false, reason: "quota", afterResponse: true } } : {}),
      message: {
        content,
        ...(nativeState ? { aporiaNative: nativeState } : {}),
        ...(reasoningContent
          ? { reasoning_content: reasoningContent }
          : {}),
        ...(toolCalls.length
          ? { tool_calls: toolCalls.filter(Boolean) }
          : {}),
      },
      usage,
    };
  } catch (error) {
    if (receivedContent && !error.partialMessage) error.partialMessage = { content: receivedContent };
    if (observedUsage && !error.usage) error.usage = observedUsage;
    if (signal?.aborted) throw Object.assign(createAbortError(), { usage: observedUsage, partialMessage: { content: receivedContent } });
    if (provider.kind === "aporia-cloud" && error?.message === "DESKTOP_ACCOUNT_SIGNED_OUT") {
      throw createProviderError(provider, "DESKTOP_ACCOUNT_SIGNED_OUT", 401);
    }
    if (idleTimedOut) {
      const timeoutError = createProviderError(
        provider,
        provider.kind === "aporia-cloud"
          ? "APORIA_PROVIDER_TIMEOUT"
          : `${provider.name} connection was idle for 180 seconds.`,
        504,
      );
      timeoutError.retryable = !receivedStreamBytes;
      timeoutError.usage = observedUsage;
      throw timeoutError;
    }
    if (error?.name === "AbortError") {
      const abortError = new Error(
        `${provider.name} request was interrupted.`,
      );
      abortError.retryable = !receivedStreamBytes;
      throw abortError;
    }
    if (error instanceof TypeError) {
      error.retryable = !receivedStreamBytes;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeout);
    signal?.removeEventListener("abort", handleAbort);
  }
}

export function cloudTraceHeaders(trace) {
  const entries = { "idempotency-key": trace.clientRequestId, "x-aporia-logical-request-id": trace.logicalRequestId,
    "x-aporia-task-id": trace.taskId, "x-aporia-run-id": trace.runId, "x-aporia-agent-id": trace.agentId || "main", "x-aporia-retry-of": trace.retryOf };
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(value)));
}
