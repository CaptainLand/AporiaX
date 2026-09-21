// Run every desktop gate and retain all failures; never depend on PowerShell's last exit code.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const tests = [
  ['node', 'model-onboarding-browser.mjs'],
  ['node', 'understanding-ui-browser.mjs'],
  ['node', 'workspace-preview-browser.mjs'],
  ['node', 'route-activity-model.mjs'],
  ['node', 'route-activity-browser.mjs'],
  ['node', 'knowledge-projects.mjs'],
  ['node', 'goal-ui-browser.mjs'],
  ['node', 'side-chat-smoke.mjs'], ['node', 'side-chat-browser.mjs'],
  ['node', 'workbench-git-smoke.mjs'], ['node', 'workbench-documents-git-browser.mjs'],
  ['node', 'workbench-git-setup-smoke.mjs'], ['node', 'workbench-git-setup-browser.mjs'],
  ['node', 'terminal-buffer-smoke.mjs'], ['node', 'terminal-v2-browser.mjs'],
  ['electron', 'terminal-v2-electron.cjs'], ['electron', 'workbench-document-electron.cjs'],
];
const results = [];
mkdirSync('.tmp/audit-results', { recursive: true });
for (const [runtime, file] of tests) {
  console.log(`\n=== Desktop ${runtime}: ${file} ===`);
  const started = Date.now();
  const result = spawnSync(runtime === 'node' ? process.execPath : electron,
    [...(runtime === 'node' ? ['--experimental-sqlite'] : []), `tests/${file}`],
    { stdio: 'inherit', windowsHide: true, timeout: 120000 });
  results.push({ file, runtime, passed: result.status === 0 && !result.error,
    exitCode: result.status, durationMs: Date.now() - started, error: result.error?.message });
  writeFileSync('.tmp/audit-results/desktop.json', JSON.stringify(results, null, 2));
}
console.log(`Desktop gate: ${results.filter(r => r.passed).length}/${results.length} passed`);
for (const failure of results.filter(r => !r.passed)) console.error('FAILED:', failure.file, failure.error || failure.exitCode);
if (results.some(r => !r.passed)) process.exitCode = 1;
