import { app, safeStorage } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { providerChatEndpoint } from "./provider-config.js";
import { getDesktopAccountRuntime } from "./account/register-desktop-account-ipc.js";
import { callModelProviderOnce } from "./runtime/provider-stream.js";
import {
  APORIA_CLOUD_PROVIDER_ID,
  APORIA_CLOUD_VISION_MIN_REMAINING_RATIO,
  APORIA_CLOUD_VISION_MODEL_ID,
  buildVisionMessages,
  hasImageAttachments,
  imageAttachments,
  mergeVisionObservation,
  resolveAporiaCloudVisionAvailability,
  selectVisionCandidate,
} from "./vision-proxy-core.js";

const VISION_TIMEOUT_MS = 60_000;
const VISION_MAX_OUTPUT_TOKENS = 1_600;
const APORIA_CLOUD_VISION_MODEL_NAME = "Qwen3.5 Flash Vision";
const APORIA_CLOUD_MAX_IMAGE_DATA_URL_CHARS = 7_500_000;
const APORIA_CLOUD_VISION_OUTPUT_TOKENS = 900;
const DEFAULT_VISION_PROXY_SETTINGS = Object.freeze({
  cloudVisionEnabled: true,
  cloudVisionQuotaGuard: true,
});

function getProviderStorePath() {
  return join(app.getPath("userData"), "aporiax-providers.json");
}

function getVisionSettingsPath() {
  return join(app.getPath("userData"), "aporiax-vision-settings.json");
}

function normalizeVisionSettings(input = {}) {
  return {
    cloudVisionEnabled: input?.cloudVisionEnabled !== false,
    cloudVisionQuotaGuard: input?.cloudVisionQuotaGuard !== false,
    minRemainingRatio: APORIA_CLOUD_VISION_MIN_REMAINING_RATIO,
  };
}

export async function loadVisionProxySettings() {
  try {
    const record = JSON.parse(await readFile(getVisionSettingsPath(), "utf8"));
    return normalizeVisionSettings(record);
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return normalizeVisionSettings(DEFAULT_VISION_PROXY_SETTINGS);
  }
}

export async function saveVisionProxySettings(patch = {}) {
  const current = await loadVisionProxySettings();
  const next = normalizeVisionSettings({ ...current, ...patch });
  await writeFile(
    getVisionSettingsPath(),
    JSON.stringify({ version: 1, ...next }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  return next;
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
    onEvent: (payload) => {
      if (payload?.type !== "response.retry") return;
      onEvent?.({
        ...payload,
        type: "vision.proxy.retry",
        provider: "Aporia Cloud",
        model: APORIA_CLOUD_VISION_MODEL_NAME,
      });
    },
  });
  const observation = String(result?.message?.content || "").trim();
  if (!observation) throw new Error("Aporia Cloud Vision returned an empty observation.");
  return { observation, usage: result?.usage || null };
}

