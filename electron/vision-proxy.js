import { app, safeStorage } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { providerChatEndpoint } from "./provider-config.js";
import {
  buildVisionMessages,
  hasImageAttachments,
  imageAttachments,
  mergeVisionObservation,
  modelSupportsVision,
  selectVisionCandidate,
} from "./vision-proxy-core.js";

const VISION_TIMEOUT_MS = 60_000;
const VISION_MAX_OUTPUT_TOKENS = 1_600;

function getProviderStorePath() {
  return join(app.getPath("userData"), "aporiax-providers.json");
}

async function readProviderRecords() {
  try {
    const stored = JSON.parse(await readFile(getProviderStorePath(), "utf8"));
    return Array.isArray(stored?.providers) ? stored.providers : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error("Unable to read saved providers for the vision proxy.", {
      cause: error,
    });
  }
}

function decryptProviderKey(record) {
  if (record?.environmentKey && record?.id === "deepseek") {
    return String(process.env.DEEPSEEK_API_KEY || "").trim();
  }
  if (!record?.encryptedKey) return "";
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure credential storage is unavailable for the vision proxy.");
  }
  return safeStorage.decryptString(
    Buffer.from(record.encryptedKey, "base64"),
  );
}

function normalizeAssistantContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function callVisionProvider({ provider, model, message, signal }) {
  const apiKey = decryptProviderKey(provider);
  if (!apiKey) {
    throw new Error(
      `Vision Provider ${provider?.name || provider?.id || "unknown"} has no API key.`,
    );
  }

  const controller = new AbortController();
  const handleAbort = () => controller.abort();
  signal?.addEventListener("abort", handleAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);

  try {
    const response = await fetch(providerChatEndpoint(provider.baseUrl), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model.id,
        messages: buildVisionMessages(message),
        stream: false,
        max_tokens: VISION_MAX_OUTPUT_TOKENS,
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        payload?.error?.message ||
          payload?.message ||
          `Vision request failed: HTTP ${response.status}`,
      );
    }
    const observation = normalizeAssistantContent(
      payload?.choices?.[0]?.message?.content,
    );
    if (!observation) {
      throw new Error("Vision Provider returned an empty observation.");
    }
    return observation;
  } catch (error) {
    if (error?.name === "AbortError") {
      if (signal?.aborted) throw error;
      throw new Error("Vision Provider request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", handleAbort);
  }
}

function resolveMainModel(records, request) {
  const providerId = String(request?.providerId || "").trim();
  const modelId = String(request?.modelId || "").trim();
  const provider = records.find((item) => item?.id === providerId) || null;
  const model =
    provider?.models?.find((item) => String(item?.id || "") === modelId) ||
    (modelId ? { id: modelId } : null);
  return { provider, model };
}

export async function prepareVisionProxyRequest(request, { signal } = {}) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  if (!hasImageAttachments(messages)) return request;

  const records = await readProviderRecords();
  const main = resolveMainModel(records, request);
  if (main.model && modelSupportsVision(main.model)) return request;

  const candidate = selectVisionCandidate(records, {
    mainProviderId: request?.providerId,
    mainModelId: request?.modelId,
    visionProviderId: request?.visionProviderId,
    visionModelId: request?.visionModelId,
  });
  if (!candidate) return request;

  const nextMessages = [];
  let proxiedImages = 0;
  for (const message of messages) {
    const images = imageAttachments(message);
    if (!images.length) {
      nextMessages.push(message);
      continue;
    }
    const observation = await callVisionProvider({
      provider: candidate.provider,
      model: candidate.model,
      message,
      signal,
    });
    proxiedImages += images.length;
    nextMessages.push(
      mergeVisionObservation(message, observation, {
        providerName: candidate.provider?.name || candidate.provider?.id,
        modelId: candidate.model?.id,
      }),
    );
  }

  return {
    ...request,
    messages: nextMessages,
    visionProxy: {
      used: proxiedImages > 0,
      providerId: candidate.provider?.id || "",
      modelId: candidate.model?.id || "",
      imageCount: proxiedImages,
    },
  };
}
