import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { digest } from '../electron/context-chunks.js';
import { beginRunJournal, saveRunContext, getRunRecoveryContext, closeRunJournalStore, putRunEvidence, readRunEvidence } from '../electron/run-store.js';
import { createHarnessTaskRuntime } from '../electron/harness/task-runtime.js';
import { withDurableRun, saveRuntimeContext } from '../electron/runtime/durable-run.js';
import { createMcpResultStore } from '../electron/mcp-result-store.js';
import { createMcpRuntime } from '../electron/mcp-runtime.js';

const dir = await mkdtemp(join(tmpdir(), 'aporia-storage-v3-'));
let db;
try {
  await beginRunJournal(dir, { runId: 'source', taskId: 'task-a' });
  const big = '中文 recovery '.repeat(1_400_000);
  const value = { conversation: [{ role: 'user', content: big }], original: big, file: { after: big }, revision: 1 };
  await saveRunContext(dir, 'source', 'source', value);
  db = new DatabaseSync(join(dir, 'aporiax-runs.sqlite3'));
  const count = () => db.prepare('SELECT count(*) AS n FROM context_chunks').get().n;
  const first = count();
  assert.ok(first < 20, 'repeated content is deduplicated at 64 KiB boundaries');
  await saveRunContext(dir, 'source', 'source', { ...value, revision: 2 });
  assert.equal(count(), first);
  assert.deepEqual((await getRunRecoveryContext(dir, 'source')).contexts.source, { ...value, revision: 2 });
  const nested = {}; let leaf = nested;
  for (let i = 0; i < 130; i++) leaf = leaf.child = {};
  await assert.rejects(saveRunContext(dir, 'source', 'source', nested), /TOO_DEEP/);
  assert.equal((await getRunRecoveryContext(dir, 'source')).contexts.source.revision, 2, 'failed replacement rolls back');
  const old = Buffer.from(JSON.stringify({ legacy: true }));
  db.prepare("INSERT INTO run_contexts(run_id,scope_id,updated_at,checksum,payload,format) VALUES('source','legacy','now',?,?,'json-gzip')").run(digest(old), gzipSync(old));
  assert.equal((await getRunRecoveryContext(dir, 'source')).contexts.legacy.legacy, true);

  let ref;
  await withDurableRun({ evidenceStore: { put: (text) => putRunEvidence(dir, 'source', text), read: (page) => readRunEvidence(dir, 'source', page) } }, async () => {
    const store = createMcpResultStore(); ref = await store.put('甲'.repeat(22000) + '🙂'.repeat(8) + 'EOF'); await store.close();
  });
  await closeRunJournalStore(dir);
  await beginRunJournal(dir, { runId: 'resume', taskId: 'task-a', recoveryOfRunId: 'source' });
  await withDurableRun({ evidenceStore: { put: (text) => putRunEvidence(dir, 'resume', text), read: (page) => readRunEvidence(dir, 'resume', page) } }, async () => {
    const offline = createMcpRuntime({ servers: [] });
    await offline.discover({ permissionMode: 'read-only' });
    assert.ok(offline.toolDefinitions().some((tool) => tool.function.name === 'mcp_read_result'), 'saved evidence can be read even when original MCP server is offline/removed');
    assert.match((await offline.call('mcp_read_result', { result_id: ref.id })).text, /甲/);
    await offline.close();
  });
  let text = '', offset = 0;
  do { const page = await readRunEvidence(dir, 'resume', { result_id: ref.id, offset, limit: 32000 }); text += page.text; offset = page.nextOffset; } while (offset !== null);
  assert.equal(text, '甲'.repeat(22000) + '🙂'.repeat(8) + 'EOF');
  await beginRunJournal(dir, { runId: 'other', taskId: 'task-b', recoveryOfRunId: 'source' });
  await assert.rejects(readRunEvidence(dir, 'other', { result_id: ref.id }), /Unknown/);
  await assert.rejects(readRunEvidence(dir, 'resume', { result_id: ref.id, offset: 1 }), /UTF-8/);
  const beforeLimit = count();
  db.prepare('UPDATE run_evidence SET bytes=256000000 WHERE id=?').run(ref.id);
  await assert.rejects(putRunEvidence(dir, 'source', 'overflow'), /256 MB per run/);
  assert.equal(count(), beforeLimit, 'storage limit does not leak orphan writes');
  db.prepare('UPDATE run_evidence SET bytes=? WHERE id=?').run(ref.bytes, ref.id);
  db.prepare("UPDATE run_evidence SET manifest='{}' WHERE id=?").run(ref.id);
  await assert.rejects(readRunEvidence(dir, 'resume', { result_id: ref.id }), /CORRUPT/);

  // Fault injection at the real runtime persistence boundary; no filesystem effects.
  const runtime = createHarnessTaskRuntime({ dataDirectory: dir });
  let sideEffects = 0;
  const outcome = await runtime.start({ runId: 'disk-fault', taskId: 'fault', execute: async () => {
    await saveRuntimeContext('disk-fault', { kind: 'main', revision: 1 });
    db.exec("CREATE TRIGGER simulate_disk_full BEFORE INSERT ON run_contexts BEGIN SELECT RAISE(FAIL, 'database or disk is full'); END;");
    await saveRuntimeContext('disk-fault', { kind: 'main', revision: 2 });
    sideEffects++;
    return { status: 'completed' };
  } });
  assert.equal(outcome.status, 'blocked'); assert.equal(sideEffects, 0);
  assert.equal(outcome.persistence.lastSuccessfulContext.scopeId, 'disk-fault');
  assert.equal((await getRunRecoveryContext(dir, 'disk-fault')).contexts['disk-fault'].revision, 1);
  db.exec('DROP TRIGGER simulate_disk_full');
  console.log('Storage: large snapshots, dedupe, rollback, legacy, recovery-chain MCP pages, corruption, disk-full fail-stop: PASS');
} finally { db?.close(); await closeRunJournalStore(dir); await rm(dir, { recursive: true, force: true }); }
