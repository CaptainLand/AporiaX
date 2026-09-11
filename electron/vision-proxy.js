import { app, safeStorage } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { providerChatEndpoint } from "./provider-config.js";
import { getDesktopAccountRuntime } from "./account/register-desktop-account-ipc.js";
import { callModelProviderOnce } from "./runtime/provider-stream.js";
import { queryCloudVisionCapability } from "./cloud-vision-capability.js";
import { modelSupportsVision } from "./model-vision.js";
import {
  buildVisionMessages,
  hasImageAttachments,
  imageAttachments,
  mergeVisionObservation,
  selectVisionCandidate,
} from "./vision-proxy-core.js";

const VISION_TIMEOUT_MS = 60_000;
const VISION_MAX_OUTPUT_TOKENS = 1_600;
const APORIA_CLOUD_PROVIDER_ID = "aporia-cloud";
const APORIA_CLOUD_VISION_MODEL_ID = "aporia-cloud-vision";
const APORIA_CLOUD_MAX_IMAGE_DATA_URL_CHARS = 7_500_000;
const APORIA_CLOUD_VISION_OUTPUT_TOKENS = 900;

function getProviderStorePath() {
  return join(app.getPath("userData"), "aporiax-providers.json");
}

export function getCloudVisionCapability(options = {}) {
  const account = getDesktopAccountRuntime();
  return queryCloudVisionCapability((path, init) => account.fetchModelGateway(path, init), options);
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
  if (!apiKey && provider?.vendor !== "local" && provider?.source !== "local") {
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
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
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

async function callAporiaCloudVision({ message, image, signal, onEvent }) {
  if (String(image?.dataUrl || "").length > APORIA_CLOUD_MAX_IMAGE_DATA_URL_CHARS) {
    throw new Error(
      "Aporia Cloud Vision 当前单张图片过大，请压缩到约 5.5 MB 以下后重试。",
    );
  }
  const accountRuntime = getDesktopAccountRuntime();
  const provider = {
    id: APORIA_CLOUD_PROVIDER_ID,
    name: "Aporia Cloud Vision",
    vendor: "aporia",
    kind: "aporia-cloud",
    authenticatedFetch: (path, init) => accountRuntime.fetchModelGateway(path, init),
  };
  const result = await callModelProviderOnce({
    provider,
    body: {
      model: APORIA_CLOUD_VISION_MODEL_ID,
      messages: buildVisionMessages(message, [image]),
      max_completion_tokens: APORIA_CLOUD_VISION_OUTPUT_TOKENS,
    },
    signal,
    onEvent,
  });
  const observation = String(result?.message?.content || "").trim();
  if (!observation) throw new Error("Aporia Cloud Vision returned an empty observation.");
  return observation;
}

async function prepareAporiaCloudVisionRequest(request, { signal, onEvent } = {}) {
  const capability = await getCloudVisionCapability({ signal });
  if (capability.status !== "ready") throw new Error("APORIA_CLOUD_VISION_NOT_READY: Cloud 视觉尚未配置就绪或暂时无法确认，请检查服务后重试。");
  const visionModelName = capability.model.name;
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const nextMessages = [];
  let imageCount = 0;

  for (const message of messages) {
    const images = imageAttachments(message);
    if (!images.length) {
      nextMessages.push(message);
      continue;
    }

    const observations = [];
    for (let index = 0; index < images.length; index += 1) {
      onEvent?.({
        type: "vision.proxy.started",
        provider: "Aporia Cloud",
        model: visionModelName,
        imageIndex: index + 1,
        imageCount: images.length,
      });
      const observation = await callAporiaCloudVision({
        message,
        image: images[index],
        signal,
        onEvent,
      });
      observations.push(
        images.length > 1 ? `Image ${index + 1}:\n${observation}` : observation,
      );
      imageCount += 1;
    }

    nextMessages.push(
      mergeVisionObservation(message, observations.join("\n\n"), {
        providerName: "Aporia Cloud",
        modelId: visionModelName,
      }),
    );
  }

  return {
    ...request,
    messages: nextMessages,
    visionProxy: {
      used: imageCount > 0,
      providerId: APORIA_CLOUD_PROVIDER_ID,
      modelId: APORIA_CLOUD_VISION_MODEL_ID,
      imageCount,
      billing: "weekly-quota",
    },
  };
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

export async function prepareVisionProxyRequest(request, { signal, onEvent } = {}) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  if (!hasImageAttachments(messages)) return request;

  // Cloud images are materialized once, before the Agent loop, through the
  // server-configured vision model after its readiness check. The resulting
  // text observation replaces raw images so tool-call
  // rounds cannot repeatedly send or repeatedly bill the same attachment.
  if (String(request?.providerId || "") === APORIA_CLOUD_PROVIDER_ID) {
    return prepareAporiaCloudVisionRequest(request, { signal, onEvent });
  }

  const records = await readProviderRecords();
  const main = resolveMainModel(records, request);
  if (modelSupportsVision(main.model)) return request;

  const candidate = selectVisionCandidate(records, {
    mainProviderId: request?.providerId,
    mainModelId: request?.modelId,
    visionProviderId: request?.visionProviderId,
    visionModelId: request?.visionModelId,
  });
  if (!candidate) throw new Error("VISION_NOT_CONFIGURED: 当前模型未声明原生视觉，也没有已配置的视觉代理。请在模型设置中声明原生视觉或配置视觉 Provider。");

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
