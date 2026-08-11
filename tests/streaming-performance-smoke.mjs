import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const hook = await readFile("src/hooks/useHarnessEvents.js", "utf8");
const main = await readFile("src/main.jsx", "utf8");
const provider = await readFile("electron/runtime/provider-stream.js", "utf8");

assert.match(provider, /onEvent\?\.\(\{ type: "response\.delta", delta: delta\.content \}\)/);
assert.match(hook, /const STREAM_FLUSH_MS = 24;/);
assert.match(hook, /const pendingDeltas = new Map\(\);/);
assert.match(hook, /pendingDeltas\.set\(/);
assert.match(hook, /scheduleDeltaFlush\(\);/);
assert.match(hook, /type: "stream\.delta\.flush"/);
assert.match(hook, /discardPendingDelta\(event\.runId\);/);
assert.match(hook, /flushPendingDeltas\(\);\r?\n        const now = new Date\(\)\.toISOString\(\);/);

const deltaBranch = hook.slice(
  hook.indexOf('if (event.type === "response.delta")'),
  hook.indexOf('if (event.type === "response.retry")'),
);
assert.doesNotMatch(deltaBranch, /setTasks\(/);

assert.match(
  main,
  /tasksRef\.current = tasks;\r?\n  \}, \[tasks\]\);\r?\n\r?\n  useEffect\(\(\) => \{[\s\S]*?cacheTasksLocally\(tasks\);[\s\S]*?\}, 750\);/,
);

console.log("streaming performance smoke: PASS");
