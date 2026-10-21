import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createNativeToolExecutor } from '../electron/runtime/native-tool-executor.js';
import { parseWorkspacePatch, applyWorkspacePatch } from '../electron/runtime/workspace-patch.js';
import { assertNativeFileTool } from '../electron/runtime/file-access-policy.js';
import { dispatchNativeTool } from '../electron/runtime/tool-dispatcher.js';
import { createPermissionPolicy } from '../electron/agent-core.js';
import { assertSubagentScope } from '../electron/runtime/subagent-model.js';
import { createLocalControlPolicy, withLocalControlPolicy } from '../electron/control/policy.js';
import { TOOL_REGISTRY } from '../electron/runtime/native-tool-catalog.js';
import { withDurableRun } from '../electron/runtime/durable-run.js';
import { createModelStreamProgress } from '../electron/runtime/model-stream-progress.js';
import { projectSimpleRequestHistory } from '../electron/runtime/simple-request-context.js';
import { createWitnessMonitor } from '../electron/witness-monitor.js';
import { activityActor, describeRouteRecord } from '../src/conversation/route-activity-model.js';
import { callModelProvider } from '../electron/runtime/provider-stream.js';
import { runHarness } from '../electron/agent-runtime.js';
import { revertWorkspaceChanges, restoreWorkspaceAnchor } from '../electron/agent-runtime-core.js';
import { inspectWorkspaceSnapshot, mutateWorkspaceFiles, restoreWorkspaceSnapshot } from '../electron/runtime/workspace-mutations.js';
import { calculateLineChanges, verifyExistingTarget, verifyWritableTarget, searchWorkspaceText, runGitCommand } from '../electron/runtime/workspace-runtime.js';
import { suite, provider, tools, call, sse, eventsResponse, responsesEvents, anthropicEvents } from './goal-loop-fixtures.mjs';

const { test, finish } = suite('task-operation-efficiency');
const root = await mkdtemp(join(tmpdir(), 'aporia-operations-'));
const recoveryDirectory = join(root, 'recovery');
const workspace = join(root, 'workspace'); await mkdir(workspace);
const executor = createNativeToolExecutor({ calculateLineChanges, verifyExistingTarget, verifyWritableTarget, searchWorkspaceText, runGitCommand });
const sha = text => createHash('sha256').update(text).digest('hex');
const execute = (name, input) => withDurableRun({ recoveryDirectory }, () => executor({ toolCall: { function: { name } }, toolName: name, input, workspaceRoot: workspace }));
const dispatch = (name, input, options = {}) => dispatchNativeTool({ toolCall: call('dispatch', name, input), registry: TOOL_REGISTRY,
  permissionPolicy: createPermissionPolicy('workspace-write'), parseArguments: item => JSON.parse(item.function.arguments),
  executeContext: { workspaceRoot: workspace }, requestApproval: async () => ({ approved: true }),
  executeAuthorized: ({ input: approved }) => execute(name, approved), ...options });
