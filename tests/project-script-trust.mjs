import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolRegistry, createPermissionPolicy } from '../electron/agent-core.js';
import { dispatchNativeTool } from '../electron/runtime/tool-dispatcher.js';
import { projectScriptFingerprint } from '../electron/runtime/project-script-trust.js';
import { createHarnessTaskRuntime } from '../electron/harness/task-runtime.js';
import { createFullAutoApproval } from '../electron/runtime/full-auto-approval.js';
import { closeRunJournalStore } from '../electron/run-store.js';

const dir = await mkdtemp(join(tmpdir(), 'aporia-script-trust-'));
const data = join(dir, 'journal');
const registry = new ToolRegistry([{ risk: 'execute', definition: { type: 'function', function: { name: 'run_command', parameters: { type: 'object' } } } }]);
try {
  await mkdir(join(dir, 'scripts'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node scripts/test.js', build: 'node scripts/test.js' } }));
  await writeFile(join(dir, 'scripts/test.js'), '// arbitrary project code, never executed by this test');
  const input = { command: 'npm test' };
  const first = await projectScriptFingerprint(dir, input);
  assert.ok(first.fingerprint);
  assert.equal(await projectScriptFingerprint(dir, { command: 'npm test && other' }), null);
  assert.equal(await projectScriptFingerprint(dir, { command: 'npm test', cwd: '..' }), null);
  let prompts = 0, executions = 0;
  const runtime = createHarnessTaskRuntime({ dataDirectory: data, approvalGrantKey: () => 'unsafe-old-prefix-cache' });
  const dispatch = (requestApproval, approvalMode = 'smart-auto', command = 'npm test') => dispatchNativeTool({
    toolCall: { id: 'tool', function: { name: 'run_command', arguments: JSON.stringify({ command }) } }, registry,
    permissionPolicy: createPermissionPolicy('workspace-write'), approvalMode, executionMode: 'direct', requestApproval,
    parseArguments: (call) => JSON.parse(call.function.arguments), executeContext: { workspaceRoot: dir },
    executeAuthorized: async () => { executions++; return { modelResult: { exitCode: 0 } }; },
  });
  await runtime.start({ runId: 'trust', taskId: 'task', onEvent: (event) => {
    if (event.type === 'approval.required') {
      prompts++;
      assert.equal(event.approval.kind, 'project-script-trust');
      assert.equal(event.approval.canRememberForRun, true);
      runtime.respondApproval('trust', event.approval.id, { approved: true, scope: 'run' });
    }
  }, execute: async ({ requestApproval }) => {
    await dispatch(requestApproval); await dispatch(requestApproval, 'smart-auto', 'npm run build');
    assert.equal(prompts, 1, 'trusted scripts reuse this run grant');
    await writeFile(join(dir, 'scripts/test.js'), '// changed executable script');
    await dispatch(requestApproval); assert.equal(prompts, 2);
    await writeFile(join(dir, '.npmrc'), 'ignore-scripts=true\n');
    await dispatch(requestApproval); assert.equal(prompts, 3);
    return { status: 'completed' };
  } });
  const fullAuto = createFullAutoApproval({ approvalMode: 'full-auto', workspaceRoot: dir, requestApproval: () => { throw new Error('unexpected manual prompt'); } });
  await dispatch(fullAuto, 'full-auto'); assert.equal(executions, 5);
  let oncePrompts = 0;
  await runtime.start({ runId: 'once', taskId: 'task', onEvent: (event) => {
    if (event.type === 'approval.required') { oncePrompts++; runtime.respondApproval('once', event.approval.id, { approved: true, scope: 'once' }); }
  }, execute: async ({ requestApproval }) => { await dispatch(requestApproval); await dispatch(requestApproval); return { status: 'completed' }; } });
  assert.equal(oncePrompts, 2, 'once approval does not grant run-wide trust, new run does not inherit trust');
  await assert.rejects(dispatch(async () => {
    await writeFile(join(dir, 'scripts/test.js'), '// changed while approval was open'); return { approved: true };
  }), /PROJECT_SCRIPT_CHANGED/);
  console.log('Script trust: real dispatcher/runtime grant, script/config fingerprints, once/run isolation, TOCTOU recheck, full-auto unchanged: PASS');
} finally { await closeRunJournalStore(data); await rm(dir, { recursive: true, force: true }); }
