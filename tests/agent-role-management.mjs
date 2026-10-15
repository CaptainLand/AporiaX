import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoleSettingsStore } from '../electron/harness/role-settings.js';
import { createAgentRoleTools, proposeRoleChange } from '../electron/runtime/agent-role-tools.js';
import { defaultRole, defaultRoleSettings } from '../shared/professional-roles.js';
import { createFullAutoApproval } from '../electron/runtime/full-auto-approval.js';
import { createPermissionPolicy, getToolPermission } from '../electron/agent-core.js';
import { createSubagentPermissionPolicy } from '../electron/runtime/subagent-model.js';
import { roleDefinition } from '../electron/runtime/role-capabilities.js';
import { dispatchNativeTool } from '../electron/runtime/tool-dispatcher.js';
import { TOOL_REGISTRY } from '../electron/runtime/native-tool-catalog.js';
import { createHarnessTaskRuntime } from '../electron/harness/task-runtime.js';
import { closeRunJournalStore } from '../electron/run-store.js';
import { approvalToastCopy } from '../electron/approval-toast-state.js';

const root = await mkdtemp(join(tmpdir(), 'aporia-role-management-'));
const runtime = createHarnessTaskRuntime({ dataDirectory: root, approvalGrantKey: () => 'same-grant' });
const create = { action: 'create', role_id: 'specialist', expected_revision: 0, reason: 'User requested a reviewer', changes: { name: '界面审查', template: 'review', instructions: 'Inspect only supplied evidence.' } };
try {
  const store = await createRoleSettingsStore(root);
  let respond, asked = 0;
  const tools = createAgentRoleTools({ store, requestApproval: details => {
    asked++; assert.equal(details.kind, 'agent-role-change'); assert.equal(details.canRememberForRun, false);
    assert.equal(JSON.parse(details.description).name.after, '界面审查');
    return new Promise(resolve => { respond = resolve; });
  } });
  const pending = tools('manage_agent_role', create);
  assert.equal(store.snapshot().profiles.length, 5, 'no write before approval');
  respond({ approved: true });
  assert.equal((await pending).status, 'saved');
  assert.equal(asked, 1); assert.equal(store.snapshot().profiles.length, 6);
  assert.equal((await tools('list_agent_roles')).profiles.at(-1).instructions, undefined, 'listing keeps model context bounded');
  assert.equal((await tools('list_agent_roles', { role_id: 'specialist' })).profile.instructions, create.changes.instructions);
  assert.equal((await createRoleSettingsStore(root)).snapshot().profiles.at(-1).id, 'specialist', 'persistent');
  const update = { action: 'update', role_id: 'specialist', expected_revision: 1, changes: { name: 'Changed' }, reason: 'User requested change' };
  for (const reply of [{ approved: false }, { approved: true, automatic: true }, { approved: true, remembered: true }]) {
    const api = createAgentRoleTools({ store, requestApproval: async () => reply });
    assert.equal((await api('manage_agent_role', update)).changed, false);
    assert.equal(store.snapshot().revision, 1);
  }
  const stale = createAgentRoleTools({ store, requestApproval: async () => {
    await store.save({ ...store.snapshot(), maxActive: 2 }); return { approved: true };
  } });
  await assert.rejects(stale('manage_agent_role', update), /已被更新/);
  assert.equal(store.snapshot().profiles.at(-1).name, '界面审查');
  const abort = new AbortController();
  const interrupted = createAgentRoleTools({ store, signal: abort.signal, requestApproval: async () => { abort.abort(); return { approved: true }; } });
  await assert.rejects(interrupted('manage_agent_role', { ...update, expected_revision: 2 }), { name: 'AbortError' });
  assert.equal(store.snapshot().revision, 2);
  const confirmed = createAgentRoleTools({ store, requestApproval: async () => ({ approved: true }) });
  assert.equal((await confirmed('manage_agent_role', { ...update, expected_revision: 2 })).revision, 3);
  assert.equal((await confirmed('manage_agent_role', { action: 'delete', role_id: 'specialist', expected_revision: 3, reason: 'User requested deletion' })).revision, 4);
  assert.equal(store.snapshot().profiles.length, 5);
  for (const action of ['create', 'update', 'delete']) for (const role_id of ['explore', 'review', 'verify', 'curator', 'builder']) {
    assert.throws(() => proposeRoleChange(defaultRoleSettings(), { ...create, action, role_id }), /内置/);
  }
  for (const changes of [{ ...create.changes, permissions: '*' }, { ...create.changes, maxRequests: 10000 }, { ...create.changes, tools: ['manage_agent_role'] }, { ...create.changes, instructions: '字'.repeat(15000) }]) {
    assert.throws(() => proposeRoleChange(defaultRoleSettings(), { ...create, changes }));
  }
  const child = createSubagentPermissionPolicy({ '*': 'allow' }, 'review', roleDefinition(defaultRole('review')));
  assert.equal(getToolPermission(child, 'manage_agent_role'), 'deny');
  assert.equal(getToolPermission(createPermissionPolicy('read-only'), 'manage_agent_role'), 'deny');
  assert.equal(getToolPermission(createPermissionPolicy('builder-write', { manage_agent_role: 'allow' }), 'manage_agent_role'), 'deny');
  assert.equal(getToolPermission(createPermissionPolicy('workspace-write', { manage_agent_role: 'allow' }), 'manage_agent_role'), 'ask');
  let human = 0;
  const auto = createFullAutoApproval({ approvalMode: 'full-auto', requestApproval: async () => { human++; return { approved: false }; } });
  assert.equal((await auto({ kind: 'agent-role-change' })).approved, false); assert.equal(human, 1);
  await assert.rejects(dispatchNativeTool({ toolCall: { function: { name: 'manage_agent_role', arguments: JSON.stringify(create) } },
    registry: TOOL_REGISTRY, permissionPolicy: createPermissionPolicy('workspace-write'), approvalMode: 'full-auto', requestApproval: auto,
    parseArguments: call => JSON.parse(call.function.arguments), executeAuthorized: () => { throw new Error('Must not reach executor'); } }), /仅限/);
  let prompts = 0;
  const timer = setTimeout(() => runtime.interrupt('no-remember'), 10000);
  try {
    await runtime.start({ runId: 'no-remember', onEvent: event => {
      if (event.type !== 'approval.required') return;
      prompts++;
      if (event.approval.kind === 'agent-role-change') assert.equal(event.approval.canRememberForRun, false);
      if (event.approval.kind === 'agent-role-change') assert.equal(runtime.getPendingApprovals('no-remember')[0].approval.description, event.approval.description, 'reconnected UI receives the full diff');
      queueMicrotask(() => runtime.respondApproval('no-remember', event.approval.id, { approved: true, scope: 'run' }));
    }, execute: async ({ requestApproval }) => {
      await requestApproval({ kind: 'execute', tool: 'fixture' });
      for (let i = 0; i < 2; i++) {
        const reply = await requestApproval({ kind: 'agent-role-change', tool: 'manage_agent_role', description: '{"name":{"before":"A","after":"B"}}' });
        assert.equal(reply.remembered, false);
      }
      return { status: 'completed' };
    } });
    assert.equal(prompts, 3, 'previous run grant cannot cover role changes; each role change asks again');
  } finally { clearTimeout(timer); }
  assert.equal(approvalToastCopy({ kind: 'agent-role-change' }).approve, '查看改动');
  console.log('PASS role management: persistent CRUD, approval/rejection/abort, stale revision, built-ins, capabilities, child/read-only denial, mandatory full-auto approval and no remembered grants.');
} finally { for (const run of runtime.listActiveRuns()) runtime.interrupt(run.runId); await closeRunJournalStore(root); await rm(root, { recursive: true, force: true }); }
