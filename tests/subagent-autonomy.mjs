import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultRole, defaultRoleSettings, normalizeRoleSettings, effectiveRoleSettings } from '../shared/professional-roles.js';
import { planAgentBudget, runWithAgentBudget, withAgentBudgetAdmission, enforceAgentBudgetEvent, currentAgentBudget } from '../electron/harness/agent-budget.js';
import { runSubagentTask } from '../electron/runtime/subagent-loop.js';
import { createPermissionPolicy, ToolRegistry } from '../electron/agent-core.js';
import { normalizeSubagentInput, createSubagentPermissionPolicy, assertSubagentScope, resolveSubagentReasoningPolicy } from '../electron/runtime/subagent-model.js';
import { roleDefinition } from '../electron/runtime/role-capabilities.js';
import { runIsolatedVerification, verificationCommand } from '../electron/runtime/isolated-verification.js';
import { buildDockerSandboxArgs } from '../electron/sandbox-runtime.js';
import { observedWorkerChecks } from '../shared/agent-report-evidence.js';
import { createRoleLedger, withRoleBudget, beginRoleRequest, finishRoleRequest } from '../electron/runtime/role-budget.js';

const root = await realpath(await mkdtemp(join(tmpdir(), 'aporia-autonomy-')));
try {
  const defaults = defaultRoleSettings();
  assert.equal(defaults.maxRequests, null);
  for (const role of defaults.profiles) assert.equal(role.maxRounds, null);
  const legacy = { ...defaults, schedulingVersion: undefined, maxRequests: 120,
    profiles: defaults.profiles.map(role => ({ ...role, maxRounds: 4, maxRequests: 24 })) };
  const migrated = normalizeRoleSettings(legacy);
  assert.equal(migrated.maxRequests, null);
  for (const role of migrated.profiles) { assert.equal(role.maxRounds, null); assert.equal(role.maxRequests, null); }
  assert.equal(normalizeRoleSettings({ ...defaults, maxRequests: 3 }).maxRequests, 3, 'explicit user budget remains');
  assert.equal(effectiveRoleSettings(defaults, { maxRequests: 120, profiles: { explore: { maxRequests: 24, maxRounds: 4 } } }).profiles[0].maxRequests, null);
  assert.equal(effectiveRoleSettings({ ...defaults, maxRequests: 3 }, { schedulingVersion: 2, maxRequests: null }).maxRequests, null, 'explicit null means unlimited, not inherited');
  assert.equal(normalizeSubagentInput({ role: 'verify', task: 'Check', max_rounds: 2 }).maxRounds, null);
  for (const role of ['explore', 'verify', 'curator']) assert.deepEqual(resolveSubagentReasoningPolicy({ role, thinking: true, effort: 'max' }), { thinking: true, effort: 'max', source: 'parent' });
  assert.equal(normalizeSubagentInput({ role: 'explore', task: 'Find', background: true }).requiredForCompletion, false);
  assert.equal(normalizeSubagentInput({ role: 'review', task: 'Review', background: true, required_for_completion: false }).requiredForCompletion, true);
  const policy = createSubagentPermissionPolicy(createPermissionPolicy('workspace-write'), 'builder', roleDefinition(defaultRole('builder')));
  assert.equal(policy.verify_project, 'allow'); assert.equal(policy.run_command ?? policy['*'], 'deny');
  assert.equal(createSubagentPermissionPolicy(createPermissionPolicy('read-only'), 'builder', roleDefinition(defaultRole('builder'))).verify_project, 'deny');
  assert.throws(() => assertSubagentScope('verify_project', { cwd: 'src' }, ['src']), /repository-wide/);
  console.log('PASS unlimited defaults, legacy migration, inherited reasoning, advisory exploration and permission ceilings');
  const ledger = createRoleLedger(), total = createRoleLedger();
  await withRoleBudget({ ledger, total, profile: defaultRole('explore'), limit: defaults.maxRequests }, async () => {
    for (let index = 0; index < 140; index++) await finishRoleRequest(await beginRoleRequest({ messages: [] }), { total_tokens: 5, input_tokens: 3, output_tokens: 2 });
  });
  assert.equal(ledger.requests, 140); assert.equal(total.requests, 140); assert.equal(ledger.tokens, 700);
  console.log('PASS actual request accounting beyond old 24/120 defaults without resetting usage');

  const plan = planAgentBudget({ workspacePath: root, agentBudget: { profile: 'standard', maxTotalSubagents: 2, maxActiveSubagents: 2, roles: { explore: 1 } } });
  let active = 0, peak = 0;
  await runWithAgentBudget(plan, {}, async () => {
    await Promise.all(Array.from({ length: 40 }, (_, index) => withAgentBudgetAdmission({ role: 'explore' }, async () => {
      const id = `worker-${index}`;
      enforceAgentBudgetEvent({ type: 'subagent.started', agentId: id, role: 'explore' });
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setImmediate(resolve));
      active--; enforceAgentBudgetEvent({ type: 'subagent.completed', agentId: id });
    })));
    assert.equal(currentAgentBudget().state.totalStarted, 40);
  });
  assert.equal(peak, 2);
  await runWithAgentBudget(planAgentBudget({ workspacePath: root, agentBudget: { maxTotalSubagents: 0 } }), {}, async () => {
    await assert.rejects(withAgentBudgetAdmission({ role: 'explore' }, async () => enforceAgentBudgetEvent({ type: 'subagent.started', agentId: 'disabled', role: 'explore' })), /budget|prohibit/i);
  });
  console.log('PASS 40 starts beyond old lifetime/role quotas, bounded concurrency and explicit delegation-off');

  const registry = new ToolRegistry([{ risk: 'read', definition: { type: 'function', function: {
    name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } },
  } } }]);
  const profile = defaultRole('explore');
  let requests = 0;
  const options = {
    agentId: 'long-worker', input: { ...normalizeSubagentInput({ role: 'explore', task: 'Inspect all findings', context: 'Confirmed interface: one finding per file.' }, [profile]), maxRounds: 2 },
    provider: { supportsTools: true, async complete() {
      if (++requests <= 32) return { message: { content: null, tool_calls: [{ id: `read-${requests}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `item-${requests}.js` }) } }] }, usage: null };
      return { message: { content: 'All 32 findings inspected.' }, usage: null };
    } }, modelId: 'fixture', modelConfig: { contextWindow: 128000 }, workspaceRoot: root,
    parentPermissionPolicy: createPermissionPolicy('workspace-write'), signal: new AbortController().signal,
    session: { roleRounds: 70 }, emit() {}, toolRegistry: registry, parseToolArguments: call => JSON.parse(call.function.arguments),
    executeAuthorizedTool: async ({ input }) => ({ modelResult: { path: input.path, content: input.path, sha256: input.path } }),
  };
  const result = await runSubagentTask(options);
  assert.equal(result.status, 'completed'); assert.equal(requests, 33); assert.equal(options.session.roleRounds, 103);
  assert(options.session.conversation[0].content.includes('Confirmed interface'));
  const controller = new AbortController();
  await assert.rejects(runSubagentTask({ ...options, agentId: 'cancel-worker', session: {}, signal: controller.signal,
    provider: { supportsTools: true, async complete() { controller.abort(); return { message: { content: 'Never rely on stale result' } }; } } }), { name: 'AbortError' });
  console.log('PASS more than 20 model rounds with retained cumulative history, concise handoff and cooperative cancellation');
  let repeated = 0;
  const stopped = await runSubagentTask({ ...options, agentId: 'no-progress', session: {}, provider: { supportsTools: true, async complete() {
    repeated++; return { message: { content: null, tool_calls: [{ id: `repeat-${repeated}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"same.js"}' } }] } };
  } } });
  assert.equal(stopped.status, 'failed'); assert.match(stopped.summary, /LOOP_NO_PROGRESS/); assert(repeated < 20);
  console.log('PASS no-progress protection still stops genuinely repeated work without a round cutoff');

  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs', publish: 'never' } }));
  await writeFile(join(root, 'safe.mjs'), "import fs from 'node:fs'; fs.writeFileSync('SHOULD_NOT_EXIST', 'bad');\n");
  await writeFile(join(root, 'bad.mjs'), 'const = ;');
  await writeFile(join(root, '.env'), 'SYNTHETIC_SECRET=fixture');
  await mkdir(join(root, 'node_modules')); await mkdir(join(root, '.git'));
  const parsed = await runIsolatedVerification({ workspaceRoot: root, input: { kind: 'node_check', path: 'safe.mjs' }, sandboxStatus: { available: false } });
  assert.equal(parsed.exitCode, 0); assert.equal(parsed.parseOnly, true);
  await assert.rejects(access(join(root, 'SHOULD_NOT_EXIST')), { code: 'ENOENT' });
  assert.notEqual((await runIsolatedVerification({ workspaceRoot: root, input: { kind: 'node_check', path: 'bad.mjs' } })).exitCode, 0);
  for (const input of [{ kind: 'script', script: 'publish' }, { kind: 'script', script: 'test; echo bad' }, { kind: 'script', script: 'test', command: 'bad' }, { kind: 'node_check', path: '../outside.js' }]) await assert.rejects(verificationCommand(root, input));
  await assert.rejects(runIsolatedVerification({ workspaceRoot: root, input: { kind: 'script', script: 'test' }, statusLoader: async () => ({ available: false }), runner: () => { throw new Error('must not execute'); } }), /ISOLATED_VERIFICATION_UNAVAILABLE/);
  let temporary;
  const isolated = await runIsolatedVerification({ workspaceRoot: root, input: { kind: 'script', script: 'test' }, sandboxStatus: { available: true }, runner: async args => {
    temporary = args.workspaceRoot; assert.notEqual(args.workspaceRoot, root);
    await assert.rejects(access(join(args.workspaceRoot, '.env'))); await assert.rejects(access(join(args.workspaceRoot, '.git')));
    assert.equal(args.dependencyRoot, join(root, 'node_modules'));
    const argv = buildDockerSandboxArgs({ ...args, containerName: 'fixture' });
    assert(argv.includes('none')); assert(argv.includes(`${args.dependencyRoot}:/workspace/node_modules:ro`));
    await writeFile(join(args.workspaceRoot, 'safe.mjs'), 'modified only in snapshot');
    return { exitCode: 0, stdout: 'fixture check', stderr: '' };
  } });
  assert.equal(isolated.writeback, false); assert.equal(isolated.isolated, true);
  assert((await readFile(join(root, 'safe.mjs'), 'utf8')).includes('SHOULD_NOT_EXIST'));
  await assert.rejects(access(temporary));
  const outside = join(root, 'outside-target'); await mkdir(outside);
  const link = join(root, 'link'); await symlink(tmpdir(), link, 'junction');
  await assert.rejects(verificationCommand(root, { kind: 'script', script: 'test', cwd: 'link' }), /escapes/);
  assert.equal(observedWorkerChecks({ evidence: [{ tool: 'verify_project', command: 'node --check safe.mjs', exitCode: 0 }] }).commands.length, 1);
  console.log('PASS parse-only self-check does not execute code; isolated scripts, read-only dependencies, no writeback/fallback, rejected injection/escape and cleanup');
} finally { await rm(root, { recursive: true, force: true }); }
