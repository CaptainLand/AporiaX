import assert from "node:assert/strict";
import {
  TASK_COMPLETION_TOAST_SELECTOR,
  desktopBackgroundStatus,
  formatDesktopRunDuration,
  normalizeActiveRunIds,
  normalizeActiveRunRecords,
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
assert.deepEqual(
  normalizeActiveRunRecords([
    { runId: "run-a", startedAt: 1_000 },
    { runId: "run-a", startedAt: 2_000 },
    { runId: "run-b", startedAt: 3_000 },
  ]).map((record) => record.runId),
  ["run-a", "run-b"],
);
assert.equal(formatDesktopRunDuration(4_200), "4.2s");
assert.equal(formatDesktopRunDuration(83_000), "1m 23s");
assert.equal(formatDesktopRunDuration(3_723_000), "1h 2m 3s");

const idle = desktopBackgroundStatus([]);
assert.equal(idle.activeRuns, 0);
assert.equal(idle.statusLabel, "当前没有运行中的任务");
assert.equal(idle.tooltip, "AporiaX");

const working = desktopBackgroundStatus(["run-a", "run-b"]);
assert.equal(working.activeRuns, 2);
assert.deepEqual(working.activeRunIds, ["run-a", "run-b"]);
assert.match(working.statusLabel, /2 个任务/);
assert.match(working.tooltip, /2 个任务/);

const timed = desktopBackgroundStatus(
  [{ runId: "run-a", startedAt: 1_000 }],
  84_000,
);
assert.equal(timed.activeRuns, 1);
assert.equal(timed.durationLabel, "1m 23s");
assert.match(timed.statusLabel, /1m 23s/);
assert.match(timed.tooltip, /1m 23s/);

assert.equal(TASK_COMPLETION_TOAST_SELECTOR, ".task-completion-toast");
assert.equal(
  taskCompletionToastSuppressionCss(),
  ".task-completion-toast{display:none!important;}",
);

console.log("desktop background smoke: PASS");
