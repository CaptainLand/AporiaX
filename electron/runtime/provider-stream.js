import { providerChatEndpoint } from "../provider-config.js";
import { emitCloudModelActivity } from "../account/account-events.js";

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

async function fetchProviderResponse(provider, init) {
  if (provider.kind === "aporia-cloud") {
    if (typeof provider.authenticatedFetch !== "function") {
      throw createProviderError(provider, "DESKTOP_ACCOUNT_SIGNED_OUT", 401);
    }
    return provider.authenticatedFetch("/v1/chat/completions", init);
  }
  return fetch(providerChatEndpoint(provider.baseUrl), init);
}

export async function callModelProvider({
  provider,
  body,
  signal,
  onEvent,
}) {
  for (let attempt = 1; attempt <= PROVIDER_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await callModelProviderOnce({
        provider,
        body,
        signal,
        onEvent,
      });
      if (provider.kind === "aporia-cloud") {
        emitCloudModelActivity({ type: "completed" });
      }
      return result;
    } catch (error) {
      const maxAttempts = isProviderTimeoutError(error)
        ? PROVIDER_TIMEOUT_MAX_ATTEMPTS
        : PROVIDER_MAX_ATTEMPTS;
      if (
        signal?.aborted ||
        !error?.retryable ||
        attempt >= maxAttempts
      ) {
        if (provider.kind === "aporia-cloud") {
          emitCloudModelActivity({
            type:
              error?.code === "WEEKLY_QUOTA_EXHAUSTED"
                ? "quota-exhausted"
                : "failed",
            code: error?.code || "",
          });
        }
        throw error;
      }
      const delayMs = 750 * 2 ** (attempt - 1);
      onEvent?.({
        type: "response.retry",
        attempt: attempt + 1,
        maxAttempts,
        delayMs,
        reason: error.message,
        provider: provider.name,
      });
      await waitForAbortableDelay(delayMs, signal);
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
    name: config.name,
    vendor: config.vendor,
    supportsImages: Boolean(model.supportsImages),
    supportsTools: model.supportsTools !== false,
    supportsThinking: Boolean(model.supportsThinking),
    thinkingMode: model.thinkingMode || "none",
    supportsModel: (modelId) => model.id === modelId,
    complete: ({ body, signal, onStreamEvent }) =>
      callModelProvider({
        provider: config,
        body,
        signal,
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
}) {
  throwIfAborted(signal);
  const controller = new AbortController();
  const handleAbort = () => controller.abort();
  signal?.addEventListener("abort", handleAbort, { once: true });
  let idleTimedOut = false;
  let receivedStreamBytes = false;
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
        ...(provider.kind !== "aporia-cloud" && provider.apiKey
          ? { Authorization: `Bearer ${provider.apiKey}` }
          : {}),
      },
      body: JSON.stringify({
        ...body,
        stream: true,
        ...(["deepseek", "openai"].includes(provider.vendor)
          ? { stream_options: { include_usage: true } }
          : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const detail =
        payload?.error?.message ||
        payload?.error ||
        payload?.message ||
        `${provider.name} API returned HTTP ${response.status}.`;
      throw createProviderError(provider, detail, response.status);
    }
    if (!response.body) {
      throw new Error(
        `${provider.name} API returned an empty response stream.`,
      );
    }

    let content = "";
    let reasoningContent = "";
    let usage = null;
    let buffer = "";
    const toolCalls = [];
    const decoder = new TextDecoder();

    for await (const chunk of response.body) {
      throwIfAborted(signal);
      if (chunk?.byteLength) receivedStreamBytes = true;
      resetIdleTimeout();
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const payload = JSON.parse(data);
        const streamError =
          typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message;
        if (streamError) {
          throw createProviderError(provider, streamError, 0);
        }
        if (payload.usage) usage = payload.usage;
        const delta = payload?.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          onEvent?.({ type: "response.delta", delta: delta.content });
        }
        if (
          typeof delta.reasoning_content === "string" &&
          delta.reasoning_content
        ) {
          reasoningContent += delta.reasoning_content;
        }
        for (const toolCall of delta.tool_calls || []) {
          appendToolCallDelta(toolCalls, toolCall);
        }
      }
    }

    return {
      message: {
        content,
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
    if (signal?.aborted) throw createAbortError();
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
