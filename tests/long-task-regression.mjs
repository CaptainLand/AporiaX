import { spawnSync } from "node:child_process";
const tests = [
  "reliability-storage", "privacy-no-sync", "project-script-trust", "human-constraints", "release-source",
  "context-continuation-regression", "mcp-deferred-catalog", "understanding-lock-recovery",
  "approval-response-regression", "builder-merge-regression", "builder-merge-crash",
  "harness-long-task-reliability", "runtime-worker-continuation", "runtime-context-recovery",
  "runtime-autonomous-builder", "runtime-efficiency-smoke", "runtime-background-integration",
  "runtime-concurrency-integration", "priority-one-runtime-smoke", "recovery-approval-regression",
  "run-store-sqlite-smoke", "task-runtime-rpc-smoke", "agent-runtime-broker-smoke",
  "deepseek-cache-smoke", "subagent-model-smoke", "subagent-loop-smoke",
  "provider-stream-smoke", "turn-coordinator-smoke", "witness-watchdog-smoke",
  "tool-dispatcher-smoke", "native-tool-catalog-smoke", "delivery-runtime-integration",
  "harness-v2-smoke", "harness-collaboration-smoke", "harness-v2-orchestration-smoke",
  "task-outcomes-browser",
];
let failed = 0;
for (const test of tests) {
  const result = spawnSync(process.execPath, ["tests/" + test + ".mjs"], { stdio: "inherit", windowsHide: true, timeout: 90000 });
  if (result.status !== 0) { failed++; console.error("FAILED:", test, result.error?.message || result.signal || result.status); }
}
console.log(`Long-task regression: ${tests.length - failed}/${tests.length} passed.`);
process.exitCode = failed ? 1 : 0;
