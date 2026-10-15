import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [visionProxy, visionCore, mainV2, accountRuntime, providerConfig] = await Promise.all([
  readFile(new URL("../electron/vision-proxy.js", import.meta.url), "utf8"),
  readFile(new URL("../electron/vision-proxy-core.js", import.meta.url), "utf8"),
  readFile(new URL("../electron/main-v2.js", import.meta.url), "utf8"),
  readFile(new URL("../electron/account/desktop-account-runtime.js", import.meta.url), "utf8"),
  readFile(new URL("../electron/provider-config.js", import.meta.url), "utf8"),
]);

assert.doesNotMatch(visionProxy, /aporia-cloud-vision|callAporiaCloudVision|prepareAporiaCloudVisionRequest/);
assert.doesNotMatch(visionProxy, /Qwen3\.5 Flash Vision/);
assert.match(visionProxy, /getCloudVisionCapability/);
assert.match(visionProxy, /capability\.status !== "ready"/);
assert.match(visionProxy, /getDesktopAccountRuntime/);
assert.match(visionProxy, /fetchModelGateway/);
assert.doesNotMatch(visionProxy, /callModelProviderOnce/);
assert.match(visionProxy, /mergeVisionObservation/);
assert.match(providerConfig, /billing:\s*"weekly-quota"/);

assert.match(visionCore, /APORIA_CLOUD_PROVIDER_ID\s*=\s*"aporia-cloud"/);
assert.match(visionCore, /supportsImageProxy/);
assert.match(visionCore, /nativeSupportsImages/);

const prepareIndex = mainV2.indexOf("prepareVisionProxyRequest(seededRequest)");
const runIndex = mainV2.indexOf("listener(event, preparedRequest)");
assert.ok(prepareIndex >= 0, "main-v2 must prepare Cloud vision before Harness execution");
assert.ok(runIndex > prepareIndex, "vision preprocessing must finish before the Agent loop starts");

assert.match(accountRuntime, /fetchModelGateway/);
assert.match(accountRuntime, /Authorization/);
assert.match(accountRuntime, /accessToken/);
assert.match(accountRuntime, /modelGatewayBaseUrl/);
const endpointSource = await readFile(new URL("../electron/account/cloud-endpoints.js", import.meta.url), "utf8");
assert.match(accountRuntime, /loadCloudEndpoints/);
assert.match(endpointSource, /APORIAX_MODEL_GATEWAY_URL/);

const desktopSources = [visionProxy, visionCore, mainV2, accountRuntime, providerConfig].join("\n");
assert.doesNotMatch(desktopSources, /QWEN_VISION_API_KEY/);
assert.doesNotMatch(desktopSources, /dashscope\.aliyuncs\.com/i);
assert.doesNotMatch(desktopSources, /qwen-ci-key/i);

// The first-party vision model is deliberately hidden behind the managed
// Aporia Account/Gateway path; Desktop must never carry a Qwen provider secret.
assert.match(providerConfig, /kind:\s*"aporia-cloud"/);
assert.match(visionProxy, /return request/);

console.log("Aporia Cloud vision security smoke: ok");
