import assert from "node:assert/strict";
import {
  TASK_COMPLETION_TOAST_SELECTOR,
  desktopBackgroundStatus,
  normalizeActiveRunIds,
  shouldHideWindowOnClose,
  taskCompletionToastSuppressionCss,
} from "../electron/desktop-background-state.js";

assert.equal(shouldHideWindowOnClose(), true);
assert.equal(shouldHideWindowOnClose({ isQuitting: false }), true);
assert.equal(shouldHideWindowOnClose({ isQuitting: true }), false);

assert.deepEqual(
  normalizeActiveRunIds(["run-a", "run-b", "run-a", "", null]),
  ["run-a", "run-b"],
);

const idle = desktopBackgroundStatus([]);
assert.equal(idle.activeRuns, 0);
assert.equal(idle.statusLabel, "当前没有运行中的任务");
assert.equal(idle.tooltip, "AporiaX");

const working = desktopBackgroundStatus(["run-a", "run-b"]);
assert.equal(working.activeRuns, 2);
assert.deepEqual(working.activeRunIds, ["run-a", "run-b"]);
assert.match(working.statusLabel, /2 个任务/);
assert.match(working.tooltip, /2 个任务/);

assert.equal(TASK_COMPLETION_TOAST_SELECTOR, ".task-completion-toast");
assert.equal(
  taskCompletionToastSuppressionCss(),
  ".task-completion-toast{display:none!important;}",
);

console.log("desktop background smoke: PASS");
