import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { taskExecutionMode } from "../src/state/execution-mode.js";
import { getDefaultTaskConfig } from "../src/models/model-catalog.js";
import { planAgentBudget, runWithAgentBudget, currentExecutionMode } from "../electron/harness/agent-budget.js";
assert.equal(getDefaultTaskConfig([]).executionMode, "direct");
for (const value of [undefined, null, "", "unknown"]) assert.equal(taskExecutionMode(value), "direct");
for (const mode of ["direct", "safe", "isolated"]) {
  assert.equal(taskExecutionMode(mode), mode);
  const plan = planAgentBudget({ executionMode: taskExecutionMode(mode) });
  await runWithAgentBudget(plan, {}, async () => assert.equal(currentExecutionMode(), mode));
}
const renderer = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
const request = renderer.slice(renderer.indexOf("window.desktop.harness.run({"));
assert.match(request.slice(0, request.indexOf("messages:")), /executionMode: taskExecutionMode\(targetTask.executionMode\)/, "renderer must pass the selected mode to Harness");
console.log("Task execution defaults, explicit preservation and Harness payload wiring: PASS");
