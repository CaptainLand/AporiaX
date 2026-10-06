import assert from "node:assert/strict";
import { normalizeProviderInput, normalizeProviderModels, publicProviderSummary } from "../electron/provider-config.js";
import { compileProviderWire } from "../electron/runtime/native-provider-codec.js";
import { ToolProgressGuard } from "../electron/runtime/tool-progress-guard.js";
import { modelReasoningParameters } from "../shared/model-reasoning.js";
import { taskSuspensionLabel } from "../src/state/task-suspension.js";
import { getDefaultTaskConfig } from "../src/models/model-catalog.js";

// Offline regression: never contacts the relay or reads the user's settings.
const provider = normalizeProviderInput({ name: "Relay", baseUrl: "https://relay.invalid/v1", apiKey: "fixture", protocol: "chat-completions", models: [{ id: "claude-opus-5-5", supportsThinking: false, thinkingMode: "none" }] });
const model = provider.models[0];
assert.equal(model.supportsThinking, true, "legacy relay Claude must advertise reasoning support");
assert.equal(model.thinkingMode, "reasoning-effort");
assert.equal(provider.protocol, "chat-completions", "never change the user's transport");
assert.equal(provider.baseUrl, "https://relay.invalid/v1");
assert.equal(provider.apiKey, undefined, "normalization must not expose credentials");
const saved = { ...provider, encryptedKey: "opaque-fixture", models: [{ id: "claude-opus-5-5", supportsThinking: false, thinkingMode: "none" }] };
const before = structuredClone(saved);
assert.equal(publicProviderSummary(saved).models[0].supportsThinking, true);
assert.deepEqual(saved, before, "capability migration must not mutate a stored profile");
assert.equal(getDefaultTaskConfig([{ ...saved, id: "fixture" }]).effort, "medium");
assert.deepEqual(normalizeProviderModels([{ id: "unknown", supportsThinking: false }], "openai-compatible")[0].supportsThinking, false);

const guard = new ToolProgressGuard();
for (let i = 0; i < 6; i++) guard.observe({ tool: "list_directory", input: { path: "." }, result: { entries: [], resultRef: { id: String(i) } } });
assert.throws(() => guard.assertBudget(), /LOOP_NO_PROGRESS/, "stop before a seventh paid round");
const plans = new ToolProgressGuard();
for (let i = 0; i < 6; i++) plans.observe({ tool: "update_plan", input: { steps: [{ title: `Reword ${i}` }] }, result: { revision: i + 1 } });
assert.throws(() => plans.assertBudget(), /LOOP_NO_PROGRESS/, "rewording plans is not execution progress");

const wire = compileProviderWire({ ...provider, id: "test", protocol: "anthropic-messages", anthropicThinking: "manual" }, { model: model.id, messages: [{ role: "user", content: "fixture" }] });
assert.equal(wire.body.thinking.type, "adaptive");
assert.equal(wire.body.output_config.effort, "medium");
for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
  const body = { model: model.id, messages: [{ role: "user", content: "fixture" }], ...modelReasoningParameters(model, { modelId: model.id, thinking: false, effort }) };
  assert.equal(compileProviderWire({ ...provider, id: "test" }, body).body.reasoning_effort, effort);
  assert.equal(compileProviderWire({ ...provider, id: "test", protocol: "anthropic-messages" }, body).body.output_config.effort, effort);
}
assert.throws(() => modelReasoningParameters(model, { modelId: model.id, effort: "invalid" }), /Unsupported/);
assert.deepEqual(modelReasoningParameters({ supportsThinking: true, thinkingMode: "deepseek" }, { thinking: false, effort: "low" }), { thinking: { type: "disabled" } });
assert.deepEqual(modelReasoningParameters({ supportsThinking: true, thinkingMode: "deepseek" }, { thinking: true, effort: "max" }), { thinking: { type: "enabled" }, reasoning_effort: "max" });
const restored = new ToolProgressGuard({ snapshot: guard.snapshot() });
assert.throws(() => restored.assertBudget(), /LOOP_NO_PROGRESS/);
restored.reset(); restored.assertBudget();
const advancing = new ToolProgressGuard();
for (let i = 0; i < 10; i++) {
  advancing.observe({ tool: "update_plan", result: { revision: i } });
  advancing.observe({ tool: "read_file", input: { path: `new-${i}` }, result: { content: `evidence-${i}` } });
}
advancing.assertBudget();
const revisiting = new ToolProgressGuard();
for (let i = 0; i < 12; i++) {
  revisiting.observe({ tool: "read_file", input: { path: "common" }, result: { content: "same" } });
  revisiting.observe({ tool: "read_file", input: { path: `new-${i}` }, result: { content: `new evidence ${i}` } });
  revisiting.assertBudget();
}
const polling = new ToolProgressGuard();
for (let i = 0; i < 12; i++) polling.observe({ tool: "read_process", input: { process_id: "p", cursor: 1 }, result: { processId: "p", cursor: 1, output: "", status: "running" } });
new ToolProgressGuard({ snapshot: polling.snapshot() }).assertBudget();
assert.match(taskSuspensionLabel(["no-progress"]), /重复规划或读取/);
console.log("claude compatibility: PASS");
