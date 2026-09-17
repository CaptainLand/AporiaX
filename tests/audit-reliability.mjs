// Deterministic architecture regressions: no real accounts, models, or network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createTaskHistoryStore } from '../electron/task-history-store.js';
import { atomicWriteFile } from '../electron/storage/atomic-file.js';
import { mutateWorkspaceFiles } from '../electron/runtime/workspace-mutations.js';
import { readTextPage } from '../electron/runtime/text-reader.js';
import { createHarnessKernel } from '../electron/harness/kernel.js';
import { clearDefaultAgentRuntimeBroker } from '../electron/harness/agent-runtime-broker.js';
import { createHarnessTaskRuntime } from '../electron/harness/task-runtime.js';
import { closeRunJournalStore } from '../electron/run-store.js';
import { runLocalSandboxedCommand } from '../electron/sandbox-runtime.js';
import { createSafeDependencySession } from '../electron/runtime/safe-dependency-session.js';
import { inspectImageDimensions, shouldRecognizePage, mergeRecognizedText } from '../electron/ocr/preflight.js';
import { createOcrProcess } from '../electron/ocr/process-client.js';
import { configureTrustedIpc, assertTrustedIpcSender, isTrustedAppUrl } from '../electron/security/trusted-ipc.js';
import { createMcpRuntime, cancellableMcpRequest } from '../electron/mcp-runtime.js';

