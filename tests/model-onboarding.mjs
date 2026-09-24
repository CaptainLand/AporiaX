import assert from "node:assert/strict";
import { getAvailableModels, getDefaultTaskConfig, getModel } from "../src/models/model-catalog.js";
import { createAporiaCloudProvider } from "../electron/provider-config.js";
const cloud = createAporiaCloudProvider();
const own = { id: "own", name: "Own API", models: [{ id: "own-model", name: "Own model", supportsThinking: true }] };
for (const status of [undefined, "booting", "anonymous", "error", "unavailable"]) {
  const records = [{ ...cloud, accountStatus: status }];
  assert.equal(getAvailableModels(records).length, 1, "Only managed Flash remains visible");
  assert.ok(getAvailableModels(records).every((model) => model.disabled));
  assert.equal(getDefaultTaskConfig(records).modelId, "");
  assert.equal(getModel(records, "", "").id, "");
  assert.equal(getDefaultTaskConfig([...records, own]).providerId, "own");
  assert.equal(getModel([...records, own], cloud.id, cloud.models[0].id).disabled, true, "No silent billing-route fallback");
}
const authenticated = [{ ...cloud, accountStatus: "authenticated", cloudCatalogVerified: true }, own];
assert.equal(getModel(authenticated, cloud.id, "aporia-cloud-pro").disabled, true, "Retired Pro tasks require an explicit new selection");
assert.equal(getModel(authenticated, cloud.id, "aporia-cloud-vision").disabled, true, "Retired Qwen is not selectable");
assert.ok(getAvailableModels(authenticated).every((model) => !model.disabled));
assert.equal(getDefaultTaskConfig(authenticated).providerId, cloud.id);
assert.equal(getModel(authenticated, own.id, "own-model").providerId, own.id);
assert.equal(getModel(authenticated, "removed", "own-model").disabled, true, "Same model ID in a different provider is not the same billing route");
assert.equal(getDefaultTaskConfig([]).modelId, "");
assert.equal(getDefaultTaskConfig([{ id: "ollama", vendor: "local", models: [{ id: "local" }] }]).modelId, "local", "Local endpoints do not require Cloud login");
console.log("PASS model onboarding: five unavailable account states, Cloud unlock, custom/local defaults, explicit billing route preservation and missing model.");
