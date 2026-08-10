import assert from "node:assert/strict";
import {
  buildVisionMessages,
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
    models: [{ id: "deepseek-v4-pro", supportsImages: false }],
  },
  {
    id: "qwen",
    name: "Qwen",
    models: [{ id: "qwen3.5-flash", supportsImages: false }],
  },
];
const candidate = selectVisionCandidate(providers, {
  mainProviderId: "deepseek",
  mainModelId: "deepseek-v4-pro",
});
assert.equal(candidate.provider.id, "qwen");
assert.equal(candidate.model.id, "qwen3.5-flash");

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