const root = await fs.mkdtemp(join(tmpdir(), 'aporiax-audit-'));
let count = 0;
async function check(name, run) { await run(); count++; console.log(`PASS audit ${count}: ${name}`); }
const task = (id, content = 'hello') => ({ id, title: id, messages: [{ id: id + '-message', role: 'user', content }] });
const readJson = async path => JSON.parse(await fs.readFile(path, 'utf8'));
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
try {
  await check('partial migration retries without hiding healthy or failed originals', async () => {
    const dir = join(root, 'migration'); await fs.mkdir(dir);
    const legacy = join(dir, 'aporiax-tasks.json');
    await fs.writeFile(legacy, JSON.stringify([task('small'), task('large', 'x'.repeat(500))]));
    const first = createTaskHistoryStore(dir, { maxTaskJsonBytes: 256 });
    assert.deepEqual((await first.loadTasks()).map(t => t.id), ['small']);
    assert.equal((await readJson(legacy)).length, 2);
    assert(first.diagnostics().some(d => d.code === 'TASK_MIGRATION_PARTIAL'));
    const next = createTaskHistoryStore(dir);
    assert.deepEqual((await next.loadTasks()).map(t => t.id).sort(), ['large', 'small']);
    assert.equal((await readJson(legacy + '.migrated')).length, 2);
    assert.equal((await readJson(join(dir, 'aporiax-store/migration.json'))).status, 'completed');
  });
  await check('single corrupt history record is preserved and does not block healthy tasks', async () => {
    const dir = join(root, 'corrupt-task'), store = createTaskHistoryStore(dir);
    await store.saveTasks([task('good'), task('bad')]);
    const bad = join(dir, 'aporiax-store/tasks/bad.json'); await fs.writeFile(bad, '{broken');
    const snapshot = await store.loadSnapshot();
    assert.deepEqual(snapshot.tasks.map(t => t.id), ['good']);
    assert(snapshot.diagnostics.some(d => d.code === 'TASK_FILE_CORRUPT'));
    await store.saveTasks([task('good', 'new')], { expectedRevision: snapshot.revision });
    assert.equal(await fs.readFile(bad, 'utf8'), '{broken');
    assert((await readJson(join(dir, 'aporiax-store/index.json'))).taskIds.includes('bad'));
  });
  await check('corrupt index is read-only, stale saves and implicit pruning cannot destroy data', async () => {
    const dir = join(root, 'index'), store = createTaskHistoryStore(dir);
    await store.saveTasks([task('a'), task('b')]);
    let snapshot = await store.loadSnapshot();
    const saved = await store.saveTasks([task('a', 'new')], { expectedRevision: snapshot.revision });
    assert.equal((await store.loadTasks()).length, 2, 'absence is not deletion');
    await assert.rejects(store.saveTasks([task('a', 'stale')], { expectedRevision: snapshot.revision }), /REVISION_CONFLICT/);
    assert.equal((await store.loadTask('a')).messages[0].content, 'new');
    await store.saveTasks([task('a', 'new')], { expectedRevision: saved.revision, deletedTaskIds: ['b'] });
    assert.deepEqual((await store.loadTasks()).map(t => t.id), ['a']);
    assert.equal((await fs.readdir(join(dir, 'aporiax-store/deleted'))).length, 1);
    await fs.writeFile(join(dir, 'aporiax-store/index.json'), '{broken');
    snapshot = await store.loadSnapshot(); assert.equal(snapshot.readOnly, true); assert.equal(snapshot.tasks.length, 1);
    await assert.rejects(store.saveTasks([]), /RECOVERY_REQUIRED/);
  });
  await check('independent store instances serialize matching-revision writes', async () => {
    const dir = join(root, 'serial'), a = createTaskHistoryStore(dir), b = createTaskHistoryStore(dir);
    const start = await a.saveTasks([task('one')]);
    const results = await Promise.allSettled([
      a.saveTasks([task('one', 'first')], { expectedRevision: start.revision }),
      b.saveTasks([task('one', 'second')], { expectedRevision: start.revision }),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await a.loadTask('one')).messages[0].content, 'first');
    await assert.rejects(a.saveTasks([task('one', 'must-not-write')], { deletedTaskIds: ['one'] }), /deletion|delete/i);
    assert.equal((await a.loadTask('one')).messages[0].content, 'first');
  });
  await check('atomic replacement failure never deletes previous committed bytes', async () => {
    const path = join(root, 'atomic.txt'); await fs.writeFile(path, 'old');
    const io = { ...fs, rename: async () => { throw Object.assign(new Error('file locked'), { code: 'EPERM' }); } };
    await assert.rejects(atomicWriteFile(path, 'new', { io }), { code: 'EPERM' });
    assert.equal(await fs.readFile(path, 'utf8'), 'old');
    assert(!(await fs.readdir(root)).some(name => name.startsWith('atomic.txt.') && name.endsWith('.tmp')));
  });
  await check('shared native mutation rolls back prior writes without overwriting a concurrent edit', async () => {
    const workspaceRoot = join(root, 'mutations'); await fs.mkdir(workspaceRoot);
    for (const name of ['a', 'b']) await fs.writeFile(join(workspaceRoot, name), 'old-' + name);
    let manifest;
    await assert.rejects(mutateWorkspaceFiles({ workspaceRoot, recoveryDirectory: join(root, 'mutation-recovery'),
      edits: ['a', 'b'].map(path => ({ path, before: Buffer.from('old-' + path), after: Buffer.from('new-' + path) })),
      onPrepared: async recovery => { manifest = recovery.manifestPath; await fs.writeFile(join(workspaceRoot, 'b'), 'human'); },
    }), /MERGE_FAILED/);
    assert.equal(await fs.readFile(join(workspaceRoot, 'a'), 'utf8'), 'old-a');
    assert.equal(await fs.readFile(join(workspaceRoot, 'b'), 'utf8'), 'human');
    assert.equal((await readJson(manifest)).status, 'recovery-required');
    await assert.rejects(mutateWorkspaceFiles({ workspaceRoot, edits: [{ path: '../escape', before: null, after: Buffer.from('no') }] }), /Invalid/);
  });
  await check('bounded reader advances within long lines and preserves CRLF coverage', async () => {
    const path = join(root, 'long.txt'); const long = 'A'.repeat(150000);
    await fs.writeFile(path, long + '\r\n中文\r\nlast');
    const first = await readTextPage(path, { start_line: 1, end_line: 1, limit: 1000 });
    assert.equal(first.content.length, 1000); assert.equal(first.nextOffset, 1000); assert.equal(first.nextStartLine, null);
    const second = await readTextPage(path, { offset: first.nextOffset, limit: 1000 });
    assert.equal(second.readRange.start, 1000); assert.equal(second.nextOffset, 2000);
    const lines = await readTextPage(path, { start_line: 2, end_line: 2 });
    assert.equal(lines.content, '中文'); assert.equal(lines.readRange.start, 150001); assert.equal(lines.nextStartLine, 3);
    await fs.writeFile(path, Buffer.from([0xff, 0xff]));
    await assert.rejects(readTextPage(path), /encoded|encoding/i);
  });
  await check('real Kernel Broker admits six workers, queues seventh, and rejects duplicate scheduler ids', async () => {
    const kernel = createHarnessKernel(); let release; const gate = new Promise(r => release = r);
    let started = 0;
    const promises = Array.from({ length: 7 }, (_, i) => kernel.agentRuntime.run({ agentId: `audit-${i}`, role: 'builder', execute: async () => { started++; await gate; return { status: 'completed' }; } }));
    try {
      for (let i = 0; i < 30 && started < 6; i++) await tick();
      assert.equal(started, 6); assert.equal(kernel.scheduler.snapshot().running.length, 6); assert.equal(kernel.scheduler.snapshot().queued.length, 1);
      assert.throws(() => kernel.scheduler.enqueue({ id: 'agent:audit-0', run() {} }), /already|duplicate/i);
    } finally { release(); await Promise.all(promises); clearDefaultAgentRuntimeBroker(); }
    assert.equal(started, 7);
  });
  await check('TaskRuntime counts detached and preparing work; concurrent duplicate start is rejected', async () => {
    const dir = join(root, 'runtime'); const runtime = createHarnessTaskRuntime({ dataDirectory: dir });
    const counts = []; const unsubscribe = runtime.subscribeActiveRuns(() => counts.push(runtime.listActiveRuns().length));
    let release; const gate = new Promise(r => release = r);
    const options = { runId: 'detached', detached: true, metadata: { workspacePath: root }, execute: async () => { await gate; return { status: 'completed' }; } };
    const start = runtime.start(options);
    assert.equal(runtime.listActiveRuns().length, 1, 'pre-journal reservation is visible');
    await assert.rejects(runtime.start(options), /already active/);
    await start; assert.equal(runtime.getActiveRun('detached').workspacePath, root);
    release(); for (let i = 0; i < 60 && runtime.hasActiveRuns(); i++) await tick();
    assert.equal(runtime.hasActiveRuns(), false); assert(counts.includes(1)); assert.equal(counts.at(-1), 0);
    unsubscribe(); await closeRunJournalStore(dir);
  });
  await check('Safe dependency installation survives the next command without mutating host node_modules', async () => {
    const workspaceRoot = join(root, 'safe'); await fs.mkdir(workspaceRoot);
    const dependencies = createSafeDependencySession();
    await fs.writeFile(join(workspaceRoot, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
    await fs.writeFile(join(workspaceRoot, 'install.cjs'), `const fs=require('fs');fs.mkdirSync('node_modules/audit-fixture',{recursive:true});fs.writeFileSync('node_modules/audit-fixture/index.js','module.exports=42');`);
    await fs.writeFile(join(workspaceRoot, 'use.cjs'), `require('fs').writeFileSync('answer.txt',String(require('audit-fixture')))`);
    const run = command => runLocalSandboxedCommand({ workspaceRoot, cwd: workspaceRoot, localSandboxBaseDirectory: join(root, 'safe-data'), command, dependencySession: dependencies, timeoutMs: 10000 });
    try {
      assert.equal((await run('node install.cjs')).exitCode, 0);
      const next = await run('node use.cjs'); assert.equal(next.exitCode, 0, next.stderr);
      assert.equal(await fs.readFile(join(workspaceRoot, 'answer.txt'), 'utf8'), '42');
      await assert.rejects(fs.stat(join(workspaceRoot, 'node_modules')), { code: 'ENOENT' });
    } finally { await dependencies.close(); }
  });
  await check('mixed PDF and forced OCR policy; large raster dimensions rejected before decode', async () => {
    assert.equal(shouldRecognizePage({ text: 'page 1', hasImages: true }), true);
    assert.equal(shouldRecognizePage({ text: 'real text' }), false);
    assert.equal(shouldRecognizePage({ text: 'real text', forceOcr: true }), true);
    assert.equal(mergeRecognizedText('Title\n1', 'Title\nScanned body'), 'Title\nScanned body\n1');
    const png = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.write('IHDR', 12);
    png.writeUInt32BE(200, 16); png.writeUInt32BE(100, 20); assert.deepEqual(inspectImageDimensions(png), { width: 200, height: 100 });
    png.writeUInt32BE(50000, 16); assert.throws(() => inspectImageDimensions(png), /尺寸/);
  });
  await check('OCR worker executes in a different process without inheriting arbitrary environment', async () => {
    const path = join(root, 'ocr-probe.mjs');
    await fs.writeFile(path, `import{parentPort}from'node:worker_threads';parentPort.postMessage({type:'probe',pid:process.pid,leak:process.env.APORIAX_AUDIT_FIXTURE});setInterval(()=>{},1000);`);
    process.env.APORIAX_AUDIT_FIXTURE = 'not-a-secret-test-value';
    const child = createOcrProcess(path, { workerData: {} });
    try { const [message] = await once(child, 'message', { signal: AbortSignal.timeout(10000) });
      assert.equal(message.type, 'probe'); assert.notEqual(message.pid, process.pid); assert.equal(message.leak, undefined);
    } finally { delete process.env.APORIAX_AUDIT_FIXTURE; await child.terminate(); }
  });
  await check('IPC permits only application main frame, never another local file or embedded frame', async () => {
    const expectedUrl = 'file:///app/dist/index.html'; const frame = { url: expectedUrl };
    const sender = { mainFrame: frame }; configureTrustedIpc({ getWindow: () => ({ webContents: sender, isDestroyed: () => false }), expectedUrl });
    assertTrustedIpcSender({ sender, senderFrame: frame });
    assert.throws(() => assertTrustedIpcSender({ sender, senderFrame: { url: expectedUrl } }), /untrusted/);
    frame.url = 'file:///tmp/untrusted.html'; assert.throws(() => assertTrustedIpcSender({ sender, senderFrame: frame }), /untrusted/);
    assert.equal(isTrustedAppUrl('http://127.0.0.1:51730/', 'http://127.0.0.1:5173/', true), false);
  });
  await check('MCP timeout and user cancellation reach SDK signal, retaining uncertain outcome semantics', async () => {
    let received;
    await assert.rejects(cancellableMcpRequest(options => { received = options.signal; return new Promise(() => {}); }, 20), /timed out.*uncertain/);
    assert.equal(received.aborted, true);
    const controller = new AbortController();
    const client = { async connect() {}, getServerCapabilities: () => ({ tools: {} }), getServerVersion: () => ({}),
      listTools: async () => ({ tools: [{ name: 'effect', inputSchema: { type: 'object' } }] }),
      callTool(params, schema, options) { received = options.signal; controller.abort(); return new Promise(() => {}); }, async close() {} };
    const runtime = createMcpRuntime({ servers: [{ id: 'fixture', name: 'fixture', enabled: true, timeoutMs: 5000 }], clientFactory: () => client, transportFactory: () => ({ async close() {} }) });
    try { const found = await runtime.discover({ permissionMode: 'workspace-write' });
      await assert.rejects(runtime.call(found.tools[0].name, {}, { signal: controller.signal, requestApproval: async () => ({ approved: true }) }), /cancelled.*uncertain/);
      assert.equal(received.aborted, true);
    } finally { await runtime.close(); }
  });
  console.log(`Audit reliability: ${count}/${count} scenarios passed.`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
