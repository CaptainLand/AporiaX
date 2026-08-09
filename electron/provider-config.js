import { randomUUID } from "node:crypto";

export const DEFAULT_DEEPSEEK_PROVIDER = Object.freeze({
  id: "deepseek",
  name: "DeepSeek",
  vendor: "deepseek",
  kind: "openai-compatible",
  baseUrl: "https://api.deepseek.com",
  models: [
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      shortName: "V4 Pro",
      supportsImages: false,
      supportsThinking: true,
      thinkingMode: "deepseek",
      supportsTools: true,
      contextWindow: 1_000_000,
    },
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      shortName: "V4 Flash",
      supportsImages: false,
      supportsThinking: true,
      thinkingMode: "deepseek",
      supportsTools: true,
      contextWindow: 1_000_000,
    },
  ],
});

const PROVIDER_HINTS = [
  ["api.deepseek.com", "deepseek", "DeepSeek"],
  ["api.openai.com", "openai", "OpenAI"],
  ["openrouter.ai", "openrouter", "OpenRouter"],
  ["api.groq.com", "groq", "Groq"],
  ["api.together.xyz", "together", "Together AI"],
  ["api.siliconflow.cn", "siliconflow", "SiliconFlow"],
  ["localhost", "local", "Local API"],
  ["127.0.0.1", "local", "Local API"],
];

export function normalizeProviderBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) throw new Error("API Base URL 不能为空。");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("请输入完整的 API Base URL，例如 https://api.example.com/v1。");
  }
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(
    parsed.hostname,
  );
  if (parsed.protocol !== "https:" && !(localHost && parsed.protocol === "http:")) {
    throw new Error("远程 API 必须使用 HTTPS；本机 localhost 可以使用 HTTP。");
  }
  parsed.hash = "";
  parsed.search = "";
  let pathname = parsed.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/chat\/completions$/i, "");
  if (!pathname || pathname === "/") {
    const host = parsed.hostname.toLowerCase();
    if (host === "api.openai.com") pathname = "/v1";
    if (host === "openrouter.ai") pathname = "/api/v1";
    if (host === "api.groq.com") pathname = "/openai/v1";
    if (host === "api.together.xyz") pathname = "/v1";
    if (host === "api.siliconflow.cn") pathname = "/v1";
  }
  parsed.pathname = pathname || "/";
  return parsed.toString().replace(/\/+$/, "");
}

export function inferProviderIdentity(baseUrl) {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  const hostname = new URL(normalized).hostname.toLowerCase();
  const match = PROVIDER_HINTS.find(([hint]) => hostname.includes(hint));
  return {
    vendor: match?.[1] || "openai-compatible",
    suggestedName: match?.[2] || hostname,
  };
}

function shortModelName(modelId) {
  const tail = String(modelId).split("/").at(-1) || modelId;
  return tail.length > 24 ? `${tail.slice(0, 21)}…` : tail;
}

export function inferModelContextWindow(modelId, vendor) {
  const value = String(modelId || "").toLowerCase();
  if (
    vendor === "deepseek" &&
    /^deepseek-v4-(?:pro|flash)(?:[-_.:]|$)/.test(value)
  ) {
    return 1_000_000;
  }
  return undefined;
}

export function inferModelCapabilities(modelId, vendor) {
  const value = String(modelId || "").toLowerCase();
  const supportsImages =
    /(?:^|[-_/])(gpt-4o|gpt-4\.1|gpt-5|vision|vl|gemini|claude)(?:[-_/.:]|$)/i.test(
      value,
    ) ||
    /qwen.*vl|llava|pixtral|internvl|vision/i.test(value);
  let supportsThinking = false;
  let thinkingMode = "none";
  if (vendor === "deepseek") {
    supportsThinking = /deepseek|reasoner/i.test(value);
    thinkingMode = supportsThinking ? "deepseek" : "none";
  } else if (vendor === "openai") {
    supportsThinking = /(?:^|[-_/])(gpt-5|o1|o3|o4)(?:[-_/.:]|$)/i.test(
      value,
    );
    thinkingMode = supportsThinking ? "reasoning-effort" : "none";
  }
  return {
    supportsImages,
    supportsThinking,
    thinkingMode,
    supportsTools: true,
  };
}

