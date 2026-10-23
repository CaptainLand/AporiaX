import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ToolProgressGuard } from '../electron/runtime/tool-progress-guard.js';
import { runSubagentTask } from '../electron/runtime/subagent-loop.js';
import { normalizeSubagentInput } from '../electron/runtime/subagent-model.js';
import { createPermissionPolicy, getToolPermission } from '../electron/agent-core.js';
import { TOOL_REGISTRY } from '../electron/runtime/native-tool-catalog.js';
import { createNativeToolExecutor } from '../electron/runtime/native-tool-executor.js';
import { verifyExistingTarget, verifyWritableTarget, searchWorkspaceText, calculateLineChanges, runGitCommand } from '../electron/runtime/workspace-runtime.js';
import { runHostFallbackCommand, localSandboxSnapshotLimits } from '../electron/sandbox-runtime.js';
import { installWorkbenchProvider } from '../electron/workbench/runtime-provider.js';
import { withDurableRun } from '../electron/runtime/durable-run.js';
import { completeLoopRequest } from '../electron/runtime/loop-recovery.js';
import { currentLoopRequestIdentity, prepareCloudRequest, rememberCloudResult } from '../electron/runtime/cloud-request-identity.js';
import { createBuilderWorkspaceManager } from '../electron/harness/builder-workspace.js';
import { runIsolatedBuilder } from '../electron/runtime/delegated-builder.js';
import { configureWorkspaceRecoveryDirectory } from '../electron/runtime/workspace-mutations.js';
import { inspectCheckpointFile } from '../electron/runtime/checkpoint-files.js';
import { revertWorkspaceChanges } from '../electron/agent-runtime-core.js';
import { sharedScopeLeases } from '../electron/harness/shared-scope-leases.js';
import { memberCanWrite, memberPermissionPolicy } from '../electron/team-chat/member-policy.js';
import { defaultRole } from '../shared/professional-roles.js';
import { captureDelegationContext, syncDelegationContext, readDelegationContext, noteDelegationRead, assertDelegationConstraintsRead } from '../electron/runtime/subagent-contract.js';
import { buildChanges } from '../electron/runtime/self-check-evidence.js';
import { encodeContext } from '../electron/context-chunks.js';
import { beginRunJournal, saveRunContext, getRunRecoveryContext, closeRunJournalStore } from '../electron/run-store.js';
import { createWitnessMonitor } from '../electron/witness-monitor.js';