async function prepareAporiaCloudVisionRequest(
  request,
  { signal, onEvent, availability = null } = {},
) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const nextMessages = [];
  let imageCount = 0;
  let usage = null;

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
        model: APORIA_CLOUD_VISION_MODEL_NAME,
        imageIndex: index + 1,
        imageCount: images.length,
      });
      const result = await callAporiaCloudVision({
        message,
        image: images[index],
        signal,
        onEvent,
      });
      usage = result.usage || usage;
      observations.push(
        images.length > 1
          ? `Image ${index + 1}:\n${result.observation}`
          : result.observation,
      );
      imageCount += 1;
      onEvent?.({
        type: "vision.proxy.completed",
        provider: "Aporia Cloud",
        model: APORIA_CLOUD_VISION_MODEL_NAME,
        imageIndex: index + 1,
        imageCount: images.length,
        usage: result.usage || null,
      });
    }

    nextMessages.push(
      mergeVisionObservation(message, observations.join("\n\n"), {
        providerName: "Aporia Cloud",
        modelId: APORIA_CLOUD_VISION_MODEL_NAME,
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
      remainingRatio: availability?.remainingRatio ?? null,
      usage,
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

async function cloudVisionAvailability() {
  const settings = await loadVisionProxySettings();
  const accountRuntime = getDesktopAccountRuntime();
  let accountSnapshot = await accountRuntime.getSnapshot().catch(() => null);

  // The guard is meant to protect real remaining quota, not the snapshot from
  // the moment Desktop signed in. Refresh Account state immediately before a
  // managed visual call. This is an Account API refresh only; it does not invoke
  // a Cloud model or consume model quota by itself. If refresh is temporarily
  // unavailable, fall back to the last authenticated snapshot rather than
  // turning a transient Account API issue into a loss of all visual fallback.
  if (
    settings.cloudVisionQuotaGuard !== false &&
    accountSnapshot?.status === "authenticated"
  ) {
    accountSnapshot = await accountRuntime.refresh().catch(() => accountSnapshot);
  }

  return {
    settings,
    accountSnapshot,
    availability: resolveAporiaCloudVisionAvailability(
      accountSnapshot || {},
      settings,
    ),
  };
}

function hasExplicitVisionSelection(request) {
  return Boolean(
    String(request?.visionProviderId || "").trim() ||
    String(request?.visionModelId || "").trim(),
  );
}

async function prepareCustomVisionRequest(
  request,
  records,
  candidate,
  { signal, onEvent } = {},
) {
  if (!candidate) return request;
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const nextMessages = [];
  let proxiedImages = 0;
  for (const message of messages) {
    const images = imageAttachments(message);
    if (!images.length) {
      nextMessages.push(message);
      continue;
    }
    onEvent?.({
      type: "vision.proxy.started",
      provider: candidate.provider?.name || candidate.provider?.id || "Vision Provider",
      model: candidate.model?.name || candidate.model?.id || "vision-model",
      imageCount: images.length,
    });
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
    onEvent?.({
      type: "vision.proxy.completed",
      provider: candidate.provider?.name || candidate.provider?.id || "Vision Provider",
      model: candidate.model?.name || candidate.model?.id || "vision-model",
      imageCount: images.length,
    });
  }

  return {
    ...request,
    messages: nextMessages,
    visionProxy: {
      used: proxiedImages > 0,
      providerId: candidate.provider?.id || "",
      modelId: candidate.model?.id || "",
      imageCount: proxiedImages,
      billing: candidate.provider?.billing || "user-provider",
    },
  };
}

export async function prepareVisionProxyRequest(request, { signal, onEvent } = {}) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  if (!hasImageAttachments(messages)) return request;

  // Aporia Cloud's public main models remain text-first DeepSeek models. Their
  // image attachments are materialized once through the hidden Qwen vision
  // model before the Agent loop, so tool rounds never rebill the same image.
  if (String(request?.providerId || "") === APORIA_CLOUD_PROVIDER_ID) {
    return prepareAporiaCloudVisionRequest(request, { signal, onEvent });
  }

  const records = await readProviderRecords();
  const main = resolveMainModel(records, request);
  if (main.model?.supportsImages === true) return request;

  // Explicit custom proxy selection wins over the managed automatic route.
  if (hasExplicitVisionSelection(request)) {
    const explicit = selectVisionCandidate(records, {
      mainProviderId: request?.providerId,
      mainModelId: request?.modelId,
      visionProviderId: request?.visionProviderId,
      visionModelId: request?.visionModelId,
    });
    if (explicit) {
      return prepareCustomVisionRequest(request, records, explicit, {
        signal,
        onEvent,
      });
    }
  }

  // A signed-in Aporia Account gives any local/custom text model a managed pair
  // of eyes. Only the image is sent to Cloud; the main reasoning/tool loop stays
  // on the selected local/custom provider. The low-quota guard defaults to 20%.
  const cloud = await cloudVisionAvailability();
  if (cloud.availability.available) {
    return prepareAporiaCloudVisionRequest(request, {
      signal,
      onEvent,
      availability: cloud.availability,
    });
  }

  onEvent?.({
    type: "vision.proxy.skipped",
    provider: "Aporia Cloud",
    model: APORIA_CLOUD_VISION_MODEL_NAME,
    reason: cloud.availability.reason,
    remainingRatio: cloud.availability.remainingRatio,
  });

  // If Cloud Vision is disabled, signed out, or protected by the quota guard,
  // preserve the previous behavior and fall back to a user-configured vision
  // Provider when one exists.
  const candidate = selectVisionCandidate(records, {
    mainProviderId: request?.providerId,
    mainModelId: request?.modelId,
    visionProviderId: request?.visionProviderId,
    visionModelId: request?.visionModelId,
  });
  return prepareCustomVisionRequest(request, records, candidate, {
    signal,
    onEvent,
  });
}