import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm, link, symlink, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeToolExecutor } from '../electron/runtime/native-tool-executor.js';
import { dispatchNativeTool } from '../electron/runtime/tool-dispatcher.js';
import { TOOL_REGISTRY } from '../electron/runtime/native-tool-catalog.js';
import { createPermissionPolicy } from '../electron/agent-core.js';
import { withDurableRun } from '../electron/runtime/durable-run.js';
import { configureNativeFileAccess } from '../electron/runtime/file-access-policy.js';
import { subagentToolPaths, SUBAGENT_ROLE_CONFIG, assertSubagentScope } from '../electron/runtime/subagent-model.js';
import { createLocalControlPolicy, withLocalControlPolicy } from '../electron/control/policy.js';

const root = await mkdtemp(join(tmpdir(), 'aporiax-temporary-check-tests-'));
const workspace = join(root, 'workspace'), recovery = join(root, 'recovery');
await mkdir(workspace);
let approvals = 0, checks = 0, skipped = 0;
const executor = createNativeToolExecutor({
  verifyExistingTarget: async (r, p) => resolve(r, p), verifyWritableTarget: async (r, p) => resolve(r, p),
  searchWorkspaceText: async () => ({}), calculateLineChanges: (before, after) => ({ additions: after ? 1 : 0, deletions: before ? 1 : 0 }),
  runGitCommand: async () => ({}),
});
const run = fn => withDurableRun({ workspacePath: workspace, recoveryDirectory: recovery, operation: async () => {} }, fn);
const call = (toolName, input, overrides = {}) => dispatchNativeTool({
  toolCall: { function: { name: toolName, arguments: JSON.stringify(input) } }, registry: TOOL_REGISTRY,
  permissionPolicy: createPermissionPolicy('workspace-write'), approvalMode: 'manual',
  parseArguments: t => JSON.parse(t.function.arguments), executeAuthorized: executor,
  requestApproval: async () => { approvals++; return { approved: true }; }, executeContext: { workspaceRoot: workspace }, ...overrides,
});
const create = (path, extra = {}) => call('write_file', { path, content: 'console.log("self-check");\n', temporary_self_check: true, ...extra });
const cleanup = path => call('cleanup_temporary_check', { path });
const test = async (name, fn) => { const result = await fn(); if (result === 'skip') { skipped++; console.log(`SKIP ${name}`); } else { checks++; console.log(`PASS ${name}`); } };
try {
  await test('registered script cleans up without asking even in manual mode', () => run(async () => {
    const made = await create('self-check.mjs'); assert.equal(made.modelResult.temporarySelfCheck, true);
    const result = await cleanup('self-check.mjs'); assert.equal(result.modelResult.deleted, true);
    assert.equal(result.change.afterMissing, true); assert.equal(result.modelResult.recoverable, true);
    await assert.rejects(lstat(join(workspace, 'self-check.mjs')), { code: 'ENOENT' }); assert.equal(approvals, 0);
    const backups = [];
    for (const directory of await readdir(recovery)) {
      const manifest = JSON.parse(await readFile(join(recovery, directory, 'manifest.json'), 'utf8'));
      for (const entry of manifest.files || manifest.entries || []) if (entry.path === 'self-check.mjs' && entry.afterMissing && entry.backup) backups.push(await readFile(join(recovery, directory, entry.backup), 'utf8'));
    }
    assert.ok(backups.includes('console.log("self-check");\n'), 'deletion must retain original bytes in recovery');
  }));
  await test('filename alone never grants cleanup authority', () => run(async () => {
    await writeFile(join(workspace, 'tmp-selftest.mjs'), 'user-file');
    await assert.rejects(cleanup('tmp-selftest.mjs'), /not registered/);
    assert.equal(await readFile(join(workspace, 'tmp-selftest.mjs'), 'utf8'), 'user-file');
  }));
  await test('existing file cannot be registered by overwriting it', () => run(async () => {
    await assert.rejects(create('tmp-selftest.mjs'), /newly created/);
    assert.equal(await readFile(join(workspace, 'tmp-selftest.mjs'), 'utf8'), 'user-file');
  }));
  await test('changed contents cannot be silently cleaned', () => run(async () => {
    await create('changed.mjs'); await writeFile(join(workspace, 'changed.mjs'), 'user edit');
    await assert.rejects(cleanup('changed.mjs'), /modified or replaced/);
    assert.equal(await readFile(join(workspace, 'changed.mjs'), 'utf8'), 'user edit');
  }));
  await test('new run/restart cannot inherit exemption from model history', async () => {
    await run(() => create('previous-run.mjs'));
    await run(() => assert.rejects(cleanup('previous-run.mjs'), /not registered/));
  });
  await test('registration requires a live task', async () => {
    await assert.rejects(create('no-task.mjs'), /active task/);
    await assert.rejects(lstat(join(workspace, 'no-task.mjs')), { code: 'ENOENT' });
  });
  await test('ordinary files without registration stay untouched', () => run(async () => {
    await call('write_file', { path: 'ordinary.mjs', content: 'deliverable' });
    await assert.rejects(cleanup('ordinary.mjs'), /not registered/);
  }));
  await test('external files cannot qualify even with global file access', () => run(async () => {
    configureNativeFileAccess(() => ({ enabled: true, protectedPaths: [] }));
    try { await assert.rejects(create(join(root, 'external.mjs')), /workspace file/); }
    finally { configureNativeFileAccess(() => ({ enabled: false, protectedPaths: [] })); }
    await assert.rejects(lstat(join(root, 'external.mjs')), { code: 'ENOENT' });
  }));
  await test('hard links never qualify', () => run(async () => {
    await create('linked.mjs'); await link(join(workspace, 'linked.mjs'), join(workspace, 'linked-alias.mjs'));
    await assert.rejects(cleanup('linked.mjs'), /modified or replaced/);
  }));
  await test('symlink replacement never qualifies', () => run(async () => {
    await create('replaced.mjs'); await rm(join(workspace, 'replaced.mjs'));
    try { await symlink(join(workspace, 'ordinary.mjs'), join(workspace, 'replaced.mjs')); }
    catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) return 'skip'; throw e; }
    await assert.rejects(cleanup('replaced.mjs'), /link|non-file/);
    assert.equal(await readFile(join(workspace, 'ordinary.mjs'), 'utf8'), 'deliverable');
  }));
  await test('extension/size restrictions are checked before writing', () => run(async () => {
    await assert.rejects(create('deliverable.html'), /small temporary/);
    await assert.rejects(create('huge.mjs', { content: 'x'.repeat(100_001) }), /small temporary/);
    await assert.rejects(lstat(join(workspace, 'deliverable.html')), { code: 'ENOENT' });
  }));
  await test('read-only and explicit deny remain authoritative', async () => {
    await run(async () => {
      await create('denied.mjs');
      await assert.rejects(call('cleanup_temporary_check', { path: 'denied.mjs' }, { permissionPolicy: createPermissionPolicy('read-only') }), /Permission denied/);
      await assert.rejects(call('cleanup_temporary_check', { path: 'denied.mjs' }, { permissionPolicy: createPermissionPolicy('workspace-write', { cleanup_temporary_check: 'deny' }) }), /Permission denied/);
      assert.ok((await lstat(join(workspace, 'denied.mjs'))).isFile());
    });
  });
  await test('explicit ask still prompts and user rejection prevents deletion', () => run(async () => {
    await create('ask.mjs'); let asked = false;
    await assert.rejects(call('cleanup_temporary_check', { path: 'ask.mjs' }, {
      permissionPolicy: createPermissionPolicy('workspace-write', { cleanup_temporary_check: 'ask' }),
      requestApproval: async () => { asked = true; return { approved: false }; },
    }), /rejected/); assert.equal(asked, true); assert.ok((await lstat(join(workspace, 'ask.mjs'))).isFile());
  }));
  await test('builder write scope recognizes cleanup as a write', async () => {
    assert.ok(SUBAGENT_ROLE_CONFIG.builder.tools.has('cleanup_temporary_check'));
    assert.deepEqual(subagentToolPaths('cleanup_temporary_check', { path: 'src/check.mjs' }), ['src/check.mjs']);
    assert.equal(createPermissionPolicy('builder-write').cleanup_temporary_check, 'allow');
    assert.throws(() => assertSubagentScope('cleanup_temporary_check', { path: 'other/check.mjs' }, ['src']), /outside/);
  });
  await test('external read-only grants cannot inherit cleanup permission', () => run(async () => {
    await create('external-grant.mjs');
    const policy = createLocalControlPolicy({ clientId: 'test', runId: 'test', workspaceRoot: workspace, permissionProfile: 'read_only' });
    await withLocalControlPolicy(policy, () => assert.rejects(cleanup('external-grant.mjs'), { code: 'LOCAL_CONTROL_FORBIDDEN' }));
    assert.ok((await lstat(join(workspace, 'external-grant.mjs'))).isFile());
  }));
  await test('workspace junction cannot redirect registration outside', () => run(async () => {
    const outside = join(root, 'outside'); await mkdir(outside);
    await symlink(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(create('escape/self-check.mjs'), /escapes|outside/);
    await assert.rejects(lstat(join(outside, 'self-check.mjs')), { code: 'ENOENT' });
  }));
  await test('uncertain recovery still requires human reconciliation', async () => {
    const operation = { operationId: 'old-cleanup', tool: 'cleanup_temporary_check', scope: null };
    await withDurableRun({ workspacePath: workspace, recoveryDirectory: recovery, operation: async () => {}, unresolved: [operation] }, async () => {
      let asked = false;
      await assert.rejects(call('cleanup_temporary_check', { path: 'ordinary.mjs' }, {
        requestApproval: async details => { asked = details.kind === 'recovery-reconciliation'; return { approved: false }; },
      }), /RECOVERY_RECONCILIATION_REQUIRED/);
      assert.equal(asked, true);
    });
  });
  console.log(`${checks} temporary cleanup checks passed; ${skipped} skipped (Windows symbolic-link privilege).`);
} finally {
  configureNativeFileAccess(() => ({ enabled: false, protectedPaths: [] }));
  // Only this freshly created test directory and its recovery copies.
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
  await rm(root, { recursive: true, force: true });
}