const root = await mkdtemp(join(tmpdir(), 'aporia-autonomy-review-'));
let count = 0;
const test = async (name, fn) => { await fn(); count++; console.log('PASS', name); };
const project = async name => { const path = join(root, name); await mkdir(path); return path; };
const git = path => assert.equal(spawnSync('git', ['init'], { cwd: path, windowsHide: true }).status, 0);
const executor = createNativeToolExecutor({ verifyExistingTarget, verifyWritableTarget, searchWorkspaceText, calculateLineChanges, runGitCommand });
const call = (name, args) => ({ id: 'call-' + name, function: { name, arguments: JSON.stringify(args) } });
function worker(workspaceRoot, complete, extra = {}) {
  return runSubagentTask({ agentId: 'audit-' + count, taskId: 'audit-parent',
    input: normalizeSubagentInput({ role: 'review', task: 'Perform the assigned check.' }),
    workspaceRoot, parentPermissionPolicy: createPermissionPolicy('workspace-write'), approvalMode: 'manual',
    requestApproval: async () => ({ approved: true }), toolRegistry: TOOL_REGISTRY,
    parseToolArguments: c => JSON.parse(c.function.arguments), executeAuthorizedTool: executor,
    sandboxExecutor: runHostFallbackCommand, sandboxStatus: { available: false },
    signal: new AbortController().signal, modelId: 'fixture', modelConfig: { contextWindow: 1000000 }, session: {}, emit() {},
    provider: { id: 'fixture', supportsTools: true, complete }, ...extra });
}
configureWorkspaceRecoveryDirectory(() => join(root, 'recovery'));
try {
  await test('cleanup failures preserve a completed report and do not emit a failed result', async () => {
    const path = await project('cleanup'), events = [];
    installWorkbenchProvider({ acquire: () => ({ browserRuntime: {}, processManager: {}, release: async () => { throw Error('fixture cleanup failure'); } }) });
    try {
      const result = await worker(path, async () => ({ message: { content: 'Verified delivery.' } }), { emit: e => events.push(e) });
      assert.equal(result.status, 'completed'); assert.equal(result.summary, 'Verified delivery.');
      assert.match(result.cleanupWarnings.join(), /fixture cleanup failure/);
      assert(!events.some(e => e.type === 'subagent.failed'));
      assert(events.some(e => e.type === 'subagent.resource.warning'));
      const witness = createWitnessMonitor();
      try {
        for (const event of events) witness.observe(event);
        const warning = witness.snapshot().records.find(record => record.eventType === 'subagent.resource.warning');
        assert(warning); assert.equal(warning.status, 'completed');
      } finally { witness.dispose(); }
    } finally { installWorkbenchProvider(null); }
  });
  await test('command-only worker changes stay private until conflict-checked integration, including plain folders', async () => {
    const path = await project('command'), events = []; await writeFile(join(path, 'file.txt'), 'original'); let round = 0;
    const result = await worker(path, async ({ body }) => {
      if (++round === 1) {
        assert(!body.tools.some(t => t.function.name === 'write_file'));
        return { message: { tool_calls: [call('run_command', { command: 'echo changed > file.txt' })] } };
      }
      assert.equal(await readFile(join(path, 'file.txt'), 'utf8'), 'original', 'shared files remain unchanged while the worker is active');
      return { message: { content: 'Command completed.' } };
    }, { emit: e => events.push(e) });
    assert.equal(result.status, 'completed', result.summary); assert(result.integrated); assert(result.requiresIntegration);
    assert(result.changes.some(c => c.path === 'file.txt'));
    assert.equal((await readFile(join(path, 'file.txt'), 'utf8')).trim(), 'changed');
    assert(events.some(e => e.type === 'builder.merge.completed'));
  });
  await test('a command worker cannot overwrite an active Builder lease or a newer parent edit', async () => {
    for (const conflict of ['lease', 'newer']) {
      const path = await project('conflict-' + conflict); await writeFile(join(path, 'file.txt'), 'original');
      let lease, round = 0;
      if (conflict === 'lease') lease = sharedScopeLeases.acquire('other-builder', ['file.txt'], { workspaceRoot: await realpath(path) });
      try {
        const result = await worker(path, async () => {
          if (++round === 1) return { message: { tool_calls: [call('run_command', { command: 'echo worker > file.txt' })] } };
          if (conflict === 'newer') await writeFile(join(path, 'file.txt'), 'human edit');
          return { message: { content: 'Check finished.' } };
        });
        assert.equal(result.status, 'blocked'); assert.equal(result.integrated, false);
        assert.equal(await readFile(join(path, 'file.txt'), 'utf8'), conflict === 'lease' ? 'original' : 'human edit');
      } finally { lease?.release(); }
    }
  });
  await test('restart reuses the paid receipt and restores all text continuation parts, not only its suffix', async () => {
    const checkpoints = {}, contexts = {}; let history, network = 0;
    const durable = () => ({ requestCheckpoints: structuredClone(checkpoints), recoveryContexts: structuredClone(contexts),
      checkpoint: async c => { checkpoints[c.scopeId] = structuredClone(c); }, context: async (k, v) => { contexts[k] = JSON.parse(v); } });
    const provider = { id: 'fixture-cloud', baseUrl: 'http://fixture.invalid' };
    const complete = async body => {
      const state = currentLoopRequestIdentity(), ready = await prepareCloudRequest(state, provider, body, {});
      if (ready.result) return ready.result;
      if (++network <= 2) throw Object.assign(Error('length'), { code: 'PROVIDER_FINISH_LENGTH', streamComplete: true, safeToRepair: true,
        partialMessage: { content: 'segment-' + network }, outputTokenLimit: 32, maxOutputTokens: 128 });
      const result = { message: { content: 'last' } }; await rememberCloudResult(state, result); return result;
    };
    const options = conversation => ({ conversation, contextCheckpoints: [], accounting: {}, contextWindowTokens: 1000000,
      getBody: messages => ({ model: 'fixture', messages, max_tokens: 32 }), complete, persist: async () => {
        // Simulate input compaction while preserving the separately saved output.
        if (network >= 2) for (let i = conversation.length - 1; i >= 0; i--) if (conversation[i].aporiaOutputContinuation) conversation.splice(i, 1);
        history = structuredClone(conversation);
      } });
    const first = await withDurableRun(durable(), () => completeLoopRequest(options([{ role: 'user', content: 'Long report.' }])));
    const recovered = await withDurableRun(durable(), () => completeLoopRequest(options(structuredClone(history))));
    assert.equal(recovered.message.content, first.message.content); assert.equal(network, 3);
    assert.equal(recovered.message.content, 'segment-1\nsegment-2\nlast');
  });
  await test('alternating repeated actions are locally suppressed; fresh evidence and occasional probes remain possible', () => {
    let now = 0, blocked = 0; const guard = new ToolProgressGuard({ now: () => now });
    for (let i = 0; i < 30; i++) {
      const input = { path: i % 2 ? 'b' : 'a' };
      try { guard.before('read_file', input); guard.observe({ tool: 'read_file', input, result: { content: 'unchanged' } }); }
      catch (e) { assert.equal(e.code, 'TOOL_REPEAT_SUPPRESSED'); blocked++; }
    }
    assert(blocked > 0); guard.before('web_search', { query: 'independent work' }); guard.assertBudget();
    const restored = new ToolProgressGuard({ snapshot: guard.snapshot(), now: () => now });
    assert.throws(() => restored.before('read_file', { path: 'a' }), /SUPPRESSED/);
    now = 30001; restored.before('read_file', { path: 'a' });
    restored.observe({ tool: 'read_file', input: { path: 'a' }, result: { content: 'new contents' } });
    restored.before('read_file', { path: 'a' });
  });
  await test('independent members use selected capabilities, while explicit exclusions and parent read-only still win', () => {
    for (const role of [defaultRole('verify'), { ...defaultRole('review'), tools: ['create_word_document'] }, { ...defaultRole('review'), tools: ['run_command'] }]) {
      assert(memberCanWrite(role));
      const policy = memberPermissionPolicy(createPermissionPolicy('workspace-write'), role);
      const selected = role.tools?.[0] || 'run_command'; assert.notEqual(getToolPermission(policy, selected), 'deny');
      if (role.tools) assert.equal(getToolPermission(policy, 'delete_file'), 'deny');
      assert.equal(getToolPermission(memberPermissionPolicy(createPermissionPolicy('read-only'), role), selected), 'deny');
    }
    assert.equal(memberCanWrite({ ...defaultRole('review'), tools: ['read_file'] }), false);
  });
  await test('binary/Office-shaped artifacts survive interruption, merge byte-for-byte, and roll back', async () => {
    const path = await project('binary'); git(path);
    const original = Buffer.from([80, 75, 3, 4, 0, 1]), changed = Buffer.from([80, 75, 3, 4, 0, 2]);
    await writeFile(join(path, 'report.docx'), original); const session = {}; let changes;
    const options = { agentId: 'binary', input: { role: 'builder', writeScopes: ['report.docx'] }, workspaceRoot: path, session, emit() {}, onBuilderMerge: r => { changes = r.checkpoints; } };
    await runIsolatedBuilder(options, async o => { await writeFile(join(o.workspaceRoot, 'report.docx'), changed); return { status: 'interrupted' }; });
    const result = await runIsolatedBuilder(options, async o => { assert.deepEqual(await readFile(join(o.workspaceRoot, 'report.docx')), changed); return { status: 'completed' }; });
    assert(result.integrated); assert(changes[0].binary); assert.deepEqual(await readFile(join(path, 'report.docx')), changed);
    const reverted = await revertWorkspaceChanges({ workspacePath: path, changes }); assert(reverted[0].success);
    assert.deepEqual(await readFile(join(path, 'report.docx')), original);
  });
  await test('an actual Word creation tool completes through the Worker, package inspection and integration', async () => {
    const path = await project('real-office'); git(path); let round = 0;
    const result = await worker(path, async () => {
      round++;
      if (round === 1) return { message: { tool_calls: [call('create_word_document', { path: 'report.docx', title: 'Local regression', blocks: [{ type: 'paragraph', text: 'AporiaX binary delivery regression.' }] })] } };
      if (round === 2) return { message: { tool_calls: [call('inspect_office_file', { path: 'report.docx' })] } };
      return { message: { content: 'The Word package was created and structurally inspected; no visual rendering claimed.' } };
    }, { input: normalizeSubagentInput({ role: 'builder', task: 'Create the requested Word document.', write_scopes: ['report.docx'] }) });
    assert.equal(result.status, 'completed', result.summary); assert(result.integrated);
    assert(result.evidence.some(item => item.tool === 'inspect_office_file' && !item.error));
    assert.equal((await readFile(join(path, 'report.docx'))).subarray(0, 2).toString(), 'PK');
  });
  await test('large file versions stay disk-backed, survive worktree removal, remain reviewable and restore safely', async () => {
    const path = await project('large'); git(path); const original = 'old'.repeat(100000), changed = 'new'.repeat(100000);
    await writeFile(join(path, 'large.txt'), original); let changes;
    const result = await runIsolatedBuilder({ agentId: 'large', input: { writeScopes: ['large.txt'] }, workspaceRoot: path, session: {}, emit() {},
      onBuilderMerge: r => { changes = r.checkpoints; } }, async o => { await writeFile(join(o.workspaceRoot, 'large.txt'), changed); return { status: 'completed' }; });
    assert(result.integrated); assert(changes[0].fileVersions.before); assert(changes[0].fileVersions.after);
    const storage = join(root, 'file-version-store');
    await beginRunJournal(storage, { runId: 'file-versions', taskId: 'file-version-task' });
    await saveRunContext(storage, 'file-versions', 'worker', { changes }); await closeRunJournalStore(storage);
    changes = (await getRunRecoveryContext(storage, 'file-versions')).contexts.worker.changes; await closeRunJournalStore(storage);
    assert(JSON.stringify(changes).length < 4000, 'durable state holds references, not file payloads');
    assert.equal(buildChanges(new Map([['large.txt', changes[0]]])).length, 1);
    const ref = changes[0].fileVersions.after; assert.equal((await inspectCheckpointFile(path, 'large.txt', ref)).bytes, changed.length);
    const encoded = encodeContext({ prepare: () => ({ get: () => ({}), run() {} }) }, { session: { provisionalChanges: changes } });
    assert(encoded.length < 5000);
    assert((await revertWorkspaceChanges({ workspacePath: path, changes }))[0].success);
    assert.equal(await readFile(join(path, 'large.txt'), 'utf8'), original);
    await assert.rejects(inspectCheckpointFile(path, 'other.txt', ref), /ENOENT/);
    const blob = await inspectCheckpointFile(path, 'large.txt', ref);
    await writeFile(blob.filePath, 'x'.repeat(ref.bytes));
    await assert.rejects(inspectCheckpointFile(path, 'large.txt', ref), /checksum/);
  });
  await test('newer files are never overwritten by a disk-backed rollback', async () => {
    const path = await project('large-conflict'); git(path); await writeFile(join(path, 'file.txt'), 'a'.repeat(150000)); let changes;
    await runIsolatedBuilder({ agentId: 'large-conflict', input: { writeScopes: ['file.txt'] }, workspaceRoot: path, session: {}, emit() {}, onBuilderMerge: r => { changes = r.checkpoints; } },
      async o => { await writeFile(join(o.workspaceRoot, 'file.txt'), 'b'.repeat(150000)); return { status: 'completed' }; });
    await writeFile(join(path, 'file.txt'), 'new human edit');
    assert.equal((await revertWorkspaceChanges({ workspacePath: path, changes }))[0].success, false);
    assert.equal(await readFile(join(path, 'file.txt'), 'utf8'), 'new human edit');
  });
  await test('snapshot limits agree across Builder and Safe; large metadata manifests survive a real SQLite restart', async () => {
    assert(localSandboxSnapshotLimits().maxFiles >= 100000); assert(localSandboxSnapshotLimits().maxBytes >= 2000000000);
    const storage = join(root, 'metadata-store');
    await beginRunJournal(storage, { runId: 'metadata', taskId: 'metadata-task' });
    const state = { entries: Array.from({ length: 19000 }, (_, id) => ({ id, note: 'x'.repeat(900) })) };
    assert(JSON.stringify(state).length > 16000000);
    await saveRunContext(storage, 'metadata', 'worker', state); await closeRunJournalStore(storage);
    const loaded = (await getRunRecoveryContext(storage, 'metadata')).contexts.worker;
    assert.equal(loaded.entries.length, 19000); assert.deepEqual(loaded.entries.at(-1), state.entries.at(-1));
    await closeRunJournalStore(storage);
  });
  await test('large-model context uses token estimates; explicit restrictions remain pinned when original background is paged', () => {
    const original = '不要发布，也不要删除现有文件。\n' + '中'.repeat(400000);
    const context = captureDelegationContext([{ role: 'user', content: original }]); const conversation = [{ role: 'system', content: 'worker' }];
    syncDelegationContext(conversation, context, { contextWindowTokens: 1000000 });
    assert.match(conversation[1].content, /paged/); assert(conversation[1].content.includes('不要发布，也不要删除现有文件。'));
    const ascii = captureDelegationContext([{ role: 'user', content: 'Never delete existing files.\n' + 'a'.repeat(400000) }]);
    const large = [{ role: 'system', content: 'worker' }]; syncDelegationContext(large, ascii, { contextWindowTokens: 1000000 });
    assert(!large[1].content.includes('"paged":true'), '400K ASCII characters fit the 1M token budget');
    const latest = '先在本地看看，等我确认以后再动手。';
    const twoTurns = captureDelegationContext([{ role: 'user', content: original }, { role: 'user', content: latest }]);
    syncDelegationContext(conversation, twoTurns, { contextWindowTokens: 1000000 }); assert(conversation[1].content.includes(latest));
  });
  await test('oversized explicit constraints are read in contiguous pages before mutations, without closing other tools', () => {
    const context = captureDelegationContext([{ role: 'user', content: '必须保留：' + '中'.repeat(100000) }]);
    const conversation = [{ role: 'system', content: 'worker' }], session = { delegationContext: context };
    syncDelegationContext(conversation, context, { contextWindowTokens: 32000 });
    assert.throws(() => assertDelegationConstraintsRead(conversation, session), /REQUIREMENTS_UNREAD/);
    let offset = 0; do {
      const result = readDelegationContext(context, { request_id: context.requests[0].id, offset, max_chars: 12000 });
      noteDelegationRead(session, result); offset = result.nextOffset;
    } while (offset !== null);
    assertDelegationConstraintsRead(conversation, session);
  });
} finally {
  installWorkbenchProvider(null);
  configureWorkspaceRecoveryDirectory(() => join(tmpdir(), 'aporiax-workspace-recovery'));
  const parent = await realpath(tmpdir()), target = await realpath(root), rel = relative(parent, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Unexpected temporary test path');
  await rm(target, { recursive: true, force: true });
}
console.log(`Autonomy review fixes: ${count}/${count} PASS; no paid inference or production data.`);
