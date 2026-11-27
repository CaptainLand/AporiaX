import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWitnessJournalReader, createWitnessJournalWriter } from '../electron/runtime/witness-journal.js';
import { createWitnessMonitor } from '../electron/witness-monitor.js';
import { createHarnessTaskRuntime } from '../electron/harness/task-runtime.js';
import { closeRunJournalStore, readRunEvents, readRunResult, readRunWitnessHistory } from '../electron/run-store.js';

let now = Date.parse('2026-11-22T04:00:00Z');
const date = () => new Date(now).toISOString();
const writer = createWitnessJournalWriter(), reader = createWitnessJournalReader();
const durable = [], live = [];
const monitor = createWitnessMonitor({ now: () => now, heartbeatMs: 0, emit(event) {
  live.push(event);
  const delta = writer(event);
  if (delta) {
    durable.push(delta);
    assert(reader.apply(delta.witnessDelta));
    assert.deepEqual(reader.snapshot(), event.witness, 'journal delta reconstructs the original snapshot');
  }
} });
monitor.observe({ type: 'turn.started', timestamp: date() });
monitor.observe({ type: 'tool.started', callId: 'long', tool: 'run_command', timestamp: date() });
const baseline = durable.length;
now += 15_000; monitor.heartbeat();
assert.equal(durable.length, baseline, 'elapsed-only progress stays in the live UI');
assert.equal(live.at(-1).witness.current.elapsedMs, 15_000);
now += 110_000; monitor.heartbeat();
assert.equal(durable.length, baseline + 1, 'a real stall warning in a heartbeat is durable');
assert.equal(reader.snapshot().alerts.length, 1);
monitor.observe({ type: 'tool.completed', callId: 'long', tool: 'run_command', success: true, timestamp: date() });
assert.equal(durable.at(-1).witnessDelta.upsert.length, 1, 'only the changed tool is stored');
monitor.dispose();

