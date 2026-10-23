import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ToolProgressGuard } from '../electron/runtime/tool-progress-guard.js';
import { defaultRole, normalizeRole } from '../shared/professional-roles.js';
import { roleDefinition } from '../electron/runtime/role-capabilities.js';
import { createPermissionPolicy } from '../electron/agent-core.js';
import { normalizeSubagentInput, createSubagentPermissionPolicy, assertSubagentRealScope } from '../electron/runtime/subagent-model.js';
import { captureDelegationContext, syncDelegationContext, readDelegationContext, reviewWorkerResult } from '../electron/runtime/subagent-contract.js';
import { createRoleCoordinator } from '../electron/runtime/role-coordinator.js';
import { TOOL_REGISTRY } from '../electron/runtime/native-tool-catalog.js';
import { dispatchNativeTool } from '../electron/runtime/tool-dispatcher.js';
import { completeLoopRequest } from '../electron/runtime/loop-recovery.js';
import { createMemberControlPolicy, createLocalControlPolicy, withLocalControlPolicy, consumeLocalControlModelCall, consumeLocalControlToolCall, localControlPolicySnapshot } from '../electron/control/policy.js';
import { createBuilderWorkspaceManager, builderSnapshotLimits } from '../electron/harness/builder-workspace.js';
import { runHostFallbackCommand } from '../electron/sandbox-runtime.js';
import { runSubagentTask } from '../electron/runtime/subagent-loop.js';
import { createNativeToolExecutor } from '../electron/runtime/native-tool-executor.js';
import { rememberSuccessfulLoopRequest } from '../electron/runtime/cloud-request-identity.js';
import { verifyExistingTarget, verifyWritableTarget, searchWorkspaceText, calculateLineChanges, runGitCommand } from '../electron/runtime/workspace-runtime.js';