export function normalizeProviderModels(models, vendor) {
  const values = Array.isArray(models) ? models : [];
  const seen = new Set();
  const normalized = [];
  for (const input of values.slice(0, 200)) {
    const modelId = String(
      typeof input === "string" ? input : input?.id || "",
    ).trim();
    if (!modelId || modelId.length > 240 || seen.has(modelId)) continue;
    seen.add(modelId);
    const inferred = inferModelCapabilities(modelId, vendor);
    const source =
      input && typeof input === "object" && !Array.isArray(input)
        ? input
        : {};
    normalized.push({
      id: modelId,
      name: String(source.name || modelId).slice(0, 240),
      shortName: String(
        source.shortName || shortModelName(modelId),
      ).slice(0, 40),
      supportsImages:
        typeof source.supportsImages === "boolean"
          ? source.supportsImages
          : inferred.supportsImages,
      supportsThinking:
        typeof source.supportsThinking === "boolean"
          ? source.supportsThinking
          : inferred.supportsThinking,
      thinkingMode: ["none", "deepseek", "reasoning-effort"].includes(
        source.thinkingMode,
      )
        ? source.thinkingMode
        : inferred.thinkingMode,
      supportsTools:
        typeof source.supportsTools === "boolean"
          ? source.supportsTools
          : true,
      contextWindow:
        Number.isFinite(Number(source.contextWindow)) &&
        Number(source.contextWindow) >= 32_000
          ? Math.min(2_000_000, Math.floor(Number(source.contextWindow)))
          : inferModelContextWindow(modelId, vendor),
    });
  }
  return normalized;
}

export function normalizeProviderInput(input, existing = null) {
  const baseUrl = normalizeProviderBaseUrl(input?.baseUrl);
  const inferred = inferProviderIdentity(baseUrl);
  const name = String(input?.name || inferred.suggestedName)
    .trim()
    .slice(0, 80);
  if (!name) throw new Error("Provider 名称不能为空。");
  const models = normalizeProviderModels(input?.models, inferred.vendor);
  if (!models.length) {
    throw new Error("请至少添加一个模型 ID，或先自动发现模型。");
  }
  const id =
    typeof existing?.id === "string"
      ? existing.id
      : typeof input?.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(input.id)
        ? input.id
        : randomUUID();
  return {
    id,
    name,
    kind: "openai-compatible",
    vendor: inferred.vendor,
    baseUrl,
    models,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function providerModelsEndpoint(baseUrl) {
  return `${normalizeProviderBaseUrl(baseUrl)}/models`;
}

export function providerChatEndpoint(baseUrl) {
  return `${normalizeProviderBaseUrl(baseUrl)}/chat/completions`;
}

function providerHeaders(apiKey) {
  return {
    Accept: "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

export async function discoverProviderModels({
  baseUrl,
  apiKey = "",
  signal,
}) {
  const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl);
  const identity = inferProviderIdentity(normalizedBaseUrl);
  const controller = new AbortController();
  const handleAbort = () => controller.abort();
  signal?.addEventListener("abort", handleAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(providerModelsEndpoint(normalizedBaseUrl), {
      headers: providerHeaders(String(apiKey || "").trim()),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        payload?.error?.message ||
          payload?.message ||
          `模型发现失败：HTTP ${response.status}`,
      );
    }
    const models = normalizeProviderModels(
      Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
          ? payload.models
          : [],
      identity.vendor,
    );
    if (!models.length) {
      throw new Error("API 已连接，但 /models 没有返回可用模型；可以手动填写模型 ID。");
    }
    return {
      baseUrl: normalizedBaseUrl,
      vendor: identity.vendor,
      suggestedName: identity.suggestedName,
      models,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("模型发现超时，请检查 API 地址和网络。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", handleAbort);
  }
}

export function publicProviderSummary(record) {
  const vendor =
    record.vendor || inferProviderIdentity(record.baseUrl).vendor;
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    vendor,
    baseUrl: record.baseUrl,
    models: normalizeProviderModels(record.models, vendor),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    hasApiKey: Boolean(record.encryptedKey || record.environmentKey),
    environmentKey: Boolean(record.environmentKey),
  };
}
