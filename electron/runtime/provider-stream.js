import { providerChatEndpoint } from "../provider-config.js";

const PROVIDER_IDLE_TIMEOUT_MS = 180_000;
const PROVIDER_MAX_ATTEMPTS = 3;

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

export async function callModelProvider({
  provider,
  body,
  signal,
  onEvent,
}) {
  for (let attempt = 1; attempt <= PROVIDER_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await callModelProviderOnce({
        provider,
        body,
        signal,
        onEvent,
      });
    } catch (error) {
      if (
        signal?.aborted ||
        !error?.retryable ||
        attempt >= PROVIDER_MAX_ATTEMPTS
      ) {
        throw error;
      }
      const delayMs = 750 * 2 ** (attempt - 1);
      onEvent?.({
        type: "response.retry",
        attempt: attempt + 1,
        maxAttempts: PROVIDER_MAX_ATTEMPTS,
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
    const response = await fetch(providerChatEndpoint(provider.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey
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
        payload?.message ||
        `${provider.name} API returned HTTP ${response.status}.`;
      const error = new Error(detail);
      error.retryable =
        response.status === 408 ||
        response.status === 409 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500;
      error.status = response.status;
      throw error;
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
    if (idleTimedOut) {
      const timeoutError = new Error(
        `${provider.name} connection was idle for 180 seconds.`,
      );
      timeoutError.retryable = true;
      throw timeoutError;
    }
    if (error?.name === "AbortError") {
      const abortError = new Error(
        `${provider.name} request was interrupted.`,
      );
      abortError.retryable = true;
      throw abortError;
    }
    if (error instanceof TypeError) {
      error.retryable = true;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeout);
    signal?.removeEventListener("abort", handleAbort);
  }
}
