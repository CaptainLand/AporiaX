import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createTaskHistoryStore } from '../electron/task-history-store.js';

const root = await mkdtemp(join(tmpdir(), 'aporiax-migration-index-'));
const task = (id, content) => ({ id, messages: [{ role: 'user', content }] });
try {
  const source = join(root, 'aporiax-tasks.json');
  await writeFile(source, JSON.stringify([task('small', 'original'), task('large', 'x'.repeat(500))]));
  const partial = createTaskHistoryStore(root, { maxTaskJsonBytes: 256 });
  assert.deepEqual((await partial.loadTasks()).map(t => t.id), ['small']);
  // Crash boundary: a task replacement exists, but its index/marker update did not commit.
  await writeFile(join(root, 'aporiax-store/tasks/large.json'), JSON.stringify(task('large', 'newer committed bytes')));
  const recovered = createTaskHistoryStore(root);
  const tasks = await recovered.loadTasks();
  assert.deepEqual(tasks.map(t => t.id).sort(), ['large', 'small']);
  assert.equal(tasks.find(t => t.id === 'large').messages[0].content, 'newer committed bytes');
  assert.equal(JSON.parse(await readFile(join(root, 'aporiax-store/migration.json'), 'utf8')).status, 'completed');
  assert.equal(JSON.parse(await readFile(source + '.migrated', 'utf8')).length, 2);
  assert.deepEqual((await createTaskHistoryStore(root).loadTasks()).map(t => t.id).sort(), ['large', 'small']);
  console.log('Migration crash boundary: committed orphan record adopted without overwriting newer bytes: PASS');
} finally {
  assert(basename(root).startsWith('aporiax-migration-index-'));
  await rm(root, { recursive: true, force: true });
}
