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
  classifyAgentTask,
  currentAgentBudget,
  enforceAgentBudgetEvent,
  planAgentBudget,
  runWithAgentBudget,
} from "../electron/harness/agent-budget.js";

assert.equal(normalizeDesktopAgentMode("multi"), "multi");
assert.equal(normalizeDesktopAgentMode("MULTI"), "multi");
assert.equal(normalizeDesktopAgentMode("single"), "single");
assert.equal(normalizeDesktopAgentMode(undefined), "multi");
assert.equal(normalizeDesktopAgentMode("anything-else"), "multi");
assert.equal(applyDesktopAgentMode({}).desktopAgentMode, "multi");

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

const adaptiveSmall = applyDesktopAgentMode(
  {
    workspacePath: "C:/repo",
    permission: "workspace-write",
    messages: [{ role: "user", content: "实现登录按钮的小改动" }],
  },
  "multi",
);
assert.equal(adaptiveSmall.desktopAgentMode, "multi");
assert.equal(adaptiveSmall.builderOrchestration, true);
assert.equal(adaptiveSmall.agentBudget, undefined);
assert.equal(desktopAgentModeBudget("multi"), null);
const adaptiveSmallPlan = planAgentBudget(adaptiveSmall);
assert.notEqual(adaptiveSmallPlan.profile, "large");
assert.equal(adaptiveSmallPlan.limits.roles.builder, 0);

const adaptiveExploration = applyDesktopAgentMode(
  {
    workspacePath: "C:/repo",
    permission: "read-only",
    messages: [
      {
        role: "user",
        content: "Delegate a focused exploration of the persistence mechanism.",
      },
    ],
  },
  "multi",
);
assert.equal(classifyAgentTask(adaptiveExploration).profile, "read");
assert.equal(planAgentBudget(adaptiveExploration).limits.roles.explore, 1);

const adaptiveBackgroundExploration = applyDesktopAgentMode(
  {
    workspacePath: "C:/repo",
    permission: "read-only",
    messages: [
      {
        role: "user",
        content: "Explore persistence in the background, then report it.",
      },
    ],
  },
  "multi",
);
assert.equal(classifyAgentTask(adaptiveBackgroundExploration).profile, "read");
assert.equal(planAgentBudget(adaptiveBackgroundExploration).limits.roles.explore, 1);

const adaptiveLarge = applyDesktopAgentMode(
  {
    workspacePath: "C:/repo",
    permission: "workspace-write",
    messages: [
      {
        role: "user",
        content:
          "大型多模块并行架构重构：分别升级登录和注册模块，并完成测试验证。",
      },
    ],
  },
  "multi",
);
const adaptiveLargePlan = planAgentBudget(adaptiveLarge);
assert.equal(adaptiveLargePlan.profile, "large");
assert.equal(adaptiveLargePlan.locked, false);
assert.equal(adaptiveLargePlan.limits.roles.builder, 2);

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

assert.equal(DESKTOP_AGENT_MODE_STORAGE_KEY, "aporiax.agent-mode.v2");
const css = rendererTaskControlsCss();
assert.match(css, /desktop-run-duration/);
assert.match(css, /composer-multi-agent-toggle/);
assert.match(css, /data-tooltip/);
assert.match(css, /box-shadow: 0 0 7px/);
assert.doesNotMatch(css, /#ff4e76|255,\s*78,\s*118/i);

const script = rendererTaskControlsScript();
assert.match(script, /aporiax\.agent-mode\.v2/);
assert.match(script, /aporiax\.tasks\.v1/);
assert.match(script, /assistant-message-heading/);
assert.match(script, /composer-toolbar-left/);
assert.match(script, /agentMode/);
assert.match(script, /storedMode === "single" \? "single" : "multi"/);
assert.match(script, /建议默认开启 Multi/);
assert.match(script, /Recommended: keep Multi enabled/);

console.log("task runtime controls smoke: PASS");
