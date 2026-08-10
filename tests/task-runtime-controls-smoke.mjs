import assert from "node:assert/strict";
import {
  applyDesktopAgentMode,
  desktopAgentModeBudget,
  normalizeDesktopAgentMode,
} from "../electron/desktop-agent-mode.js";
import {
  DESKTOP_AGENT_MODE_STORAGE_KEY,
  rendererTaskControlsCss,
  rendererTaskControlsScript,
} from "../electron/desktop-task-controls.js";
import {
  currentAgentBudget,
  enforceAgentBudgetEvent,
  planAgentBudget,
  runWithAgentBudget,
} from "../electron/harness/agent-budget.js";

assert.equal(normalizeDesktopAgentMode("multi"), "multi");
assert.equal(normalizeDesktopAgentMode("MULTI"), "multi");
assert.equal(normalizeDesktopAgentMode("anything-else"), "single");

const single = applyDesktopAgentMode(
  {
    workspacePath: "C:/repo",
    permission: "workspace-write",
    messages: [{ role: "user", content: "大型多模块重构" }],
  },
  "single",
);
assert.equal(single.desktopAgentMode, "single");
assert.equal(single.builderOrchestration, false);
assert.equal(single.agentBudget.profile, "direct");
assert.equal(single.agentBudget.locked, true);
assert.equal(single.agentBudget.maxTotalSubagents, 0);
assert.equal(single.agentBudget.roles.builder, 0);

const multi = applyDesktopAgentMode(
  {
    workspacePath: "C:/repo",
    permission: "workspace-write",
    messages: [{ role: "user", content: "实现登录和注册" }],
  },
  "multi",
);
assert.equal(multi.desktopAgentMode, "multi");
assert.equal(multi.builderOrchestration, true);
assert.equal(multi.agentBudget.profile, "large");
assert.equal(multi.agentBudget.locked, true);
assert.equal(multi.agentBudget.roles.builder, 2);
assert.equal(desktopAgentModeBudget("multi").maxActiveSubagents, 4);

const lockedPlan = planAgentBudget(single);
assert.equal(lockedPlan.profile, "direct");
assert.equal(lockedPlan.locked, true);
await runWithAgentBudget(lockedPlan, {}, async () => {
  enforceAgentBudgetEvent({
    type: "plan.updated",
    plan: {
      steps: Array.from({ length: 9 }, (_, index) => ({
        id: `step-${index}`,
        title: `step ${index}`,
      })),
    },
  });
  enforceAgentBudgetEvent({ type: "file.changed", path: "src/a.js" });
  enforceAgentBudgetEvent({ type: "file.changed", path: "src/b.js" });
  enforceAgentBudgetEvent({ type: "file.changed", path: "src/c.js" });
  const current = currentAgentBudget();
  assert.equal(current.profile, "direct");
  assert.equal(current.locked, true);
  assert.equal(current.limits.maxTotalSubagents, 0);
});

assert.equal(DESKTOP_AGENT_MODE_STORAGE_KEY, "aporiax.agent-mode.v1");
const css = rendererTaskControlsCss();
assert.match(css, /desktop-run-duration/);
assert.match(css, /composer-multi-agent-toggle/);
assert.match(css, /ff4e76/i);

const script = rendererTaskControlsScript();
assert.match(script, /aporiax\.agent-mode\.v1/);
assert.match(script, /aporiax\.tasks\.v1/);
assert.match(script, /assistant-message-heading/);
assert.match(script, /composer-toolbar-left/);
assert.match(script, /agentMode/);
assert.match(script, /Main \+ up to 2 isolated Builders/);

console.log("task runtime controls smoke: PASS");
