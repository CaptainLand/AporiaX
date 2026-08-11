import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const index = await readFile("index.html", "utf8");
const main = await readFile("src/main.jsx", "utf8");
const electronMain = await readFile("electron/main.js", "utf8");
const preload = await readFile("electron/preload.cjs", "utf8");
const conversation = await readFile(
  "src/conversation/ConversationViews.jsx",
  "utf8",
).catch(() => main);
const composer = await readFile("src/composer/Composer.jsx", "utf8").catch(
  () => main,
);
const settings = await readFile(
  "src/settings/SettingsPanel.jsx",
  "utf8",
).catch(() => main);
const runRetryCore = await readFile(
  "src/state/run-retry-core.js",
  "utf8",
);

assert.doesNotMatch(index, /runtime-ui-enhancements\.jsx/);
assert.doesNotMatch(index, /live-agent-status\.jsx/);
assert.doesNotMatch(index, /skill-status\.jsx/);
assert.doesNotMatch(index, /prompt-folding\.js/);
assert.doesNotMatch(index, /agent-process-mentions\.css/);

assert.match(main, /useTaskStore\(readSavedTasks\)/);
assert.match(conversation, /<RunDurationChip message=\{message\}/);
assert.doesNotMatch(conversation, /<LiveAgentStatus message=\{message\}/);
assert.doesNotMatch(conversation, /<AgentProcessTrace message=\{message\}/);
assert.match(conversation, /<WitnessPanel/);
assert.match(conversation, /createPortal\(/);
assert.match(conversation, /message\.supersededByRetryId/);
assert.match(conversation, /tr\("正在重试", "Retrying"\)/);
assert.match(main, /Promise\.resolve\(\)\s*\.then\(\(\) => window\.desktop\.harness\.run/);
assert.match(conversation, /message\.progressUpdates/);
assert.match(conversation, /assistant-progress-journal/);
assert.match(main, /const \[runningTaskIds, setRunningTaskIds\]/);
assert.match(main, /const \[activeRunIdsByTask, setActiveRunIdsByTask\]/);
assert.match(main, /run\.taskId === targetTask\.id/);
assert.match(main, /runningTaskIds\.has\(activeTask\.id\)/);
assert.doesNotMatch(main, /const \[runningTaskId, setRunningTaskId\]/);
assert.match(electronMain, /const activeRuns = new Map\(\)/);
assert.match(electronMain, /app\.requestSingleInstanceLock\(\)/);
assert.match(electronMain, /taskId: request\?\.taskId \|\| ""/);
assert.match(preload, /activeRuns: \(\) => ipcRenderer\.invoke\("harness:active-runs"\)/);
assert.match(main, /const retryMessage = async \(assistantMessage\)/);
assert.match(main, /executeTaskRetry\(\{/);
assert.match(main, /\(\) => window\.desktop\.harness\.activeRuns\(\)/);
assert.match(main, /无法重试本轮/);
assert.match(main, /Composer,\s+isImageAttachment,/);
assert.match(main, /force: true/);
assert.match(runRetryCore, /main-confirmed-idle/);
assert.match(runRetryCore, /removeRendererTaskRuns\(rendererRuns, taskId\)/);
assert.match(electronMain, /approvalGrants/);
assert.match(
  conversation,
  /<FoldableUserPrompt content=\{message\.content\}/,
);
assert.match(composer, /useWorkspaceMentionAutocomplete/);
assert.match(settings, /<TaskCapabilityCards/);

for (const path of [
  "src/runtime-ui-enhancements.jsx",
  "src/live-agent-status.jsx",
  "src/skill-status.jsx",
  "src/prompt-folding.js",
]) {
  await assert.rejects(
    () => access(path),
    /ENOENT/,
    `${path} should be removed after native renderer migration`,
  );
}

console.log("native renderer architecture smoke: PASS");
