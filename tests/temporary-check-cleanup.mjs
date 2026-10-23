import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm, link, symlink, readdir, rename } from 'node:fs/promises';
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
import { validateTemporaryCheckCreation } from '../electron/runtime/temporary-check-files.js';

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
const refusal = (reason, message) => error => {
  assert.equal(error.code, 'TEMPORARY_CHECK_REFUSED');
  assert.equal(error.reason, reason);
  assert.match(error.message, message);
  return true;
};
const recoveryCopies = async path => {
  const copies = [];
  for (const directory of await readdir(recovery)) {
    const manifest = JSON.parse(await readFile(join(recovery, directory, 'manifest.json'), 'utf8'));
    for (const entry of manifest.files || manifest.entries || []) if (entry.path === path && entry.afterMissing && entry.backup) copies.push(await readFile(join(recovery, directory, entry.backup), 'utf8'));
  }
  return copies;
};
const test = async (name, fn) => { const result = await fn(); if (result === 'skip') { skipped++; console.log(`SKIP ${name}`); } else { checks++; console.log(`PASS ${name}`); } };
try {
  await test('HTML/HTM test pages register and clean recoverably without a prompt', () => run(async () => {
    const content = '<!doctype html><meta charset="utf-8"><title>临时测试</title><p>frame</p>\n';
    for (const path of ['self-check.html', 'self-check.htm', 'self-check-uppercase.HTML']) {
      const made = await create(path, { content });
      assert.equal(made.modelResult.temporarySelfCheck, true);
      assert.equal(made.modelResult.cleanupTool, 'cleanup_temporary_check');
      const result = await cleanup(path);
      assert.equal(result.modelResult.deleted, true);
      assert.equal(result.modelResult.recoverable, true);
      assert.equal(result.change.beforeContent, content);
      await assert.rejects(lstat(join(workspace, path)), { code: 'ENOENT' });
      assert.ok((await recoveryCopies(path)).includes(content));
    }
    assert.equal(approvals, 0);
  }));
  await test('tracked HTML writes, both patches and re-registration retain cleanup ownership', () => run(async () => {
    const path = 'editable-page.html';
    await create(path, { content: '<p>one</p>\n' });
    const updated = await call('write_file', { path, content: '<p>two</p>\n' });
    assert.equal(updated.modelResult.temporarySelfCheck, true);
    await call('apply_patch', { path, old_text: 'two', new_text: 'three' });
    await call('apply_patch', { patch: '*** Begin Patch\n*** Update File: editable-page.html\n@@\n-<p>three</p>\n+<p>four</p>\n*** End Patch' });
    await create(path, { content: '<p>five</p>\n' });
    const result = await cleanup(path);
    assert.equal(result.modelResult.deleted, true);
    assert.equal(result.change.beforeContent, '<p>five</p>\n');
  }));
  await test('tracked writes and both patch formats preserve temporary ownership', () => run(async () => {
    await create('editable.mjs');
    await call('write_file', { path: 'editable.mjs', content: 'const a = 1;\n' });
    await call('apply_patch', { path: 'editable.mjs', old_text: 'a = 1', new_text: 'a = 2' });
    await call('apply_patch', { patch: '*** Begin Patch\n*** Update File: editable.mjs\n@@\n-const a = 2;\n+const a = 3;\n*** End Patch' });
    assert.equal((await cleanup('editable.mjs')).modelResult.deleted, true);
  }));
  await test('explicit re-registration only works for the same owned script', () => run(async () => {
    await create('register-again.mjs'); await create('register-again.mjs', { content: 'console.log(2);' });
    assert.equal((await cleanup('register-again.mjs')).modelResult.deleted, true);
    await create('externally-edited.mjs'); await writeFile(join(workspace, 'externally-edited.mjs'), 'user edit');
    await call('write_file', { path: 'externally-edited.mjs', content: 'agent edit' });
    await assert.rejects(cleanup('externally-edited.mjs'), /modified|registered/);
  }));
  await test('registered script cleans up without asking even in manual mode', () => run(async () => {
    const made = await create('self-check.mjs'); assert.equal(made.modelResult.temporarySelfCheck, true);
    const result = await cleanup('self-check.mjs'); assert.equal(result.modelResult.deleted, true);
    assert.equal(result.change.afterMissing, true); assert.equal(result.modelResult.recoverable, true);
    await assert.rejects(lstat(join(workspace, 'self-check.mjs')), { code: 'ENOENT' }); assert.equal(approvals, 0);
    const backups = await recoveryCopies('self-check.mjs');
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
    await run(() => create('previous-run.html', { content: '<p>old task</p>' }));
    await run(() => assert.rejects(cleanup('previous-run.html'), refusal('NOT_REGISTERED', /not registered/)));
  });
  await test('registration requires a live task', async () => {
    await assert.rejects(create('no-task.mjs'), /active task/);
    await assert.rejects(lstat(join(workspace, 'no-task.mjs')), { code: 'ENOENT' });
  });
  await test('ordinary files without registration stay untouched', () => run(async () => {
    await call('write_file', { path: 'ordinary.mjs', content: 'deliverable' });
    await assert.rejects(cleanup('ordinary.mjs'), /not registered/);
  }));
  await test('ordinary and existing HTML files never gain automatic deletion authority', () => run(async () => {
    const path = 'user-page.html', content = '<p>User deliverable</p>';
    await call('write_file', { path, content });
    await assert.rejects(cleanup(path), refusal('NOT_REGISTERED', /not registered/));
    await assert.rejects(create(path), refusal('NOT_OWNED', /newly created/));
    assert.equal(await readFile(join(workspace, path), 'utf8'), content);
  }));
  await test('externally edited HTML cannot be re-registered or automatically deleted', () => run(async () => {
    const path = 'user-edited.html';
    await create(path, { content: '<p>original</p>' });
    await writeFile(join(workspace, path), '<p>User edit</p>');
    await assert.rejects(create(path, { content: '<p>agent overwrite</p>' }), refusal('NOT_OWNED', /externally changed/));
    await assert.rejects(cleanup(path), refusal('FILE_CHANGED', /modified or replaced/));
    assert.equal(await readFile(join(workspace, path), 'utf8'), '<p>User edit</p>');
  }));
  await test('replacing HTML with identical bytes does not bypass file identity checks', () => run(async () => {
    const path = 'replaced-page.html', content = '<p>same bytes</p>';
    await create(path, { content });
    await rename(join(workspace, path), join(workspace, 'replaced-page-original.html'));
    await writeFile(join(workspace, path), content);
    await assert.rejects(cleanup(path), refusal('FILE_CHANGED', /modified or replaced/));
    assert.equal(await readFile(join(workspace, path), 'utf8'), content);
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
    await create('linked-page.html', { content: '<p>linked</p>' });
    await link(join(workspace, 'linked-page.html'), join(workspace, 'linked-page-alias.html'));
    await assert.rejects(cleanup('linked-page.html'), refusal('FILE_CHANGED', /modified or replaced/));
    assert.equal(await readFile(join(workspace, 'linked-page-alias.html'), 'utf8'), '<p>linked</p>');
  }));
  await test('symlink replacement never qualifies', () => run(async () => {
    await create('replaced.mjs'); await rm(join(workspace, 'replaced.mjs'));
    try { await symlink(join(workspace, 'ordinary.mjs'), join(workspace, 'replaced.mjs')); }
    catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) return 'skip'; throw e; }
    await assert.rejects(cleanup('replaced.mjs'), /link|non-file/);
    assert.equal(await readFile(join(workspace, 'ordinary.mjs'), 'utf8'), 'deliverable');
  }));
  await test('unsupported types and oversized content report distinct reasons before writing', () => run(async () => {
    await assert.rejects(create('unsupported.json'), refusal('UNSUPPORTED_FILE_TYPE', /File type \.json/));
    await assert.rejects(create('no-extension'), refusal('UNSUPPORTED_FILE_TYPE', /no extension/));
    await assert.rejects(create('huge.mjs', { content: 'x'.repeat(100_001) }), refusal('CONTENT_TOO_LARGE', /100001 UTF-8 bytes.*100000 bytes/));
    await assert.rejects(create('huge.html', { content: '测'.repeat(33_334) }), refusal('CONTENT_TOO_LARGE', /100002 UTF-8 bytes.*100000 bytes/));
    for (const path of ['unsupported.json', 'no-extension', 'huge.mjs', 'huge.html']) await assert.rejects(lstat(join(workspace, path)), { code: 'ENOENT' });
  }));
  await test('invalid content has its own registration error', () => run(async () => {
    await assert.rejects(validateTemporaryCheckCreation(workspace, 'invalid-content.html', { created: true, content: 42 }), refusal('INVALID_CONTENT', /UTF-8 text string/));
  }));
  await test('UTF-8 byte limit is consistent at creation and tracked HTML updates', () => run(async () => {
    const path = 'byte-boundary.html', content = '测'.repeat(33_333) + '\n';
    assert.equal(Buffer.byteLength(content), 100_000);
    await create(path, { content });
    const updated = await call('write_file', { path, content: content.replace('测', '验') });
    assert.equal(updated.modelResult.temporarySelfCheck, true);
    assert.equal((await cleanup(path)).modelResult.deleted, true);
  }));
  await test('ordinary updates over the temporary limit revoke cleanup instead of deleting the file', () => run(async () => {
    const path = 'grown-page.html', content = '测'.repeat(33_334);
    await create(path, { content: '<p>small</p>' });
    const updated = await call('write_file', { path, content });
    assert.equal(updated.modelResult.temporarySelfCheck, false);
    assert.equal(updated.modelResult.cleanupTool, null);
    await assert.rejects(cleanup(path), refusal('NOT_REGISTERED', /not registered/));
    assert.equal(await readFile(join(workspace, path), 'utf8'), content);
  }));
  await test('read-only and explicit deny remain authoritative', async () => {
    await run(async () => {
      for (const path of ['denied.mjs', 'denied-page.html']) {
        await create(path);
        await assert.rejects(call('cleanup_temporary_check', { path }, { permissionPolicy: createPermissionPolicy('read-only') }), /Permission denied/);
        await assert.rejects(call('cleanup_temporary_check', { path }, { permissionPolicy: createPermissionPolicy('workspace-write', { cleanup_temporary_check: 'deny' }) }), /Permission denied/);
        assert.ok((await lstat(join(workspace, path))).isFile());
      }
    });
  });
  await test('explicit ask still prompts and user rejection prevents deletion', () => run(async () => {
    for (const path of ['ask.mjs', 'ask-page.html']) {
      await create(path); let asked = false;
      await assert.rejects(call('cleanup_temporary_check', { path }, {
        permissionPolicy: createPermissionPolicy('workspace-write', { cleanup_temporary_check: 'ask' }),
        requestApproval: async () => { asked = true; return { approved: false }; },
      }), /rejected/); assert.equal(asked, true); assert.ok((await lstat(join(workspace, path))).isFile());
    }
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