const originalFetch = globalThis.fetch;
try {
  await test('path-only deletion is short, exact and recoverable without returning the full source', async () => {
    const source = 'test page\n'.repeat(4000); await writeFile(join(workspace, 'large.html'), source);
    const input = { path: 'large.html', expected_sha256: sha(source) };
    assert(JSON.stringify(input).length < 140);
    const result = await dispatch('delete_file', input);
    assert.equal(result.modelResult.deleted, true); assert.equal(result.modelResult.recoverable, true);
    assert(JSON.stringify(result.modelResult).length < 300); assert.equal(result.change.beforeContent, source);
    await assert.rejects(access(join(workspace, 'large.html')), { code: 'ENOENT' });
    const backups = await readdir(recoveryDirectory);
    const manifestDir = join(recoveryDirectory, backups[0]);
    const manifest = JSON.parse(await readFile(join(manifestDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.status, 'committed'); assert.equal(manifest.entries[0].afterMissing, true);
    assert.equal(await readFile(join(manifestDir, manifest.entries[0].backup), 'utf8'), source);
  });
  await test('preview, hash precondition, directories, globs and external paths fail safely; binary files work', async () => {
    await writeFile(join(workspace, 'keep.txt'), 'KEEP');
    assert.equal((await execute('delete_file', { path: 'keep.txt', dry_run: true })).modelResult.deleted, false);
    await assert.rejects(execute('delete_file', { path: 'keep.txt', expected_sha256: sha('STALE') }), /DELETE_PRECONDITION_FAILED/);
    await assert.rejects(dispatch('delete_file', { path: '.' }), /FILE_ACCESS_DENIED/);
    await assert.rejects(dispatch('delete_file', { path: '../outside.txt' }), /FILE_ACCESS_DENIED/);
    await assert.rejects(execute('delete_file', { path: '*.html' }), /DELETE_TARGET_INVALID/);
    await writeFile(join(workspace, 'binary.bin'), Buffer.from([255, 0, 128]));
    const binary = await execute('delete_file', { path: 'binary.bin' });
    assert(binary.change.fileSnapshot); assert.equal(binary.modelResult.bytes, 3);
    assert.equal((await revertWorkspaceChanges({ workspacePath: workspace, changes: [binary.change] }))[0].success, true);
    assert.deepEqual(await readFile(join(workspace, 'binary.bin')), Buffer.from([255, 0, 128]));
    assert.equal(await readFile(join(workspace, 'keep.txt'), 'utf8'), 'KEEP');
  });
  await test('large text and binary deletions keep tiny records and stream byte-exact snapshots through undo and anchors', async () => {
    for (const [name, content] of [['large-data.zip', Buffer.alloc(3_100_000, 0xff)], ['large-source.txt', Buffer.from('中文 source\n'.repeat(150000))]]) {
      await writeFile(join(workspace, name), content);
      const result = await dispatch('delete_file', { path: name });
      assert.equal(result.modelResult.bytes, content.length); assert.equal(result.modelResult.recoverable, true);
      assert(JSON.stringify(result).length < 1500, 'Full file bytes must not enter renderer/model history');
      assert.equal(result.change.beforeContent, ''); assert(result.change.fileSnapshot);
      const snapshot = await inspectWorkspaceSnapshot(workspace, name, result.change.fileSnapshot);
      assert.equal(snapshot.sha256, sha(content));
      assert.equal((await restoreWorkspaceAnchor({ workspacePath: workspace, checkpoints: [{ id: name, changes: [result.change] }] })).success, true);
      assert.deepEqual(await readFile(join(workspace, name)), content);
      const again = await dispatch('delete_file', { path: name });
      await writeFile(join(workspace, name), 'NEW HUMAN FILE');
      assert.equal((await revertWorkspaceChanges({ workspacePath: workspace, changes: [again.change] }))[0].reason, 'file-changed-after-checkpoint');
      assert.equal(await readFile(join(workspace, name), 'utf8'), 'NEW HUMAN FILE');
    }
  });
  await test('file snapshots reject forged locations, wrong workspace/path bindings and corrupt recovery bytes', async () => {
    await writeFile(join(workspace, 'snapshot.bin'), Buffer.from([0, 255, 1]));
    const { change } = await dispatch('delete_file', { path: 'snapshot.bin' });
    await assert.rejects(inspectWorkspaceSnapshot(workspace, 'snapshot.bin', { ...change.fileSnapshot, manifestPath: join(root, 'untrusted.json') }), /trusted recovery/);
    await assert.rejects(inspectWorkspaceSnapshot(workspace, 'wrong.bin', change.fileSnapshot), /does not match/);
    const source = await inspectWorkspaceSnapshot(workspace, 'snapshot.bin', change.fileSnapshot);
    const restarted = await import('../electron/runtime/workspace-mutations.js?fresh-snapshot-reader');
    restarted.configureWorkspaceRecoveryDirectory(() => recoveryDirectory);
    assert.equal((await restarted.inspectWorkspaceSnapshot(workspace, 'snapshot.bin', JSON.parse(JSON.stringify(change.fileSnapshot)))).sha256, source.sha256, 'Persisted snapshots remain readable after a fresh runtime is configured');
    await writeFile(source.filePath, Buffer.from([0, 254, 1]));
    const reverted = await revertWorkspaceChanges({ workspacePath: workspace, changes: [change] });
    assert.equal(reverted[0].success, false); assert.match(reverted[0].reason, /checksum/);
    await assert.rejects(access(join(workspace, 'snapshot.bin')), { code: 'ENOENT' });
  });
  await test('file-backed rollback restores deleted bytes and restore refuses newer files appearing after preflight', async () => {
    const body = Buffer.alloc(2_000_001, 0xfe); await writeFile(join(workspace, 'rollback.bin'), body);
    await writeFile(join(workspace, 'rollback-other.txt'), 'OLD');
    await assert.rejects(withDurableRun({ recoveryDirectory }, () => mutateWorkspaceFiles({ workspaceRoot: workspace,
      edits: [{ path: 'rollback.bin', before: { filePath: join(workspace, 'rollback.bin'), sha256: sha(body) }, after: null }, { path: 'rollback-other.txt', before: Buffer.from('OLD'), after: Buffer.from('NEXT') }],
      onPrepared: async () => writeFile(join(workspace, 'rollback-other.txt'), 'HUMAN CHANGE'),
    })), /BUILDER_MERGE_FAILED/);
    assert.deepEqual(await readFile(join(workspace, 'rollback.bin')), body);
    assert.equal(await readFile(join(workspace, 'rollback-other.txt'), 'utf8'), 'HUMAN CHANGE');
    const { change } = await dispatch('delete_file', { path: 'rollback.bin' });
    await writeFile(join(workspace, 'rollback.bin'), 'NEW HUMAN FILE');
    await assert.rejects(restoreWorkspaceSnapshot(workspace, 'rollback.bin', change.fileSnapshot), /DELETE_RESTORE_CONFLICT/);
    assert.equal(await readFile(join(workspace, 'rollback.bin'), 'utf8'), 'NEW HUMAN FILE');
  });
  await test('read-only, denied approval and changed approval-time content cannot be deleted', async () => {
    await assert.rejects(dispatch('delete_file', { path: 'keep.txt' }, { permissionPolicy: createPermissionPolicy('read-only') }), /Permission denied/);
    await assert.rejects(dispatch('delete_file', { path: 'keep.txt' }, { requestApproval: async () => ({ approved: false }) }), /rejected/);
    await assert.rejects(dispatch('delete_file', { path: 'keep.txt', expected_sha256: sha('KEEP') }, {
      requestApproval: async () => { await writeFile(join(workspace, 'keep.txt'), 'NEW USER EDIT'); return { approved: true }; },
    }), /DELETE_PRECONDITION_FAILED/);
    assert.equal(await readFile(join(workspace, 'keep.txt'), 'utf8'), 'NEW USER EDIT');
    await assert.rejects(dispatch('delete_file', { path: 'keep.txt' }, {
      requestApproval: async () => { await writeFile(join(workspace, 'keep.txt'), 'EVEN NEWER'); return { approved: true }; },
    }), /DELETE_PRECONDITION_FAILED/, 'Path-only calls also pin the locally approved content version');
    assert.equal(await readFile(join(workspace, 'keep.txt'), 'utf8'), 'EVEN NEWER');
  });
  await test('the original 104-character compact deletion works through authorization and execution', async () => {
    await writeFile(join(workspace, 'one.html'), 'one\n'); await writeFile(join(workspace, 'two.html'), 'two\n');
    const patch = '*** Begin Patch\n*** Delete File: one.html\n*** Delete File: two.html\n*** End Patch';
    await assertNativeFileTool({ toolName: 'apply_patch', input: { patch }, workspaceRoot: workspace });
    const result = await dispatch('apply_patch', { patch }); assert.equal(result.changes.length, 2);
    assert(result.changes.every(change => change.deleted && change.afterMissing));
    await assert.rejects(access(join(workspace, 'one.html')), { code: 'ENOENT' });
    await assert.rejects(access(join(workspace, 'two.html')), { code: 'ENOENT' });
  });
  await test('compact add and exact update preserve CRLF; failed multi-file preflight writes nothing', async () => {
    await execute('apply_patch', { patch: '*** Begin Patch\n*** Add File: added.txt\n+first\n+last\n*** End Patch' });
    assert.equal(await readFile(join(workspace, 'added.txt'), 'utf8'), 'first\nlast\n');
    await writeFile(join(workspace, 'windows.txt'), 'first\r\nold\r\nlast\r\n');
    const patch = '*** Begin Patch\n*** Update File: windows.txt\n@@\n first\n-old\n+new\n last\n*** End Patch';
    await execute('apply_patch', { patch }); assert.equal(await readFile(join(workspace, 'windows.txt'), 'utf8'), 'first\r\nnew\r\nlast\r\n');
    await assert.rejects(execute('apply_patch', { patch: '*** Begin Patch\n*** Delete File: windows.txt\n*** Update File: added.txt\n@@\n-missing\n+changed\n*** End Patch' }), /PATCH_CONTEXT_MISMATCH/);
    assert.equal(await readFile(join(workspace, 'windows.txt'), 'utf8'), 'first\r\nnew\r\nlast\r\n');
    await assert.rejects(execute('apply_patch', { patch: '*** Begin Patch\n*** Add File: added.txt\n+overwrite\n*** End Patch' }), /PATCH_TARGET_EXISTS/);
  });
  await test('malformed format reports PATCH_FORMAT, not filesystem denial; unsafe paths and ambiguous hunks remain blocked', async () => {
    for (const patch of ['not a patch', '*** Begin Patch\n*** Delete File: added.txt', '*** Begin Patch\n*** Move to: elsewhere\n*** End Patch', '--- a/a\n+++ b/a\n']) {
      await assert.rejects(assertNativeFileTool({ toolName: 'apply_patch', input: { patch }, workspaceRoot: workspace }), /PATCH_FORMAT/);
    }
    await assert.rejects(assertNativeFileTool({ toolName: 'apply_patch', input: { patch: '*** Begin Patch\n*** Delete File: ../outside\n*** End Patch' }, workspaceRoot: workspace }), /FILE_ACCESS_DENIED/);
    const ambiguous = parseWorkspacePatch('*** Begin Patch\n*** Update File: a\n@@\n-a\n+b\n*** End Patch')[0];
    assert.throws(() => applyWorkspacePatch('a\na\n', ambiguous), /PATCH_CONTEXT_MISMATCH/);
    const eof = parseWorkspacePatch('*** Begin Patch\n*** Update File: a\n@@\n-a\n+b\n*** End of File\n*** End Patch')[0];
    assert.throws(() => applyWorkspacePatch('a\nlast\n', eof), /PATCH_CONTEXT_MISMATCH/);
    assert.throws(() => parseWorkspacePatch('*** Begin Patch\n*** Update File: a\n@@\n-a\n+b\n*** End of File\n+c\n*** End Patch'), /PATCH_FORMAT_INVALID/);
    assert.throws(() => assertSubagentScope('apply_patch', { patch: '*** Begin Patch\n*** Delete File: outside.txt\n*** End Patch' }, ['src']), /outside/);
    assert.throws(() => assertSubagentScope('delete_file', { path: 'outside.txt' }, ['src']), /outside/);
    const grant = createLocalControlPolicy({ permissionProfile: 'read_only', workspaceRoot: workspace });
    await assert.rejects(withLocalControlPolicy(grant, () => dispatch('delete_file', { path: 'added.txt' })), { code: 'LOCAL_CONTROL_FORBIDDEN' });
    await assert.rejects(withLocalControlPolicy(grant, () => dispatch('apply_patch', { patch: '*** Begin Patch\n*** Delete File: added.txt\n*** End Patch' })), { code: 'LOCAL_CONTROL_FORBIDDEN' });
    assert.equal(await readFile(join(workspace, 'added.txt'), 'utf8'), 'first\nlast\n');
  });
  await test('progress is throttled, metadata-only and distinguishes action generation from execution', () => {
    let now = 0; const tracker = createModelStreamProgress({ now: () => now });
    const events = [tracker.waiting(), tracker.native({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', name: 'delete_file' } })];
    for (let i = 0; i < 1000; i++) { now++; const event = tracker.native({ type: 'response.function_call_arguments.delta', output_index: 1, delta: 'PRIVATE_ARGUMENT' }); if (event) events.push(event); }
    assert(events.length < 10); assert.equal(events.at(-1).stage, 'tool-arguments'); assert(events.at(-1).generatedChars > 0);
    assert(!JSON.stringify(events).includes('PRIVATE_ARGUMENT')); assert.equal(events.at(-1).toolName, 'delete_file');
  });
  await test('live token counters are chunk-independent estimates and reconcile provider input/output separately', () => {
    let clock = 0;
    const tracker = createModelStreamProgress({ now: () => clock, inputTokens: 500 });
    assert.equal(tracker.waiting().inputTokensEstimated, true);
    for (const piece of ['中文', 'ab', 'cd']) { clock += 600; tracker.chat({ content: piece }); }
    const first = tracker.flush(); assert(first.outputTokens > 0); assert.equal(first.outputTokensEstimated, true);
    const whole = createModelStreamProgress(); whole.chat({ content: '中文abcd' }); assert.equal(whole.flush().outputTokens, first.outputTokens);
    const partial = tracker.reportUsage({ input_tokens: 600, cache_read_input_tokens: 100 });
    assert.equal(partial.inputTokens, 700); assert.equal(partial.inputTokensEstimated, false); assert.equal(partial.outputTokensEstimated, true);
    const final = tracker.reportUsage({ prompt_tokens: 701, completion_tokens: 19 }, { final: true });
    assert.equal(final.outputTokens, 19); assert.equal(final.inputTokens, 701); assert.equal(final.outputTokensEstimated, false);
    assert(!JSON.stringify(final).includes('中文abcd'));
  });
  await test('Responses native argument progress arrives before completion without emitting executable partial calls', async () => {
    const events = []; const item = { type: 'function_call', id: 'item', call_id: 'call', name: 'delete_file', arguments: '{"path":"x.txt"}' };
    globalThis.fetch = async () => eventsResponse([
      { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments },
      ...responsesEvents([item]),
    ]);
    const result = await callModelProvider({ provider: { ...provider, protocol: 'responses' }, body: { model: 'fixture', messages: [{ role: 'user', content: 'Inspect' }] }, onEvent: event => events.push(event) });
    assert(events.some(event => event.type === 'response.progress' && event.stage === 'tool-arguments' && event.generatedChars > 0));
    assert(!events.some(event => event.type === 'tool.started')); assert.equal(result.message.tool_calls[0].function.name, 'delete_file');
    assert(!JSON.stringify(events.filter(event => event.type === 'response.progress')).includes('x.txt'));
    const final = events.filter(event => event.type === 'response.progress').at(-1);
    assert.equal(final.inputTokens, 20); assert.equal(final.outputTokens, 8); assert.equal(final.outputTokensEstimated, false);
  });
  await test('chat-completions and Anthropic keep reasoning and action contents out of progress metadata', async () => {
    for (const protocol of ['chat-completions', 'anthropic-messages']) {
      const events = [];
      globalThis.fetch = async () => protocol === 'chat-completions'
        ? sse({ reasoning_content: 'PRIVATE_REASONING', tool_calls: [{ index: 0, ...call('progress-call', 'delete_file', { path: 'PRIVATE_FILE.txt' }) }] }, 'tool_calls')
        : eventsResponse(anthropicEvents([{ type: 'thinking', thinking: 'PRIVATE_REASONING', signature: 'fixture-signature' }, { type: 'tool_use', id: 'progress-call', name: 'delete_file', input: { path: 'PRIVATE_FILE.txt' } }], 'tool_use'));
      const result = await callModelProvider({ provider: { ...provider, protocol }, body: { model: 'fixture', messages: [{ role: 'user', content: 'Inspect' }] }, onEvent: event => events.push(event) });
      assert.equal(result.message.tool_calls[0].function.name, 'delete_file');
      const progress = events.filter(event => event.type === 'response.progress'); assert(progress.some(event => event.stage === 'tool-arguments'));
      assert(!JSON.stringify(progress).includes('PRIVATE_'));
      assert.equal(progress.at(-1).outputTokensEstimated, false);
      assert.equal(progress.at(-1).inputTokensEstimated, false);
    }
  });
  await test('simple context trims only old assistant prose; originals, all human constraints and recent turns survive', () => {
    const history = [{ role: 'user', content: 'Always retain data; 不要发布。' }, { role: 'assistant', content: 'old prose '.repeat(5000), aporiaHistoryIndex: 1 },
      { role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'fixture' } }] },
      { role: 'assistant', content: 'native'.repeat(2000), aporiaNative: { bound: true } },
      { role: 'user', content: 'Keep all SVG files.' }, { role: 'assistant', content: 'Most recent explanation'.repeat(100) },
      { role: 'user', content: '工作区有没有鹈鹕测试，如果有的话删掉' }];
    const original = JSON.stringify(history), result = projectSimpleRequestHistory(history);
    assert.equal(result.compactedMessages, 1); assert(result.charactersSaved > 30000); assert.equal(JSON.stringify(history), original);
    assert.equal(result.history[0], history[0]); assert.equal(result.history[2], history[2]); assert.equal(result.history[3], history[3]); assert.equal(result.history[4], history[4]); assert.equal(result.history.at(-1), history.at(-1));
    assert.match(result.history[1].content, /read_conversation_history/);
    assert.equal(projectSimpleRequestHistory([...history.slice(0, -1), { role: 'user', content: '按照之前的方案继续删除那些文件' }]).compactedMessages, 0);
  });
  await test('Witness shows natural AporiaX status and parameter counts without private arguments or renamed avatars', () => {
    const monitor = createWitnessMonitor({ heartbeatMs: 0 }); monitor.observe({ type: 'response.reset', round: 1 });
    monitor.observe({ type: 'response.progress', stage: 'tool-arguments', generatedChars: 5000, outputTokens: 1234, inputTokens: 9876, outputTokensEstimated: true, inputTokensEstimated: false, toolName: 'apply_patch', arguments: 'PRIVATE' });
    const record = monitor.snapshot().records.at(-1), label = describeRouteRecord(record);
    assert.match(label.title, /AporiaX 正在思考或工作中/); assert.equal(label.detail, '↓ ≈1,234 Token'); assert.match(label.progressHint, /尚未执行/); assert(!label.detail.includes('9,876'));
    assert.equal(activityActor(record), 'AporiaX'); assert.equal(activityActor({ actor: 'subagent', role: 'builder' }), '搭匠');
    assert(!JSON.stringify(monitor.snapshot()).includes('PRIVATE')); monitor.dispose();
  });
  await test('real main loop uses short delete_file arguments, preserves constraints and finishes in three mock requests', async () => {
    await writeFile(join(workspace, 'target.html'), 'target page\n'); let requests = 0, approvals = 0;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body); requests++;
      assert(JSON.stringify(body.messages).includes('Never delete SVG')); assert(!JSON.stringify(body.messages).includes('old-report '.repeat(500)));
      if (requests === 1) { assert(body.tools.some(tool => tool.function.name === 'delete_file')); return tools(call('read', 'read_file', { path: 'target.html' })); }
      if (requests === 2) return tools(call('delete', 'delete_file', { path: 'target.html', expected_sha256: sha('target page\n') }));
      assert.equal(requests, 3); return sse({ content: 'Deleted target.html. No other files were changed.' });
    };
    const result = await withDurableRun({ recoveryDirectory, operation: async () => {} }, () => runHarness({ runId: 'short-delete', workspacePath: workspace, provider, modelId: 'fixture', permission: 'workspace-write', approvalMode: 'manual', language: 'en', signal: AbortSignal.timeout(20000),
      requestApproval: async () => { approvals++; return { approved: true }; }, sandboxStatusResolver: async () => ({ available: false, localAvailable: true }),
      messages: [{ role: 'user', content: 'Never delete SVG files.' }, { role: 'assistant', content: 'old-report '.repeat(4000) }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Delete target.html from the workspace' }], loopPolicy: { maxBriefSummaries: 0 } }));
    assert.equal(requests, 3); assert.equal(approvals, 1); assert.equal(result.status, 'completed');
    assert(result.changes.some(change => change.path === 'target.html' && change.deleted));
    await assert.rejects(access(join(workspace, 'target.html')), { code: 'ENOENT' });
  });
  await test('same-run write/delete and delete/recreate preserve the original checkpoint without encoding corruption', async () => {
    for (const order of ['write-delete', 'delete-write']) {
      const name = `${order}.txt`, original = order === 'delete-write' ? 'original\n'.repeat(25000) : 'ORIGINAL';
      await writeFile(join(workspace, name), original); let requests = 0;
      globalThis.fetch = async () => {
        requests++;
        if (requests > 2) return sse({ content: 'Done.' });
        const deleting = order === 'write-delete' ? requests === 2 : requests === 1;
        return deleting ? tools(call('remove', 'delete_file', { path: name })) : tools(call('write', 'write_file', { path: name, content: 'new content\n'.repeat(12000) }));
      };
      const result = await withDurableRun({ recoveryDirectory, operation: async () => {} }, () => runHarness({ runId: order, workspacePath: workspace, provider: { ...provider, models: [{ ...provider.models[0], contextWindow: 256000 }] }, modelId: 'fixture', permission: 'workspace-write', approvalMode: 'manual', language: 'en', signal: AbortSignal.timeout(20000), requestApproval: async () => ({ approved: true }), sandboxStatusResolver: async () => ({ available: false, localAvailable: true }), messages: [{ role: 'user', content: `Change ${name} as requested.` }] }));
      assert.equal(result.status, 'completed', JSON.stringify({ order, error: result.error, content: result.content?.slice(0, 600), steps: result.steps?.map(step => ({ name: step.name, success: step.success, error: step.error })) })); assert.equal(result.changes.length, 1);
      const reverted = await revertWorkspaceChanges({ workspacePath: workspace, changes: result.changes });
      assert.equal(reverted[0].success, true, JSON.stringify({ order, reason: reverted[0].reason, changes: result.changes.map(item => ({ binary: item.binary, afterMissing: item.afterMissing, source: item.source, beforeLength: item.beforeContent.length, afterLength: item.afterContent.length, hasSnapshot: Boolean(item.fileSnapshot) })) }));
      assert.equal(await readFile(join(workspace, name), 'utf8'), original);
    }
  });
} finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
finish();
