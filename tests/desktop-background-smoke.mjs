import assert from "node:assert/strict";
import {
  TASK_COMPLETION_TOAST_SELECTOR,
  TRAY_EDUCATION_MARKER,
  desktopBackgroundStatus,
  formatTaskDuration,
  normalizeActiveRunIds,
  shouldHideWindowOnClose,
  taskCompletionToastSuppressionCss,
  trayEducationNotificationText,
} from "../electron/desktop-background-state.js";
import {
  taskRuntimeDisplayCss,
  taskRuntimeDisplayScript,
} from "../electron/desktop-runtime-display.js";

assert.equal(shouldHideWindowOnClose(), true);
assert.equal(shouldHideWindowOnClose({ isQuitting: false }), true);
assert.equal(shouldHideWindowOnClose({ isQuitting: true }), false);

assert.deepEqual(
  normalizeActiveRunIds(["run-a", "run-b", "run-a", "", null]),
  ["run-a", "run-b"],
);

assert.equal(formatTaskDuration(8_400), "8.4s");
assert.equal(formatTaskDuration(137_000), "2m 17s");
assert.equal(formatTaskDuration(3_793_000), "1h 3m 13s");

const idle = desktopBackgroundStatus([]);
assert.equal(idle.activeRuns, 0);
assert.equal(idle.statusLabel, "当前没有运行中的任务");
assert.equal(idle.tooltip, "AporiaX");

const working = desktopBackgroundStatus(
  [
    { id: "run-a", startedAt: 1_000 },
    { id: "run-b", startedAt: 31_000 },
  ],
  { now: 138_000 },
);
assert.equal(working.activeRuns, 2);
assert.deepEqual(working.activeRunIds, ["run-a", "run-b"]);
assert.equal(working.runtimeLabel, "2m 17s");
assert.match(working.statusLabel, /2 个任务正在后台运行 · 2m 17s/);
assert.match(working.tooltip, /2 个任务运行中 · 2m 17s/);

const legacyWorking = desktopBackgroundStatus(["run-a", "run-b"]);
assert.equal(legacyWorking.activeRuns, 2);
assert.match(legacyWorking.statusLabel, /2 个任务/);

assert.equal(TRAY_EDUCATION_MARKER, ".aporiax-tray-hint-shown-v1");
const trayEducation = trayEducationNotificationText();
assert.match(trayEducation.title, /已收至系统托盘/);
assert.match(trayEducation.body, /继续在后台运行/);
assert.match(trayEducation.body, /退出 AporiaX/);

assert.equal(TASK_COMPLETION_TOAST_SELECTOR, ".task-completion-toast");
assert.equal(
  taskCompletionToastSuppressionCss(),
  ".task-completion-toast{display:none!important;}",
);

const runtimeCss = taskRuntimeDisplayCss();
assert.match(runtimeCss, /desktop-run-duration/);
assert.match(runtimeCss, /aporiax-runtime-pulse/);
const runtimeScript = taskRuntimeDisplayScript();
assert.match(runtimeScript, /aporiax\.tasks\.v1/);
assert.match(runtimeScript, /assistant-message-heading/);
assert.match(runtimeScript, /Task runtime/);
assert.doesNotMatch(runtimeScript, /agent-mode|Multi-Agent|Single Agent/);

console.log("desktop background smoke: PASS");
