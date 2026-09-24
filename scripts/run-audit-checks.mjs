// Curated, deterministic, platform-portable regression gate. GUI, native OCR
// and packaged tests run separately on Windows; no live model/API calls here.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const files = [
  'automatic-task-suspension.mjs',
  'agent-activity.mjs', 'subagent-contract.mjs', 'subagent-lifecycle-regression.mjs',
  'subagent-model-smoke.mjs', 'subagent-loop-smoke.mjs', 'native-tool-catalog-smoke.mjs',
  'self-check-coordinator-smoke.mjs', 'runtime-background-integration.mjs', 'route-activity-model.mjs', 'harness-event-reducer-smoke.mjs',
  'cloud-compatibility.mjs', 'cloud-outer-recovery.mjs', 'aporia-cloud-model-runtime-smoke.mjs', 'aporia-cloud-vision-smoke.mjs', 'model-onboarding.mjs', 'desktop-account-auth-smoke.mjs',
  'goal-brief-acceptance.mjs', 'goal-process-strategy.mjs', 'goal-native-provider.mjs', 'goal-loop-integration.mjs',
  'agent-led-workflow-regression.mjs',
  'harness-loop-unit.mjs', 'harness-loop-provider.mjs', 'harness-loop-integration.mjs',
  'audit-reliability.mjs', 'audit-migration-index.mjs', 'task-history-store-smoke.mjs', 'task-store-smoke.mjs',
  'approval-response-regression.mjs', 'builder-merge-regression.mjs', 'builder-merge-crash.mjs',
  'context-continuation-regression.mjs', 'mcp-deferred-catalog.mjs', 'understanding-lock-recovery.mjs',
  'reliability-storage.mjs', 'remote-command-inbox.mjs', 'project-script-trust.mjs', 'human-constraints.mjs', 'release-source.mjs',
  'task-runtime-rpc-smoke.mjs', 'run-store-sqlite-smoke.mjs',
  'native-tool-executor-smoke.mjs', 'tool-permissions-smoke.mjs', 'tool-dispatcher-smoke.mjs',
  'execution-policy-smoke.mjs', 'execution-mode-wiring-smoke.mjs',
  'harness-architecture-smoke.mjs', 'harness-collaboration-smoke.mjs', 'harness-v2-smoke.mjs', 'harness-v2-orchestration-smoke.mjs',
  'runtime-autonomous-builder.mjs', 'runtime-worker-continuation.mjs', 'runtime-context-recovery.mjs', 'harness-long-task-reliability.mjs',
  'release097-builders.mjs', 'release097-builder-capacity.mjs', 'release097-git.mjs',
  'sandbox-priority-regression.mjs', 'sandbox-harness-integration.mjs', 'sandbox-audit-probes.mjs',
  'mcp-runtime-smoke.mjs', 'extension-library-smoke.mjs', 'extension-ecosystem-regression.mjs', 'extension-discovery.mjs',
  'provider-stream-smoke.mjs', 'recovery-approval-regression.mjs', 'self-check-evidence-smoke.mjs',
  'tool-message-contract.mjs', 'runtime-tool-receipts.mjs', 'runtime-smoke.mjs',
];
const results = [];
const selected = process.argv.slice(2);
const report = process.env.AUDIT_REPORT || 'regression.json';
mkdirSync('.tmp/audit-results', { recursive: true });
for (const file of files.filter(file => !selected.length || selected.includes(file))) {
  console.log(`\n=== ${file} ===`);
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--experimental-sqlite', `tests/${file}`], {
    stdio: 'inherit', timeout: 120000, windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS || '', '--experimental-sqlite'].join(' ').trim() },
  });
  results.push({ file, passed: result.status === 0 && !result.error, exitCode: result.status, durationMs: Date.now() - started,
    ...(result.error ? { error: result.error.message } : {}) });
  writeFileSync(`.tmp/audit-results/${report}`, JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2));
}
mkdirSync('.tmp/audit-results', { recursive: true });
writeFileSync(`.tmp/audit-results/${report}`, JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2));
console.log(`\nAudit gate: ${results.filter(r => r.passed).length}/${results.length} scripts passed.`);
for (const result of results.filter(r => !r.passed)) console.error('FAILED:', result.file, result.error || result.exitCode);
if (results.some(r => !r.passed)) process.exitCode = 1;
