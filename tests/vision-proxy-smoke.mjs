import assert from "node:assert/strict";
import {
  buildVisionMessages,
  exposeVisionProxyCapabilities,
  hasImageAttachments,
  imageAttachments,
  mergeVisionObservation,
  modelSupportsVision,
  selectVisionCandidate,
} from "../electron/vision-proxy-core.js";

const image = {
  kind: "image",
  name: "error.png",
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,aGVsbG8=",
};
const pdf = {
  kind: "document",
  name: "notes.pdf",
  mimeType: "application/pdf",
  text: "notes",
};

assert.equal(modelSupportsVision({ id: "deepseek-v4-pro" }), false);
assert.equal(
  modelSupportsVision({ id: "qwen3.5-flash", supportsImages: false }),
  true,
);
assert.equal(modelSupportsVision({ id: "gemini-2.5-flash" }), true);

assert.equal(hasImageAttachments([{ role: "user", attachments: [image] }]), true);
assert.equal(imageAttachments({ attachments: [pdf] }).length, 0);

const providers = [
  {
    id: "deepseek",
    name: "DeepSeek",
    hasApiKey: true,
    models: [{ id: "deepseek-v4-pro", supportsImages: false }],
  },
  {
    id: "qwen",
    name: "Qwen",
    hasApiKey: true,
    models: [
      { id: "qwen3.7-flash", supportsImages: false },
      { id: "qwen3.6-flash", supportsImages: false },
      { id: "qwen3.5-flash-2026-02-23", supportsImages: false },
      { id: "qwen3.5-flash", supportsImages: false },
    ],
  },
];
const candidate = selectVisionCandidate(providers, {
  mainProviderId: "deepseek",
  mainModelId: "deepseek-v4-pro",
});
assert.equal(candidate.provider.id, "qwen");
assert.equal(candidate.model.id, "qwen3.5-flash");

const exposedProviders = exposeVisionProxyCapabilities(providers);
const exposedDeepSeek = exposedProviders
  .find((provider) => provider.id === "deepseek")
  .models.find((model) => model.id === "deepseek-v4-pro");
const exposedQwen = exposedProviders
  .find((provider) => provider.id === "qwen")
  .models.find((model) => model.id === "qwen3.5-flash");
assert.equal(exposedDeepSeek.supportsImages, true);
assert.equal(exposedDeepSeek.nativeSupportsImages, false);
assert.equal(exposedDeepSeek.supportsImageProxy, true);
assert.equal(exposedDeepSeek.visionProxy.providerId, "qwen");
assert.equal(exposedDeepSeek.visionProxy.modelId, "qwen3.5-flash");
assert.equal(exposedQwen.supportsImages, true);
assert.equal(exposedQwen.nativeSupportsImages, true);
assert.equal(exposedQwen.supportsImageProxy, false);
assert.equal(exposedQwen.visionProxy, null);

const noKeyProviders = exposeVisionProxyCapabilities([
  {
    id: "deepseek",
    hasApiKey: true,
    models: [{ id: "deepseek-v4-pro", supportsImages: false }],
  },
  {
    id: "qwen",
    hasApiKey: false,
    models: [{ id: "qwen3.5-flash", supportsImages: false }],
  },
]);
assert.equal(noKeyProviders[0].models[0].supportsImages, false);
assert.equal(noKeyProviders[0].models[0].supportsImageProxy, false);
assert.equal(noKeyProviders[0].models[0].visionProxy, null);
assert.equal(noKeyProviders[1].models[0].nativeSupportsImages, true);

const explicitCandidate = selectVisionCandidate(providers, {
  mainProviderId: "deepseek",
  mainModelId: "deepseek-v4-pro",
  visionModelId: "qwen3.6-flash",
});
assert.equal(explicitCandidate.model.id, "qwen3.6-flash");

const messages = buildVisionMessages({
  content: "What is wrong in this screenshot?",
  attachments: [image],
});
assert.equal(messages[1].content[1].type, "image_url");
assert.equal(messages[1].content[1].image_url.url, image.dataUrl);

const merged = mergeVisionObservation(
  {
    role: "user",
    content: "Please fix this.",
    attachments: [image, pdf],
  },
  "Visible error: Module not found",
  { providerName: "Qwen", modelId: "qwen3.5-flash" },
);
assert.match(merged.content, /Vision proxy observation/);
assert.match(merged.content, /Module not found/);
assert.equal(merged.attachments.length, 1);
assert.equal(merged.attachments[0].name, "notes.pdf");

console.log("vision proxy smoke: ok");
