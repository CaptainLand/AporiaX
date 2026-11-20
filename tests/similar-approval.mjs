import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPermissionPolicy } from '../electron/agent-core.js';
import { createHarnessTaskRuntime } from '../electron/harness/task-runtime.js';
import { closeRunJournalStore } from '../electron/run-store.js';
import { desktopApprovalGrant } from '../electron/runtime/approval-grants.js';
import { createFullAutoApproval } from '../electron/runtime/full-auto-approval.js';
import { TOOL_REGISTRY } from '../electron/runtime/native-tool-catalog.js';
import { dispatchNativeTool } from '../electron/runtime/tool-dispatcher.js';

const root = await mkdtemp(join(tmpdir(), 'aporia-similar-approval-'));
const dataDirectory = join(root, 'journal');
const workspaceRoot = join(root, 'workspace');
const runtime = createHarnessTaskRuntime({ dataDirectory, approvalGrantKey: desktopApprovalGrant });
const approvals = [];
const automatic = [];
const executed = [];
const dispatch = (requestApproval, path, options = {}) => dispatchNativeTool({
  toolCall: { id: path, function: { name: 'delete_file', arguments: JSON.stringify({ path }) } },
  registry: TOOL_REGISTRY, permissionPolicy: createPermissionPolicy('workspace-write'),
  approvalMode: 'full-auto', requestApproval: createFullAutoApproval({ approvalMode: 'full-auto', workspaceRoot, requestApproval }),
  parseArguments: call => JSON.parse(call.function.arguments), executeContext: { workspaceRoot, ...options },
  executeAuthorized: async ({ input }) => {
    assert.match(input.expected_sha256, /^[0-9a-f]{64}$/);
    executed.push(input.path);
    return { modelResult: { deleted: true } };
  },
});
const watch = (runId, pick) => event => {
  if (event.type === 'approval.automatic') automatic.push(event);
  if (event.type !== 'approval.required') return;
  approvals.push(event.approval);
  assert.equal(event.approval.deletionGrant, undefined, 'do not expose internal directory fingerprint');
  const scope = pick(event.approval);
  assert(runtime.respondApproval(runId, event.approval.id, { approved: true, scope }));
};

try {
  for (const dir of ['sub', 'changed']) await mkdir(join(workspaceRoot, dir), { recursive: true });
  for (const path of ['first.html', 'grant.html', 'third.HTML', 'sub/nested.html', 'other.txt', 'changed/same.html'])
    await writeFile(join(workspaceRoot, path), 'fixture');
  await writeFile(join(workspaceRoot, 'binary.html'), Buffer.from([0, 255]));
  await runtime.start({ runId: 'run', taskId: 'task', onEvent: watch('run', approval => /grant\.html$/.test(approval.command) ? 'run' : 'once'),
    execute: async ({ requestApproval }) => {
      for (const path of ['first.html', 'grant.html', 'third.HTML', 'sub/nested.html', 'other.txt', 'binary.html']) await dispatch(requestApproval, path);
      assert.equal(approvals.length, 5, 'only later matching text HTML skipped the prompt');
      assert.equal(automatic.length, 1);
      assert.deepEqual(approvals[0].similarApproval, { kind: 'delete-file', directory: '.', extension: '.html' });
      assert.equal(approvals[2].similarApproval.directory, 'sub');
      assert.equal(approvals[3].similarApproval.extension, '.txt');
      assert.equal(approvals[4].canRememberForRun, false);
      await dispatch(requestApproval, 'third.HTML', { durableScope: 'other-worker' });
      assert.equal(approvals.length, 6, 'another caller receives no authorization');
      return { status: 'completed' };
    },
  });
  await runtime.start({ runId: 'next', taskId: 'task', onEvent: watch('next', () => 'once'),
    execute: async ({ requestApproval }) => { await dispatch(requestApproval, 'third.HTML'); return { status: 'completed' }; },
  });
  assert.equal(approvals.length, 7, 'different run gets no authorization');
  assert.equal(executed.length, 8);
  await assert.rejects(dispatch(async () => {
    await writeFile(join(workspaceRoot, 'third.HTML'), 'new user edit');
    return { approved: true, remembered: true };
  }, 'third.HTML'), /DELETE_PRECONDITION_FAILED/);
  await assert.rejects(dispatch(async () => {
    await rename(join(workspaceRoot, 'changed'), join(workspaceRoot, 'old'));
    await mkdir(join(workspaceRoot, 'changed'));
    await writeFile(join(workspaceRoot, 'changed/same.html'), 'fixture');
    return { approved: true, remembered: true };
  }, 'changed/same.html'), /DELETE_APPROVAL_SCOPE_CHANGED/);
  assert.equal(executed.length, 8, 'neither changed files nor replaced directories reach the executor');

  const pending = [], resolved = [];
  await runtime.start({ runId: 'parallel', taskId: 'task', onEvent: event => {
    if (event.type === 'approval.resolved') resolved.push(event.approval);
    if (event.type !== 'approval.required') return;
    pending.push(event.approval);
    if (pending.length !== 3) return;
    const controls = pending.filter(item => item.similarApproval?.kind === 'browser-control');
    const restricted = pending.find(item => !item.similarApproval);
    assert.equal(controls.length, 2);
    assert(runtime.respondApproval('parallel', controls[0].id, { approved: true, scope: 'run' }));
    assert.equal(runtime.respondApproval('parallel', controls[1].id, { approved: true }), false, 'matched pending request no longer needs a click');
    assert(runtime.respondApproval('parallel', restricted.id, { approved: true, scope: 'run' }));
  }, execute: async ({ requestApproval }) => {
    const result = await Promise.all([
      requestApproval({ toolName: 'browser_click' }),
      requestApproval({ toolName: 'browser_fill' }),
      requestApproval({ toolName: 'browser_press', kind: 'recovery-reconciliation', canRememberForRun: false }),
    ]);
    assert.deepEqual(result.map(item => item.remembered), [true, true, false]);
    return { status: 'completed' };
  } });
  assert.equal(resolved.length, 3);
  assert.equal(resolved.find(item => item.id === pending.find(item => !item.similarApproval).id).scope, 'once');
  console.log('Similar approval: one-time vs same run, file type/directory/caller/run boundaries, stale edits, pending-group resolution: PASS');
} finally {
  for (const { runId } of runtime.listActiveRuns()) runtime.interrupt(runId);
  await closeRunJournalStore(dataDirectory);
  await rm(root, { recursive: true, force: true });
}
