import assert from "node:assert/strict";
import { normalizeProviderInput, normalizeProviderModels, publicProviderSummary, createAporiaCloudProvider } from "../electron/provider-config.js";
import { modelSupportsVision, conversationContainsImages, isNativeVisionRejectedError, stripImagePartsFromMessages } from "../electron/model-vision.js";
import { exposeVisionProxyCapabilities, selectVisionCandidate } from "../electron/vision-proxy-core.js";
import { queryCloudVisionCapability } from "../electron/cloud-vision-capability.js";
import { providerModelsById, buildProviderModels } from "../src/state/provider-models.js";

const id = "deepseek-v4.1-flash";
const raw = { id: "ds", baseUrl: "https://api.example.invalid/v1", models: [{ id, imageInput: "native", name: "Preview", contextWindow: 200000, supportsThinking: true }] };
let record = normalizeProviderInput(raw);
for (let i = 0; i < 4; i++) {
  const exposed = exposeVisionProxyCapabilities([publicProviderSummary({ ...record, encryptedKey: "test-not-a-key" })])[0];
  assert.equal(exposed.models[0].nativeSupportsImages, true);
  record = normalizeProviderInput({ ...raw, models: buildProviderModels([id], providerModelsById(exposed.models)) }, record);
  assert.equal(record.models[0].supportsImages, true);
  assert.equal(record.models[0].name, "Preview");
  assert.equal(record.models[0].contextWindow, 200000);
  assert.equal(record.models[0].supportsThinking, true);
}
assert.equal(normalizeProviderInput({ ...raw, models: [id] }, record).models[0].imageInput, "native", "old ID-only clients do not erase overrides");
assert.equal(modelSupportsVision({ id: "qwen3.5-flash", imageInput: "text", supportsImages: true }), false);
assert.equal(modelSupportsVision({ id, imageInput: "native", supportsImages: false }), true);
assert.equal(normalizeProviderModels([{ id, architecture: { input_modalities: ["text", "image"] } }], "deepseek")[0].supportsImages, true);
assert.equal(normalizeProviderModels([{ id: "qwen3.5-flash", capabilities: { vision: false } }], "other")[0].imageInput, "native");
assert.equal(normalizeProviderModels([{ id: "qwen3.5-flash", capabilities: { vision: false } }], "other")[0].supportsImages, true);
assert.equal(normalizeProviderModels([{ id: "qwen3.5-flash", imageInput: "text" }], "other")[0].supportsImages, false);
assert.equal(normalizeProviderModels([{ id: "qwen3.5-flash" }], "other")[0].imageInput, "native");
assert.equal(publicProviderSummary(createAporiaCloudProvider()).models[0].imageInput, "text");
assert.equal(publicProviderSummary(createAporiaCloudProvider()).models[0].supportsImages, false);

const byok = { id: "ds", hasApiKey: true, models: [{ id, supportsImages: false }] };
const cloud = { id: "aporia-cloud", kind: "aporia-cloud", hasApiKey: false, models: [{ id: "aporia-cloud-default", supportsImages: false }] };
let exposed = exposeVisionProxyCapabilities([byok, cloud]);
assert.equal(exposed[0].models[0].supportsImageProxy, false);
assert.equal(exposed[1].models[0].supportsImageProxy, false, "Cloud presence alone must not imply readiness");
const ready = { status: "ready", verification: "configuration", model: { id: "aporia-cloud-vision", name: "Actual configured model", supportsImages: true } };
const readyCloud = { ...cloud, visionCapability: ready };
assert.equal(exposeVisionProxyCapabilities([byok, readyCloud])[0].models[0].supportsImageProxy, false, "BYOK does not silently spend Cloud quota");
assert.equal(exposeVisionProxyCapabilities([readyCloud])[0].models[0].visionProxy.modelName, ready.model.name);
const local = { id: "vision", hasApiKey: false, models: [{ id: "my-vision", imageInput: "native" }] };
assert.equal(selectVisionCandidate([byok, local, readyCloud]), null, "unconfigured providers cannot be selected");
const configured = { ...local, hasApiKey: true, encryptedKey: "test-not-a-key" };
exposed = exposeVisionProxyCapabilities([byok, configured, readyCloud]);
assert.equal(exposed[0].models[0].visionProxy.providerId, selectVisionCandidate([byok, configured, readyCloud], { mainProviderId: "ds", mainModelId: id }).provider.id);
assert.equal(exposeVisionProxyCapabilities(exposed)[0].models[0].nativeSupportsImages, false, "effective proxy support never becomes native");

let requests = 0;
const status = await queryCloudVisionCapability(async (path, init) => { requests++; assert.equal(path, "/v1/capabilities/vision"); assert.equal(init.method, "GET"); return Response.json(ready); });
assert.deepEqual(status, ready);
assert.equal(requests, 1);
for (const code of [401, 403, 404, 500]) assert.notEqual((await queryCloudVisionCapability(async () => new Response("", { status: code }))).status, "ready");
for (const data of [{ status: "ready" }, { ...ready, verification: "unknown" }, { ...ready, model: { ...ready.model, id: "unexpected" } }, { status: "unavailable" }]) {
  assert.notEqual((await queryCloudVisionCapability(async () => Response.json(data))).status, "ready");
}
assert.equal((await queryCloudVisionCapability(() => new Promise(() => {}), { timeoutMs: 20 })).status, "unknown");
assert.equal((await queryCloudVisionCapability(async () => { throw Error("network"); })).status, "unknown");

assert.equal(
  isNativeVisionRejectedError({ message: "unknown variant `image_url`, expected `text`" }),
  true,
);
assert.equal(
  isNativeVisionRejectedError({ message: "This model does not support images." }),
  true,
);
assert.equal(isNativeVisionRejectedError({ message: "rate limited" }), false);
assert.equal(
  conversationContainsImages([
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] },
  ]),
  true,
);
const stripped = stripImagePartsFromMessages([
  { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] },
]);
assert.equal(typeof stripped[0].content, "string");
assert.match(stripped[0].content, /省略图片附件/);
assert.equal(JSON.stringify(stripped).includes("image_url"), false);

console.log("Vision: native/text overrides, metadata roundtrips, configured-only proxy, BYOK/Cloud isolation, dynamic Cloud names, readiness errors/timeouts: PASS");
