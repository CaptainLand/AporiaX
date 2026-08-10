import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const index = await readFile("index.html", "utf8");
const main = await readFile("src/main.jsx", "utf8");

assert.doesNotMatch(index, /runtime-ui-enhancements\.jsx/);
assert.doesNotMatch(index, /live-agent-status\.jsx/);
assert.doesNotMatch(index, /skill-status\.jsx/);
assert.doesNotMatch(index, /prompt-folding\.js/);
assert.doesNotMatch(index, /agent-process-mentions\.css/);

assert.match(main, /useTaskStore\(readSavedTasks\)/);
assert.match(main, /<RunDurationChip message=\{message\}/);
assert.match(main, /<LiveAgentStatus message=\{message\}/);
assert.match(main, /<AgentProcessTrace message=\{message\}/);
assert.match(main, /<FoldableUserPrompt content=\{message\.content\}/);
assert.match(main, /useWorkspaceMentionAutocomplete/);
assert.match(main, /<TaskCapabilityCards/);

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