let cases = 0;
const test = async (name, execute) => { await execute(); cases++; console.log('PASS', name); };
const root = await mkdtemp(join(tmpdir(), 'aporia-capability-autonomy-'));
try {
  await test('brief reads never exhaust a task; repeat suppression is local, durable and reset by new evidence', () => {
    const guard = new ToolProgressGuard();
    for (let i = 0; i < 100; i++) guard.observe({ tool: 'task_brief', input: { action: 'read' }, result: { revision: i } });
    guard.assertBudget();
    for (let i = 0; i < 6; i++) guard.observe({ tool: 'read_file', input: { path: 'a' }, result: { content: 'unchanged' } });
    assert.equal(guard.blocked, false);
    assert.throws(() => guard.before('read_file', { path: 'a' }), /TOOL_REPEAT_SUPPRESSED/);
    guard.before('web_search', { query: 'new independent source' });
    const restored = new ToolProgressGuard({ snapshot: guard.snapshot() });
    assert.throws(() => restored.before('read_file', { path: 'a' }), /TOOL_REPEAT_SUPPRESSED/);
    restored.observe({ tool: 'web_search', input: { query: 'new' }, result: { sources: ['new evidence'] } });
    assert.throws(() => restored.before('read_file', { path: 'a' }), /TOOL_REPEAT_SUPPRESSED/, 'switching actions must not erase repetition history');
    restored.before('read_file', { path: 'a' }, 'changed-workspace');
    restored.observe({ tool: 'read_file', input: { path: 'a' }, result: { content: 'updated' }, version: 'changed-workspace' });
    restored.before('read_file', { path: 'a' }, 'changed-workspace');
    new ToolProgressGuard({ snapshot: { version: 1, planning: 64, recent: [] } }).assertBudget();
  });
  await test('every role composes normal capabilities, but parent denies and explicit profile choices win', () => {
    for (const name of ['builder', 'explore', 'review', 'verify', 'curator']) {
      const definition = roleDefinition(defaultRole(name));
      for (const tool of ['run_command', 'web_search', 'browser_open', 'search_skills']) assert(definition.tools.includes(tool), `${name}: ${tool}`);
      const policy = createSubagentPermissionPolicy({ '*': 'allow', browser_open: 'deny', run_command: 'ask' }, name, definition);
      assert.equal(policy.browser_open, 'deny'); assert.equal(policy.run_command, 'ask');
    }
    const customized = normalizeRole({ ...defaultRole('builder'), tools: ['read_file', 'run_command', 'browser_snapshot'] });
    const definition = roleDefinition(customized);
    assert(definition.tools.includes('run_command')); assert(!definition.tools.includes('write_file'));
    assert.throws(() => normalizeRole({ ...defaultRole('builder'), tools: ['manage_agent_role'] }), /原生能力/);
    const ro = createSubagentPermissionPolicy(createPermissionPolicy('read-only'), 'builder', roleDefinition(defaultRole('builder')));
    assert.equal(ro.run_command, 'deny'); assert.equal(ro.write_file, 'deny');
  });
  await test('long delegation no longer has 4K/6K/80K character cutoffs; archived originals are exactly pageable', () => {
    const input = normalizeSubagentInput({ role: 'review', task: 't'.repeat(20000), context: 'c'.repeat(30000) });
    assert.equal(input.task.length, 20000); assert.equal(input.context.length, 30000);
    const original = 'DO_NOT_UPLOAD_OR_DELETE\n' + '中'.repeat(100000);
    const context = captureDelegationContext([{ role: 'user', content: original }]);
    const small = [{ role: 'system', content: 'worker' }], large = [{ role: 'system', content: 'worker' }];
    syncDelegationContext(small, context, { contextWindowTokens: 32000 });
    syncDelegationContext(large, context, { contextWindowTokens: 1000000 });
    assert.match(small[1].content, /read_delegation_context/); assert(large[1].content.includes(original.replaceAll('\n', '\\n')));
    let offset = 0, restored = '';
    do { const page = readDelegationContext(context, { request_id: context.requests[0].id, revision: context.revision, offset, max_chars: 23000 }); restored += page.content; offset = page.nextOffset; } while (offset !== null);
    assert.equal(restored, original);
    assert.throws(() => readDelegationContext(context, { revision: 'stale' }), /CONTEXT_CHANGED/);
  });
  await test('independently accepted partial releases a dependency without declaring the whole upstream completed', async () => {
    const parentEvidence = new Map([['main:read', { tool: 'read_file', path: 'a' }]]);
    const upstream = { agentId: 'a', status: 'partial', role: 'review', collected: true, result: { reportId: 'a:1', evidence: [] } };
    upstream.result.acceptance = reviewWorkerResult(upstream, { report_id: 'a:1', decision: 'accepted', reason: 'Independent source establishes the required interface', evidence_ids: ['main:read'] }, parentEvidence);
    const records = new Map([['a', upstream]]), coordinator = createRoleCoordinator(records);
    const child = { input: { dependsOn: ['a'] }, session: {}, controller: new AbortController() };
    const release = await coordinator.enter(child, defaultRole('verify'));
    coordinator.assertDependencies(child); assert.equal(upstream.status, 'partial'); release();
    upstream.result.reportId = 'a:2'; assert.throws(() => coordinator.assertDependencies(child), /DEPENDENCY_CHANGED/);
  });
  await test('provisional Builder edits cannot satisfy a code edge; report-only evidence can', async () => {
    const dep = { status: 'partial', role: 'builder', result: { reportId: 'b:1', integrated: false, acceptance: { status: 'accepted', reportId: 'b:1' } } };
    const coordinator = createRoleCoordinator(new Map([['b', dep]]));
    const record = use => ({ input: { dependsOn: ['b'], dependencyRequirements: { b: use } }, session: {}, controller: new AbortController() });
    await assert.rejects(coordinator.enter(record('changes'), defaultRole('explore')), /NOT_INTEGRATED/);
    const report = record('report'), release = await coordinator.enter(report, defaultRole('explore')); coordinator.assertDependencies(report); release();
  });
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { 'validate:python': 'python check.py' } }));
  await test('custom npm script arguments use authoritative parent command approval, even without Docker', async () => {
    let approvals = 0, executed = 0;
    const options = { registry: TOOL_REGISTRY, permissionPolicy: createPermissionPolicy('workspace-write'), approvalMode: 'manual', sandboxStatus: { available: false },
      parseArguments: call => JSON.parse(call.function.arguments), executeContext: { workspaceRoot: root },
      toolCall: { id: 'verify', function: { name: 'verify_project', arguments: JSON.stringify({ kind: 'script', script: 'validate:python', args: ['--verbose', 'a b'] }) } },
      requestApproval: async request => { approvals++; assert.equal(request.toolName, 'run_command'); return { approved: true }; },
      executeAuthorized: async ({ toolName, input }) => { executed++; assert.equal(toolName, 'run_command'); assert.match(input.command, /validate:python/); assert.match(input.command, /--verbose/); return { modelResult: { exitCode: 0, stdout: 'ok', sandbox: { backend: 'host', osIsolation: false } } }; },
    };
    const result = await dispatchNativeTool(options);
    assert.equal(approvals, 1); assert.equal(executed, 1); assert(result.modelResult.verification); assert.equal(result.modelResult.sandbox.osIsolation, false);
    await assert.rejects(dispatchNativeTool({ ...options, toolCall: { ...options.toolCall, id: 'denied-check' }, requestApproval: async () => ({ approved: false }) }), /rejected/);
    assert.equal(executed, 1);
    await assert.rejects(dispatchNativeTool({ ...options, permissionPolicy: { '*': 'allow', run_command: 'deny' } }), /Permission denied/);
    assert.equal(executed, 1);
  });
  await test('command capability can be explicitly disabled, and narrow write scope never expands', async () => {
    await mkdir(join(root, 'src')); await writeFile(join(root, 'src/a.txt'), 'a'); await writeFile(join(root, 'other.txt'), 'other');
    await assert.rejects(assertSubagentRealScope('run_command', { cwd: '.' }, ['src'], root, 'none'), /not delegated/);
    await assertSubagentRealScope('run_command', { cwd: '.' }, ['src'], root, 'workspace');
    await assert.rejects(assertSubagentRealScope('write_file', { path: 'other.txt' }, ['src'], root), /outside/);
    await assertSubagentRealScope('browser_snapshot', {}, ['src'], root);
    await assert.rejects(assertSubagentRealScope('browser_upload', { paths: ['other.txt'] }, ['src'], root), /outside/);
  });
  await test('output continuation and protocol repair have independent progress-sensitive recovery', async () => {
    let requests = 0;
    const conversation = [{ role: 'user', content: 'Return the long deliverable.' }];
    const result = await completeLoopRequest({ conversation, contextCheckpoints: [], accounting: {}, contextWindowTokens: 1000000, getBody: messages => ({ messages }),
      complete: async () => {
        requests++;
        if (requests <= 4) throw Object.assign(new Error('length'), { code: 'PROVIDER_FINISH_LENGTH', streamComplete: true, safeToRepair: true, partialMessage: { content: `distinct-part-${requests}` } });
        if (requests <= 6) throw Object.assign(new Error('invalid tool JSON'), { code: 'PROVIDER_TOOL_CALL_INVALID', streamComplete: true, safeToRepair: true });
        return { message: { content: 'final-part' } };
      } });
    assert.equal(requests, 7); for (let i = 1; i <= 4; i++) assert(result.message.content.includes(`distinct-part-${i}`));
    assert(result.message.content.endsWith('final-part')); assert(!conversation.some(message => message.tool_calls?.length));
    const savedReceipt = { identity: { clientRequestId: 'same-request', repairCount: 3, repairState: { outputStalls: 0 }, repairMaxTokens: 65536 }, result: { message: { content: 'saved' } } };
    await rememberSuccessfulLoopRequest(savedReceipt);
    assert.equal(savedReceipt.identity.repairMaxTokens, 65536, 'completed receipt retains exact wire parameters across a crash');
    assert.equal(savedReceipt.identity.clientRequestId, 'same-request'); assert.equal(savedReceipt.identity.repairCount, 0);
    let repeats = 0;
    await assert.rejects(completeLoopRequest({ conversation: [{ role: 'user', content: 'test' }], contextCheckpoints: [], accounting: {}, contextWindowTokens: 1000000, getBody: messages => ({ messages }), complete: async () => {
      repeats++; throw Object.assign(new Error('unchanged incomplete call'), { code: 'PROVIDER_FINISH_LENGTH', streamComplete: true, safeToRepair: true, partialToolCalls: [{ arguments: '{' }] });
    } }), /unchanged incomplete/); assert.equal(repeats, 3);
  });
  await test('independent desktop member has no hidden request/tool/time cap; explicit and external budgets stay enforced', () => {
    const member = createMemberControlPolicy({ workspaceRoot: root, permissionProfile: 'workspace_edit', allowedProviderIds: ['fixture'], allowedModelIds: ['fixture'] });
    withLocalControlPolicy(member, () => {
      for (let i = 0; i < 150; i++) consumeLocalControlModelCall({ provider: { id: 'fixture' }, body: { model: 'fixture' } });
      for (let i = 0; i < 500; i++) consumeLocalControlToolCall();
      const snapshot = localControlPolicySnapshot(); assert.equal(snapshot.modelCalls, 150); assert.equal(snapshot.toolCalls, 500); assert.equal(snapshot.deadlineAt, Infinity);
    });
    const bounded = createMemberControlPolicy({ workspaceRoot: root, permissionProfile: 'workspace_edit', maxRequests: 1 });
    withLocalControlPolicy(bounded, () => { consumeLocalControlModelCall(); assert.throws(() => consumeLocalControlModelCall(), /limit reached/); });
    const external = createLocalControlPolicy({ workspaceRoot: root, permissionProfile: 'workspace_edit', limits: { maxToolCalls: 1 } });
    withLocalControlPolicy(external, () => { consumeLocalControlToolCall(); assert.throws(() => consumeLocalControlToolCall(), /limit reached/); });
  });
  await test('unborn Git project above 3000 files/32MB uses a disk-backed baseline and safely merges only leased changes', async () => {
    const project = join(root, 'large-unborn'); await mkdir(project);
    assert.equal(spawnSync('git', ['init'], { cwd: project, windowsHide: true }).status, 0);
    await mkdir(join(project, 'assets')); await mkdir(join(project, 'src'));
    for (let base = 0; base < 3100; base += 100) await Promise.all(Array.from({ length: 100 }, (_, n) => writeFile(join(project, 'assets', `${base + n}.txt`), 'asset')));
    await writeFile(join(project, 'assets/large.bin'), Buffer.alloc(34_000_000, 42)); await writeFile(join(project, 'src/a.txt'), 'before');
    const manager = createBuilderWorkspaceManager();
    const worker = await manager.open({ workspaceRoot: project, agentId: 'large', writeScopes: ['src/a.txt'] });
    try {
      assert.equal(worker.isolationMode, 'private-snapshot'); await writeFile(join(worker.workspaceRoot, 'src/a.txt'), 'after');
      const snapshot = await worker.snapshot(); assert.equal(snapshot.length, 1); assert.equal(snapshot[0].beforeContent, 'before');
      assert.equal((await worker.merge()).merged, true); assert.equal(await readFile(join(project, 'src/a.txt'), 'utf8'), 'after');
      assert.notEqual(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: project, windowsHide: true }).status, 0, 'user repository remains unborn');
    } finally { await worker.close(); }
    assert.equal(manager.leases().length, 0); assert(builderSnapshotLimits().maxFiles > 3000);
  });
  await test('a non-Builder role can implement an explicitly scoped assignment through the real worktree and dispatcher', async () => {
    const project = join(root, 'scoped-review'); await mkdir(project);
    assert.equal(spawnSync('git', ['init'], { cwd: project, windowsHide: true }).status, 0);
    await writeFile(join(project, 'module.txt'), 'before'); await writeFile(join(project, 'untouched.txt'), 'original');
    let requests = 0;
    const result = await runSubagentTask({ agentId: 'scoped-review', taskId: 'parent-task',
      input: normalizeSubagentInput({ role: 'review', task: 'Implement the explicitly requested correction in module.txt.', write_scopes: ['module.txt'] }),
      parentPermissionPolicy: createPermissionPolicy('workspace-write'), approvalMode: 'manual', workspaceRoot: project,
      toolRegistry: TOOL_REGISTRY, parseToolArguments: call => JSON.parse(call.function.arguments), executeAuthorizedTool: createNativeToolExecutor({ verifyExistingTarget, verifyWritableTarget, searchWorkspaceText, calculateLineChanges, runGitCommand }),
      modelId: 'fixture', modelConfig: { contextWindow: 1000000 }, signal: new AbortController().signal, session: {}, emit() {},
      provider: { supportsTools: true, complete: async () => ++requests === 1
        ? { message: { content: null, tool_calls: [{ id: 'scoped-write', function: { name: 'write_file', arguments: JSON.stringify({ path: 'module.txt', content: 'after' }) } }] } }
        : { message: { content: 'Scoped correction implemented; no runtime verification claimed.' } } },
    });
    assert.equal(result.status, 'completed', result.summary); assert.equal(result.role, 'review'); assert(result.integrated); assert(result.requiresIntegration);
    assert.equal(await readFile(join(project, 'module.txt'), 'utf8'), 'after'); assert.equal(await readFile(join(project, 'untouched.txt'), 'utf8'), 'original');
  });
  await test('foreground command survives slow warning by default; explicit deadline and cancellation still work', async () => {
    const command = process.platform === 'win32' ? 'ping -n 2 127.0.0.1 > nul' : `"${process.execPath}" -e "setTimeout(()=>console.log('finished'),250)"`;
    const result = await runHostFallbackCommand({ command, workspaceRoot: root, cwd: root, watchdogSlowMs: 20 });
    assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.timedOut, false);
    assert(result.watchdogEvents.some(event => event.stage === 'slow')); assert(!result.watchdogEvents.some(event => event.stage === 'intervention'));
    const stopped = await runHostFallbackCommand({ command, workspaceRoot: root, cwd: root, timeoutMs: 40, watchdogSlowMs: 10 });
    assert.equal(stopped.timedOut, true);
    const quoted = await runHostFallbackCommand({ command: `"${process.execPath}" -e "console.log('quoted-executable-ok')"`, workspaceRoot: root, cwd: root });
    assert.equal(quoted.exitCode, 0, quoted.stderr); assert.match(quoted.stdout, /quoted-executable-ok/);
  });
} finally { await rm(root, { recursive: true, force: true }); }
console.log(`Harness capability autonomy: ${cases}/${cases} PASS; no real inference requests.`);
