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
  classifyCommandPermission("npm install lodash", { executionMode: "safe" }).action,
  "allow",
);
assert.equal(
  classifyCommandPermission("npm install lodash", { executionMode: "safe" }).category,
  "dependency-mutation",
);
assert.equal(
  classifyCommandPermission("npm run dev", { executionMode: "safe" }).category,
  "development-server",
);
assert.equal(
  classifyCommandPermission("curl https://example.com/schema.json", { executionMode: "safe" }).category,
  "network-read",
);
assert.equal(
  classifyCommandPermission("curl -X POST https://example.com/api -d x=1", { executionMode: "safe" }).action,
  "ask",
);
assert.equal(
  classifyCommandPermission("curl -H 'Authorization: Bearer secret' https://example.com/api", { executionMode: "safe" }).category,
  "network-sensitive",
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

const featurePush = classifyCommandPermission("git push origin feature/agent", {
  executionMode: "safe",
});
assert.equal(featurePush.action, "allow");
assert.equal(featurePush.category, "remote-reversible");
assert.equal(
  classifyCommandPermission("git push origin main", { executionMode: "safe" }).category,
  "protected-branch-write",
);
assert.equal(
  classifyCommandPermission("git push", { executionMode: "safe" }).category,
  "remote-destination-ambiguous",
);
assert.equal(
  classifyCommandPermission("git push --force origin feature/agent", { executionMode: "isolated" }).category,
  "remote-destructive",
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