const directory = await mkdtemp(join(tmpdir(), 'aporia-witness-delta-'));
const runtime = createHarnessTaskRuntime({ dataDirectory: directory });
const runId = 'storage-bench', taskId = 'witness-test';
let legacyPayloadBytes = 0;
let child;
try {
  const final = await runtime.start({ runId, taskId,
    onEvent: event => { if (event.witness) legacyPayloadBytes += Buffer.byteLength(JSON.stringify(event)); },
    execute: async ({ emit }) => {
      const monitor = createWitnessMonitor({ emit, heartbeatMs: 0, now: () => now });
      const observe = (type, fields) => { now += 30; monitor.observe({ type, timestamp: date(), ...fields }); };
      try {
        observe('turn.started');
        for (let i = 0; i < 320; i++) {
          const action = { callId: 'call-' + i, tool: i % 3 ? 'read_file' : 'write_file', path: 'src/module-' + i + '/index.ts' };
          if (i % 2 === 0) observe('response.reset', { round: i });
          observe('tool.started', action); observe('tool.completed', { ...action, success: true });
          if (i % 8 === 0) { now += 15_000; monitor.heartbeat(); }
        }
        observe('turn.completed', { status: 'completed' });
        return { status: 'completed', witness: monitor.snapshot() };
      } finally { monitor.dispose(); }
    },
  });
  const sqlite = new DatabaseSync(join(directory, 'aporiax-runs.sqlite3'), { readOnly: true });
  let witnessRows, bytes, firstPageCursor;
  try {
    witnessRows = sqlite.prepare("SELECT count(*) AS count, sum(length(CAST(payload_json AS BLOB))) AS bytes FROM run_events WHERE run_id=? AND type='witness.delta'").get(runId);
    const result = sqlite.prepare('SELECT payload_json FROM run_results WHERE run_id=?').get(runId);
    bytes = witnessRows.bytes + Buffer.byteLength(result.payload_json);
    assert.ok(bytes / legacyPayloadBytes < .10, `stored ${bytes} of ${legacyPayloadBytes} bytes`);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM run_events WHERE run_id=? AND type='witness.updated'").get(runId).count, 0);
    assert.equal(JSON.parse(result.payload_json).witness.records.length, 482, 'a single full snapshot is stored at completion');
    firstPageCursor = sqlite.prepare("SELECT sequence FROM run_events WHERE run_id=? AND type='witness.delta' ORDER BY sequence LIMIT 1 OFFSET 130").get(runId).sequence;
  } finally { sqlite.close(); }
  const page = await readRunEvents(directory, runId, { afterSequence: firstPageCursor, limit: 3 });
  assert.equal(page.events.length, 3);
  assert(page.events.every(event => event.type === 'witness.updated' && event.witness.records.length > 30 && !event.witnessDelta), 'cursor API still returns the full compatible view');
  assert.equal(page.events[0].witness.records[0].eventType, 'turn.started');
  assert.equal(final.witness.records.filter(record => record.kind === 'tool').length, 320);
  assert.deepEqual((await readRunResult(directory, runId)).witness, final.witness);
  console.log(`Witness SQLite bytes (including final snapshot): ${legacyPayloadBytes} -> ${bytes}, ${(100 - bytes / legacyPayloadBytes * 100).toFixed(1)}% smaller (${witnessRows.count} delta writes).`);

  // Run a real durable operation, terminate the process without a final
  // result, and reopen exactly the same journal from another process.
  const childScript = String.raw`
    import { join } from 'node:path';
    import { writeFile } from 'node:fs/promises';
    import { createHarnessTaskRuntime } from './electron/harness/task-runtime.js';
    import { executeDurableTool, saveRuntimeCheckpoint } from './electron/runtime/durable-run.js';
    import { createWitnessMonitor } from './electron/witness-monitor.js';
    const [dataDirectory, taskId] = process.argv.slice(1);
    const runtime = createHarnessTaskRuntime({ dataDirectory });
    const keepAlive = setInterval(() => {}, 1_000);
    await runtime.start({ runId: 'crashed', taskId, metadata: { workspacePath: dataDirectory }, execute: async ({ emit }) => {
      const monitor = createWitnessMonitor({ emit, heartbeatMs: 0 });
      monitor.observe({ type: 'turn.started' });
      const action = { callId: 'write', tool: 'write_file', path: 'durable.txt' };
      monitor.observe({ type: 'tool.started', ...action });
      await executeDurableTool('write_file', { path: 'durable.txt', content: 'saved' }, async () => {
        await writeFile(join(dataDirectory, 'durable.txt'), 'saved');
        return { path: 'durable.txt' };
      });
      monitor.observe({ type: 'tool.completed', ...action, success: true });
      await saveRuntimeCheckpoint({ scopeId: 'check', phase: 'post-write', path: 'durable.txt' });
      await runtime.readEvents('crashed');
      process.stdout.write('durable-before-crash\n');
      await new Promise(() => {});
    } });
    clearInterval(keepAlive);
  `;
  child = spawn(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', childScript, directory, taskId], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('durable-before-crash\n')) resolve(); });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Exited before durable fixture (${code}): ${errors}`)));
  });
  const timeout = AbortSignal.timeout(15_000);
  await Promise.race([ready, once(timeout, 'abort').then(() => { throw Error(`Crash fixture timed out: ${errors}`); })]);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  await closeRunJournalStore(directory);
  assert.equal(await readRunResult(directory, 'crashed'), null, 'no graceful final result was emitted');
  const snapshot = await readRunWitnessHistory(directory, 'crashed', taskId);
  assert.equal(snapshot.records.find(record => record.path === 'durable.txt')?.status, 'completed');
  const previous = await runtime.recoveryContext('crashed');
  assert.equal(previous.checkpoint.agents.check.phase, 'post-write');
  assert.equal(previous.operations.find(item => item.target === 'durable.txt')?.state, 'confirmed');
  assert.equal(await readFile(join(directory, 'durable.txt'), 'utf8'), 'saved');
  const resumedLive = [];
  await runtime.start({ runId: 'resumed', taskId, metadata: { workspacePath: directory }, recoveryContext: previous,
    execute: async ({ emit }) => {
      const monitor = createWitnessMonitor({ emit, heartbeatMs: 0 });
      try {
        monitor.observe({ type: 'turn.started', continuing: true });
        monitor.observe({ type: 'turn.completed', status: 'completed' });
        return { status: 'completed', witness: monitor.snapshot() };
      } finally { monitor.dispose(); }
    },
    onEvent: event => { if (event.witness) resumedLive.push(event.witness); },
  });
  assert(resumedLive[0]?.records.some(item => item.path === 'durable.txt' && item.status === 'completed'), 'the very first resumed live view includes the last confirmed action');
  assert((await readRunResult(directory, 'resumed')).witness.records.some(item => item.path === 'durable.txt'));
  console.log('PASS Witness codec, real crash and durable tool recovery, paged event compatibility, final snapshot and merged continuation.');
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  await closeRunJournalStore(directory);
  await rm(directory, { recursive: true, force: true });
}
