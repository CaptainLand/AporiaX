import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import JSZip from 'jszip';
import { runHarness } from '../electron/agent-runtime.js';
import { createPermissionPolicy } from '../electron/agent-core.js';
import { TOOL_REGISTRY } from '../electron/runtime/native-tool-catalog.js';
import { configureNativeFileAccess } from '../electron/runtime/file-access-policy.js';
import { createFullAutoApproval } from '../electron/runtime/full-auto-approval.js';
import { dispatchNativeTool } from '../electron/runtime/tool-dispatcher.js';
import { createNativeToolExecutor } from '../electron/runtime/native-tool-executor.js';
import { verifyExistingTarget, verifyWritableTarget } from '../electron/runtime/workspace-runtime.js';
import { withDurableRun } from '../electron/runtime/durable-run.js';
import { createPersistentProcessManager } from '../electron/runtime/process-runtime.js';
import { createSafeDependencySession } from '../electron/runtime/safe-dependency-session.js';
import { runLocalSandboxedCommand } from '../electron/sandbox-runtime.js';
import { configureWorkspaceRecoveryDirectory, inspectWorkspaceSnapshot } from '../electron/runtime/workspace-mutations.js';
import { APPROVE_ALL_MODE } from '../shared/approval-modes.js';
import { taskApprovalMode } from '../src/state/approval-mode.js';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'aporia-approve-all-')));
const workspace = join(temp, 'workspace');
const outside = join(temp, 'outside.txt');
const responses = [];
const originalFetch = globalThis.fetch;
const call = (index, name, input) => ({ index, id: `tool-${index}`, type: 'function', function: { name, arguments: JSON.stringify(input) } });
const message = delta => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
let prompts = 0;
const requestHuman = async () => { prompts++; return { approved: false }; };
try {
  await mkdir(workspace);
  configureNativeFileAccess(() => ({ enabled: true }));
  configureWorkspaceRecoveryDirectory(() => join(temp, 'recovery'));
  await writeFile(outside, 'outside stays untouched');
  const originalContents = 'restorable original\n'.repeat(8_000);
  await writeFile(join(workspace, 'disposable.txt'), originalContents);

  const before = [];
  const approve = createFullAutoApproval({ approvalMode: APPROVE_ALL_MODE, requestApproval: requestHuman, emit: event => before.push(event) });
  for (const args of [{ kind: 'recovery-reconciliation', tool: 'delete_file' }, { kind: 'agent-role-change' }, { kind: 'skill-install' }, { mcp: { tool: 'run_command' }, toolName: 'run_command' }]) {
    assert.equal((await approve(args)).skipped, true);
  }
  assert(before.every(e => e.type === 'approval.skipped'));
  const dispatch = (name, input, { mode = 'direct', available = false, localAvailable = true, permission = 'workspace-write', executeAuthorized,
    approvalMode = APPROVE_ALL_MODE, requestApproval = approve, executeContext = {} } = {}) => dispatchNativeTool({
    toolCall: call(0, name, input), registry: TOOL_REGISTRY, approvalMode, executionMode: mode,
    sandboxStatus: { available, localAvailable }, requestApproval, permissionPolicy: createPermissionPolicy(permission),
    parseArguments: tool => JSON.parse(tool.function.arguments), executeContext: { workspaceRoot: workspace, ...executeContext },
    executeAuthorized: executeAuthorized || (({ permissionDecision }) => ({ modelResult: { backend: permissionDecision.backend.backend } })),
  });
  assert.equal((await dispatch('run_command', { command: 'npm run build' })).modelResult.backend, 'host');
  assert.equal((await dispatch('run_command', { command: 'python scripts/check.py' }, { mode: 'isolated', available: true })).modelResult.backend, 'docker');
  await assert.rejects(dispatch('run_command', { command: 'npm test' }, { mode: 'isolated' }), { code: 'APPROVE_ALL_SKIPPED' });
  await assert.rejects(dispatch('start_process', { command: 'npm run dev' }, { mode: 'isolated', available: true }), { code: 'APPROVE_ALL_SKIPPED' });
  await assert.rejects(dispatch('run_command', { command: 'npm test && git push' }), { code: 'APPROVE_ALL_SKIPPED' });
  await assert.rejects(dispatch('run_command', { command: 'rm disposable.txt' }, { mode: 'isolated', available: true }), { code: 'APPROVE_ALL_SKIPPED' });
  await assert.rejects(dispatch('git_push', {}), { code: 'APPROVE_ALL_SKIPPED' });
  await assert.rejects(dispatch('delete_file', { path: 'disposable.txt' }, { permission: 'read-only' }), /Permission denied/);
  await assert.rejects(dispatch('read_file', { path: outside }), { code: 'FILE_ACCESS_DENIED' });
  assert.equal(taskApprovalMode(APPROVE_ALL_MODE), APPROVE_ALL_MODE);
  assert.equal(taskApprovalMode(), 'full-auto');

  // Exercise the real dispatcher and executor. No model text reaches a shell.
  const executor = createNativeToolExecutor({ verifyExistingTarget, verifyWritableTarget,
    searchWorkspaceText: assert.fail, calculateLineChanges: assert.fail, runGitCommand: assert.fail });
  const executeArchive = args => executor({ ...args, sandboxExecutor: () => assert.fail('Archive must not invoke a shell') });
  const pack = (command, options = {}, input = {}) => dispatch('run_command', { command, ...input }, { executeAuthorized: executeArchive, ...options });
  const skin = join(workspace, '# - 测试皮肤');
  await mkdir(join(skin, 'images'), { recursive: true });
  await writeFile(join(skin, 'skin.ini'), 'Name: Test skin');
  await writeFile(join(skin, 'images', 'asset.png'), Buffer.from([0, 1, 2]));
  const archiveCommand = `powershell -NoProfile -Command "Compress-Archive -Path '${skin}/*' -DestinationPath 'skin.osk'"`;
  const unpack = async path => JSZip.loadAsync(await readFile(join(workspace, path)), { checkCRC32: true });
  let receipt = (await pack(archiveCommand)).modelResult;
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.backend, 'native-archive');
  assert.equal(receipt.files, 2);
  let archive = await unpack('skin.osk');
  assert.equal(await archive.file('skin.ini').async('string'), 'Name: Test skin');
  assert.deepEqual(await archive.file('images/asset.png').async('nodebuffer'), Buffer.from([0, 1, 2]));
  await assert.rejects(pack(archiveCommand), { code: 'ARCHIVE_EXISTS' });
  const previous = await readFile(join(workspace, 'skin.osk'));
  await writeFile(join(skin, 'skin.ini'), 'Name: Revised skin');
  receipt = (await pack(archiveCommand.replace(/"$/, ' -Force"'), { mode: 'safe' })).modelResult;
  archive = await unpack('skin.osk');
  assert.equal(await archive.file('skin.ini').async('string'), 'Name: Revised skin');
  assert.deepEqual(await readFile(join(dirname(receipt.recovery.manifestPath), '0.before')), previous);
  await pack('Compress-Archive -LiteralPath "skin.ini" -DestinationPath "../single.zip"', {}, { cwd: '# - 测试皮肤' });
  assert.equal(await (await unpack('single.zip')).file('skin.ini').async('string'), 'Name: Revised skin');

  let extraApprovals = 0;
  const automatic = createFullAutoApproval({ approvalMode: 'full-auto', workspaceRoot: workspace,
    requestApproval: async () => { extraApprovals++; return { approved: false }; } });
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --version' } }));
  await writeFile(join(workspace, 'check.mjs'), 'export const valid = true');
  await writeFile(join(workspace, '检查脚本.py'), 'print("ok")');
  for (const approvalMode of [APPROVE_ALL_MODE, 'full-auto']) {
    const options = { approvalMode, requestApproval: approvalMode === 'full-auto' ? automatic : approve };
    const check = command => dispatch('run_command', { command }, options);
    for (const command of ['python -m unittest', 'python "检查脚本.py"', 'pnpm exec tsc --noEmit', 'node check.mjs', 'node --check "a&b.js"', 'git log --grep=rm'])
      assert.equal((await check(command)).modelResult.backend, 'host', command);
    assert.equal((await dispatch('verify_project', { kind: 'script', script: 'test' }, options)).modelResult.verification, true);
    await pack(`Compress-Archive -LiteralPath check.mjs -DestinationPath ${approvalMode}.zip -CompressionLevel Optimal`, options);
    assert.equal(await (await unpack(`${approvalMode}.zip`)).file('check.mjs').async('string'), 'export const valid = true');
    for (const [tool, args] of [['git_push', {}], ['browser_click', { selector: '#demo' }], ['run_command', { command: 'npm install' }], ['run_command', { command: 'npx fixture-name' }]])
      await assert.rejects(dispatch(tool, args, options), approvalMode === 'full-auto' ? /user rejected/ : { code: 'APPROVE_ALL_SKIPPED' });
    await assert.rejects(dispatch('git_commit', { message: 'must not invoke host Git hooks' }, { ...options, available: true, mode: 'isolated' }), /host process/);
  }
  await assert.rejects(dispatch('write_file', { path: outside, content: 'do not write' }, { approvalMode: 'full-auto', requestApproval: automatic }), /user rejected/);
  assert.equal(extraApprovals, 5);
  const stages = [];
  const retryCommand = 'Compress-Archive -LiteralPath check.mjs -DestinationPath retry.zip';
  await writeFile(join(workspace, 'retry.zip'), 'existing fixture');
  await withDurableRun({ operation: record => stages.push(record.state) }, async () => {
    await assert.rejects(pack(retryCommand), { code: 'ARCHIVE_EXISTS' });
    await unlink(join(workspace, 'retry.zip'));
    await pack(retryCommand);
  });
  assert.deepEqual(stages, ['started', 'failed', 'started', 'confirmed']);

  const processRoot = join(temp, 'preview-project');
  await mkdir(processRoot);
  await writeFile(join(processRoot, 'package.json'), JSON.stringify({ scripts: { dev: 'node fixture.cjs' } }));
  await writeFile(join(processRoot, 'prepare.cjs'), "const fs = require('node:fs'); fs.mkdirSync('node_modules/fixture-dep', { recursive: true }); fs.writeFileSync('node_modules/fixture-dep/index.js', `module.exports = 'preview fixture'`)");
  await writeFile(join(processRoot, 'fixture.cjs'), "require('node:fs').writeFileSync('process-output.txt', 'private copy'); console.log(require('fixture-dep')); setTimeout(() => {}, 1000)");
  const processManager = createPersistentProcessManager();
  const safeDependencySession = createSafeDependencySession(), sandboxDataDirectory = join(temp, 'sandbox');
  try {
    const prepared = await runLocalSandboxedCommand({ command: 'node prepare.cjs', cwd: processRoot, workspaceRoot: processRoot,
      localSandboxBaseDirectory: sandboxDataDirectory, dependencySession: safeDependencySession });
    assert.equal(prepared.exitCode, 0, prepared.stderr);
    await assert.rejects(readFile(join(processRoot, 'node_modules', 'fixture-dep', 'index.js')), { code: 'ENOENT' });
    const preview = (await dispatch('start_process', { command: 'node fixture.cjs' }, { mode: 'safe', executeAuthorized: executor,
      executeContext: { processManager, workspaceRoot: processRoot, sandboxDataDirectory, safeDependencySession } })).modelResult;
    assert.equal(preview.executionBackend, 'local-workspace');
    assert.equal(preview.writeback, false);
    assert.notEqual(preview.cwd, processRoot);
    const finished = await processManager.wait({ processId: preview.processId, until: 'exit', timeoutMs: 9000 });
    assert.equal(finished.exitCode, 0, finished.output);
    assert.match(finished.output, /preview fixture/);
    await assert.rejects(readFile(join(processRoot, 'process-output.txt')), { code: 'ENOENT' });
  } finally { await processManager.closeAll(); await safeDependencySession.close(); }

  for (const command of [
    'powershell -NoProfile -File ./make_osk.ps1',
    'Compress-Archive -Path * -DestinationPath skin.zip; Write-Output More',
    'Compress-Archive -Path * -DestinationPath skin.zip | Write-Output',
    'Compress-Archive -Path $(Get-Location) -DestinationPath skin.zip',
    'Compress-Archive -Path * -DestinationPath skin.zip -Update',
  ]) await assert.rejects(pack(command, {}, { workspaceArchive: { source: '.', destination: 'unapproved.zip' } }), { code: 'APPROVE_ALL_SKIPPED' });
  await assert.rejects(pack(archiveCommand, { permission: 'read-only' }), /Permission denied/);
  await assert.rejects(pack(archiveCommand, { mode: 'safe', localAvailable: false }), { code: 'APPROVE_ALL_SKIPPED' });
  await assert.rejects(pack(archiveCommand, { mode: 'isolated' }), { code: 'APPROVE_ALL_SKIPPED' });
  await assert.rejects(pack('Compress-Archive -LiteralPath ../outside.txt -DestinationPath denied.zip'), { code: 'FILE_ACCESS_DENIED' });
  await assert.rejects(pack('Compress-Archive -LiteralPath single.zip -DestinationPath ../outside.zip'), { code: 'FILE_ACCESS_DENIED' });
  const externalDirectory = join(temp, 'outside-folder');
  await mkdir(externalDirectory);
  await symlink(externalDirectory, join(workspace, 'external-folder'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(pack('Compress-Archive -Path external-folder/* -DestinationPath denied.zip'), { code: 'FILE_ACCESS_DENIED' });
  await assert.rejects(pack('Compress-Archive -LiteralPath single.zip -DestinationPath external-folder/outside.zip'), { code: 'FILE_ACCESS_DENIED' });
  await link(outside, join(skin, 'external-link.txt'));
  await assert.rejects(pack(archiveCommand.replace('skin.osk', 'denied.zip')), { code: 'FILE_ACCESS_DENIED' });
  await assert.rejects(readFile(join(workspace, 'denied.zip')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(temp, 'outside.zip')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(externalDirectory, 'outside.zip')), { code: 'ENOENT' });
  console.log('Always allow: real workspace ZIP/OSK, checked inputs, recoverable overwrite, no raw shell or external paths: PASS');

  const eventLog = [];
  const toolCalls = [
    call(0, 'delete_file', { path: 'disposable.txt' }),
    call(1, 'write_file', { path: outside, content: 'should not be written' }),
    call(2, 'write_file', { path: 'result.txt', content: 'independent work succeeded' }),
    call(3, 'run_command', { command: "Compress-Archive -LiteralPath '# - 测试皮肤/skin.ini' -DestinationPath harness.zip" }),
    call(4, 'run_command', { command: 'npx cannot-run-this-fixture' }),
  ];
  let loaded = false;
  globalThis.fetch = async (_url, { body }) => {
    const request = JSON.parse(body);
    const advertised = new Set((request.tools || []).map(tool => tool.function.name));
    if (!loaded && (!advertised.has('delete_file') || !advertised.has('run_command')) && advertised.has('enable_task_tools')) {
      loaded = true;
      const groups = request.tools.find(tool => tool.function.name === 'enable_task_tools')?.function.parameters.properties.groups.items.enum;
      return message({ tool_calls: [call(0, 'enable_task_tools', { groups: groups.includes('workspace_write') ? ['workspace_write', 'terminal'] : ['workspace'] })] });
    }
    responses.push(request);
    assert(responses.length <= 4, 'unexpected model-request loop');
    return responses.length === 1 ? message({ tool_calls: toolCalls }) : message({ content: 'Completed work inside the workspace.' });
  };
  const result = await runHarness({ runId: 'approval-mode-test', taskId: 'desktop-task', workspacePath: workspace,
    provider: { id: 'fixture', name: 'fixture', baseUrl: 'https://example.invalid/v1', apiKey: 'test', models: [{ id: 'fixture', supportsTools: true }] },
    modelId: 'fixture', permission: 'workspace-write', approvalMode: APPROVE_ALL_MODE, signal: AbortSignal.timeout(12_000),
    requestApproval: requestHuman, onEvent: event => eventLog.push(event),
    sandboxExecutor: () => assert.fail('The task archive must not run a shell'),
    sandboxStatusResolver: async () => ({ available: false, localAvailable: true, executionProfile: 'direct' }),
    messages: [{ role: 'user', content: 'Delete disposable.txt and write result.txt in the current project.' }],
  });
  assert.equal(result.status, 'completed', result.content);
  assert.equal(prompts, 0);
  assert.equal(await readFile(outside, 'utf8'), 'outside stays untouched');
  assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'independent work succeeded');
  assert.equal(await (await unpack('harness.zip')).file('skin.ini').async('string'), 'Name: Revised skin');
  await assert.rejects(readFile(join(workspace, 'disposable.txt')), { code: 'ENOENT' });
  const deletion = result.changes.find(change => change.path === 'disposable.txt');
  const snapshot = await inspectWorkspaceSnapshot(workspace, 'disposable.txt', deletion.fileSnapshot);
  assert.equal(await readFile(snapshot.filePath, 'utf8'), originalContents);
  assert(eventLog.some(e => e.type === 'approval.mode.enabled' && e.mode === APPROVE_ALL_MODE));
  assert(eventLog.some(e => e.type === 'approval.automatic' && e.tool === 'delete_file'));
  assert(eventLog.some(e => e.type === 'approval.automatic' && e.tool === 'run_command'));
  assert(eventLog.some(e => e.type === 'tool.completed' && e.callId === 'tool-3' && e.success === true));
  assert(eventLog.some(e => e.type === 'tool.completed' && e.callId === 'tool-4' && e.skipped === true));
  assert(eventLog.some(e => e.type === 'approval.skipped' && e.tool === 'run_command'));
  assert(eventLog.some(e => e.type === 'tool.completed' && e.callId === 'tool-1' && e.success === false));
  assert(result.witness.records.some(record => record.eventType === 'approval.mode.enabled'));
  assert(result.witness.records.some(record => record.callId === 'tool-1' && record.status === 'skipped'));
  console.log('Always allow: protected approvals skipped, backend/profile and file permissions preserved, recoverable deletion and independent work verified without user prompts: PASS');
} finally {
  globalThis.fetch = originalFetch;
  await rm(temp, { recursive: true, force: true });
}
