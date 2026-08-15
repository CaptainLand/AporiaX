import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [
  visionProxy,
  visionCore,
  mainV2,
  preload,
  capabilityCards,
  accountRuntime,
  providerConfig,
] = await Promise.all([
  readFile(new URL("../electron/vision-proxy.js", import.meta.url), "utf8"),
  readFile(new URL("../electron/vision-proxy-core.js", import.meta.url), "utf8"),
  readFile(new URL("../electron/main-v2.js", import.meta.url), "utf8"),
  readFile(new URL("../electron/preload.cjs", import.meta.url), "utf8"),
  readFile(new URL("../src/settings/TaskCapabilityCards.jsx", import.meta.url), "utf8"),
  readFile(new URL("../electron/account/desktop-account-runtime.js", import.meta.url), "utf8"),
  readFile(new URL("../electron/provider-config.js", import.meta.url), "utf8"),
]);

assert.match(visionProxy, /aporia-cloud-vision/);
assert.match(visionProxy, /Qwen3\.5 Flash Vision/);
assert.match(visionProxy, /getDesktopAccountRuntime/);
assert.match(visionProxy, /fetchModelGateway/);
assert.match(visionProxy, /callModelProviderOnce/);
assert.match(visionProxy, /max_completion_tokens:\s*APORIA_CLOUD_VISION_OUTPUT_TOKENS/);
assert.match(visionProxy, /mergeVisionObservation/);
assert.match(visionProxy, /billing:\s*"weekly-quota"/);
assert.match(visionProxy, /cloudVisionAvailability/);
assert.match(visionProxy, /cloudVisionEnabled/);
assert.match(visionProxy, /cloudVisionQuotaGuard/);
assert.match(visionProxy, /prepareAporiaCloudVisionRequest\(request,/);
assert.match(visionProxy, /fallback to a user-configured vision/);

assert.match(visionCore, /APORIA_CLOUD_PROVIDER_ID\s*=\s*"aporia-cloud"/);
assert.match(visionCore, /APORIA_CLOUD_VISION_MODEL_ID\s*=\s*"aporia-cloud-vision"/);
assert.match(visionCore, /APORIA_CLOUD_VISION_MIN_REMAINING_RATIO\s*=\s*0\.2/);
assert.match(visionCore, /resolveAporiaCloudVisionAvailability/);
assert.match(visionCore, /quota-protected/);
assert.match(visionCore, /supportsImageProxy/);
assert.match(visionCore, /nativeSupportsImages/);

const prepareIndex = mainV2.indexOf("prepareVisionProxyRequest(seededRequest, {");
const runIndex = mainV2.indexOf("listener(event, preparedRequest)");
assert.ok(prepareIndex >= 0, "main-v2 must prepare Cloud vision before Harness execution");
assert.ok(runIndex > prepareIndex, "vision preprocessing must finish before the Agent loop starts");
assert.match(mainV2, /vision:settings:get/);
assert.match(mainV2, /vision:settings:set/);
assert.match(mainV2, /providersWithVisionAvailability/);
assert.match(mainV2, /emitVisionStatus/);

assert.match(preload, /vision:\s*\{/);
assert.match(preload, /vision:settings:get/);
assert.match(preload, /vision:settings:set/);
assert.match(capabilityCards, /Cloud 视觉增强/);
assert.match(capabilityCards, /20% 低额度保护/);
assert.match(capabilityCards, /cloudVisionEnabled/);
assert.match(capabilityCards, /cloudVisionQuotaGuard/);

assert.match(accountRuntime, /fetchModelGateway/);
assert.match(accountRuntime, /Authorization/);
assert.match(accountRuntime, /accessToken/);
assert.match(accountRuntime, /modelGatewayBaseUrl/);
assert.match(accountRuntime, /APORIAX_MODEL_GATEWAY_URL/);

const desktopSources = [
  visionProxy,
  visionCore,
  mainV2,
  preload,
  capabilityCards,
  accountRuntime,
  providerConfig,
].join("\n");
assert.doesNotMatch(desktopSources, /QWEN_VISION_API_KEY/);
assert.doesNotMatch(desktopSources, /dashscope\.aliyuncs\.com/i);
assert.doesNotMatch(desktopSources, /qwen-ci-key/i);

// The first-party vision model is deliberately hidden behind the managed
// Aporia Account/Gateway path; Desktop must never carry a Qwen provider secret.
assert.match(visionProxy, /kind:\s*"aporia-cloud"/);
assert.match(visionProxy, /authenticatedFetch/);

console.log("Aporia Cloud vision security smoke: ok");
