import assert from "node:assert/strict";
import {
  currentExecutionMode,
  planAgentBudget,
  runWithAgentBudget,
} from "../electron/harness/agent-budget.js";
import { projectSandboxStatusForExecutionMode } from "../electron/sandbox-runtime.js";

const directPlan = planAgentBudget({ executionMode: "direct" });
assert.equal(directPlan.executionMode, "direct");
await runWithAgentBudget(directPlan, {}, async () => {
  assert.equal(currentExecutionMode(), "direct");
  const nestedPlan = { ...planAgentBudget({}), executionMode: undefined };
  await runWithAgentBudget(nestedPlan, {}, async () => {
    assert.equal(currentExecutionMode(), "direct");
  });
});
assert.equal(currentExecutionMode(), null);

const rawDockerReady = {
  backend: "docker",
  state: "ready",
  available: true,
  localAvailable: true,
  autoApprovalSafe: true,
  detail: "Docker ready",
};
const direct = projectSandboxStatusForExecutionMode(rawDockerReady, "direct");
assert.equal(direct.executionProfile, "direct");
assert.equal(direct.backend, "host");
assert.equal(direct.available, false);
assert.equal(direct.dockerAvailable, true);
const safe = projectSandboxStatusForExecutionMode(rawDockerReady, "safe");
assert.equal(safe.executionProfile, "safe");
assert.equal(safe.backend, "local-workspace");
assert.equal(safe.available, false);
assert.equal(safe.localAvailable, true);
const isolated = projectSandboxStatusForExecutionMode(rawDockerReady, "isolated");
assert.equal(isolated.executionProfile, "isolated");
assert.equal(isolated.backend, "docker");
assert.equal(isolated.available, true);
const isolatedUnavailable = projectSandboxStatusForExecutionMode(
  { ...rawDockerReady, available: false, state: "engine-stopped" },
  "isolated",
);
assert.equal(isolatedUnavailable.available, false);
assert.equal(isolatedUnavailable.fallbackAvailable, false);

console.log("execution mode wiring smoke: PASS");
