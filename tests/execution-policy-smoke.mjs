import assert from "node:assert/strict";
import {
  classifyCommandPermission,
  normalizeExecutionMode,
  resolveExecutionBackend,
} from "../electron/runtime/execution-policy.js";

assert.equal(normalizeExecutionMode("direct"), "direct");
assert.equal(normalizeExecutionMode("safe"), "safe");
assert.equal(normalizeExecutionMode("isolated"), "isolated");
assert.equal(normalizeExecutionMode("unknown"), "safe");

assert.deepEqual(
  resolveExecutionBackend({ executionMode: "direct" }),
  {
    mode: "direct",
    backend: "host",
    available: true,
    osIsolation: false,
    workspaceIsolation: false,
    networkIsolation: false,
  },
);
assert.equal(
  resolveExecutionBackend({
    executionMode: "safe",
    sandboxStatus: { localAvailable: true },
  }).backend,
  "local-workspace",
);
assert.equal(
  resolveExecutionBackend({
    executionMode: "isolated",
    sandboxStatus: { available: true },
  }).available,
  true,
);
assert.equal(
  resolveExecutionBackend({
    executionMode: "isolated",
    sandboxStatus: { available: false },
  }).available,
  false,
);

assert.equal(
  classifyCommandPermission("git status", { executionMode: "direct" }).action,
  "allow",
);
assert.equal(
  classifyCommandPermission("npm test", { executionMode: "direct" }).action,
  "allow",
);

assert.equal(
  classifyCommandPermission("npm test && echo done", { executionMode: "direct" }).action,
  "ask",
);
assert.equal(
  classifyCommandPermission("git status | cat", { executionMode: "safe" }).action,
  "ask",
);
assert.equal(
  classifyCommandPermission("npm test > result.txt", { executionMode: "safe" }).action,
  "ask",
);

assert.equal(
  classifyCommandPermission("node scripts/custom.js", { executionMode: "direct" }).action,
  "ask",
);
assert.equal(
  classifyCommandPermission("node scripts/custom.js", { executionMode: "safe" }).action,
  "ask",
);
assert.equal(
  classifyCommandPermission("node scripts/custom.js", { executionMode: "isolated" }).action,
  "allow",
);
assert.equal(
  classifyCommandPermission("npm install lodash", { executionMode: "isolated" }).action,
  "ask",
);
assert.equal(
  classifyCommandPermission("git push origin feature", { executionMode: "isolated" }).category,
  "remote-write",
);
assert.equal(
  classifyCommandPermission("git reset --hard HEAD~1", { executionMode: "safe" }).risk,
  "high",
);
assert.equal(
  classifyCommandPermission("rm -rf /", { executionMode: "isolated" }).action,
  "deny",
);

console.log("execution policy smoke: PASS");
