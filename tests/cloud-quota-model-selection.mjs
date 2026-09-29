import assert from "node:assert/strict";
import { cloudModelAvailability, cloudVisionAvailability, projectCloudProvider } from "../shared/cloud-availability.js";
import { getAvailableModels, getModel } from "../src/models/model-catalog.js";
import { createAporiaCloudProvider } from "../electron/provider-config.js";

const cloud = createAporiaCloudProvider(), id = cloud.models[0].id;
const account = { status: "authenticated", models: [{ id, enabled: true, freeTierAllowed: true }],
  quota: { remainingRatio: 0 }, gatewayStatus: "verified",
  gatewayCapabilities: { protocolVersion: 1, modelGateway: { quotaAdmission: "actual-usage-v1" },
    models: [{ id, available: false, reason: "QUOTA_UNAVAILABLE", supportsImages: true,
      quota: { source: "weekly", remainingMicros: 0, exhausted: true } }] } };
const projected = value => getAvailableModels([projectCloudProvider(cloud, value)])[0];
for (const balance of [0, -100]) {
  const state = structuredClone(account); state.gatewayCapabilities.models[0].quota.remainingMicros = balance;
  assert.equal(projected(state).disabled, true);
  assert.match(projected(state).disabledReasonZh, /周额度已用完/);
  assert.equal(cloudModelAvailability(state, id).available, true, "in-flight runs still use authoritative quota pause/settlement");
  assert.equal(cloudVisionAvailability(state).available, true, "native image configuration is not a balance check");
}
for (const balance of [1, 100_000]) {
  const state = structuredClone(account);
  state.quota = { remainingMicros: balance, remainingRatio: balance / 1_000_000, availableRatio: 0, reservedRatio: 1 };
  state.gatewayCapabilities.models[0].quota = { source: "weekly", remainingMicros: balance, exhausted: true };
  assert.equal(projected(state).disabled, false, "tiny positive settled balance / in-flight holds must not disable selection");
  assert.equal(projected(state).disabledReasonZh, undefined, "refill clears the old reason");
}
const paid = structuredClone(account);
paid.models[0].freeTierAllowed = false;
paid.gatewayCapabilities.models[0].reason = "CREDITS_UNAVAILABLE";
paid.gatewayCapabilities.models[0].quota.source = "credits";
assert.match(projected(paid).disabledReasonZh, /余额已用完/);
paid.gatewayCapabilities.models[0].quota.remainingMicros = 5;
assert.equal(projected(paid).disabled, false, "paid credit model must not be disabled by exhausted free weekly quota");
const legacy = { status: "authenticated", models: account.models, quota: { remainingRatio: 0 } };
assert.equal(projected(legacy).disabled, true);
legacy.quota = { remainingRatio: 1, availableRatio: 0 };
assert.equal(projected(legacy).disabled, false, "legacy holds are not settled exhaustion in the picker");
const daily = structuredClone(account);
daily.quota.remainingRatio = 1;
daily.gatewayCapabilities.models[0] = { id, available: true, supportsImages: true, quota: {
  remainingMicros: 100, source: "weekly", dailyBudget: { policy: "provider-daily-v1", remainingMicros: 0,
    sampledAt: new Date().toISOString(), resetsAt: new Date(Date.now() + 60000).toISOString() } } };
assert.match(projected(daily).disabledReasonZh, /全站今日/);
daily.gatewayCapabilities.models[0].quota.dailyBudget.remainingMicros = 1;
daily.gatewayCapabilities.models[0].quota.dailyBudget.availableRatio = 0;
assert.equal(projected(daily).disabled, false);
daily.gatewayCapabilities.models[0].quota.dailyBudget.remainingMicros = 0;
daily.gatewayCapabilities.models[0].quota.dailyBudget.resetsAt = new Date(Date.now() - 1000).toISOString();
assert.equal(projected(daily).disabled, false, "a stale prior-day snapshot cannot permanently disable the model");
const own = { id: "my-key", name: "My API", models: [{ id: "own", name: "Own" }] };
assert.equal(projectCloudProvider(own, account), own);
const providers = [projectCloudProvider(cloud, account), own];
assert.equal(getModel(providers, cloud.id, id).disabled, true, "explicit selection stays on Cloud; never silently switch billing");
assert.equal(getModel(providers, own.id, "own").disabled, false);
assert.equal(projected({ ...account, status: "anonymous" }).disabled, true);
console.log("Cloud model selection: settled zero/negative, held/tiny positive, paid/free, shared daily reset, runtime pause separation and BYOK isolation: PASS");
