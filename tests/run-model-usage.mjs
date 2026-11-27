import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { appendRunJournalEvent, beginRunJournal, closeRunJournalStore, readRunModelUsage } from '../electron/run-store.js';

const base = resolve(tmpdir());
const dir = await mkdtemp(join(base, 'aporia-model-usage-'));
try {
  await beginRunJournal(dir, { runId: 'foreign', taskId: 'other-task' });
  await beginRunJournal(dir, { runId: 'first', taskId: 'task', recoveryOfRunId: 'foreign' });
  await beginRunJournal(dir, { runId: 'latest', taskId: 'task', recoveryOfRunId: 'first' });
  await appendRunJournalEvent(dir, 'foreign', { type: 'response.attempt.completed', usage: { prompt_tokens: 999, completion_tokens: 100 } });
  await appendRunJournalEvent(dir, 'first', { type: 'response.attempt.completed', status: 'completed', attempt: 1,
    detail: 'INTERNAL_DETAIL', usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 75 } } });
  await appendRunJournalEvent(dir, 'first', { type: 'context.usage', usage: { prompt_tokens: 100, completion_tokens: 20 } });
  await appendRunJournalEvent(dir, 'latest', { type: 'subagent.response.attempt.completed', status: 'failed', attempt: 2, usage: null });
  await appendRunJournalEvent(dir, 'latest', { type: 'response.attempt.completed', status: 'completed', usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 50, cache_creation_input_tokens: 15 } });
  await appendRunJournalEvent(dir, 'latest', { type: 'response.attempt.completed', status: 'failed', usage: {} });
  await appendRunJournalEvent(dir, 'latest', { type: 'response.attempt.completed', status: 'failed', usage: { output_tokens: 4 } });

  const first = await readRunModelUsage(dir, 'latest', { taskId: 'task', limit: 2 });
  assert.equal(first.entries.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.entries[0].inherited, true);
  assert.equal(first.entries[0].usage.prompt_cache_hit_tokens, 75);
  assert.equal(first.entries[0].usage.prompt_cache_miss_tokens, 25);
  assert.equal(first.entries[1].actor, 'subagent');
  assert.equal(first.entries[1].attempt, 2);
  assert.equal(first.entries[1].status, 'failed');
  assert.equal(first.entries[1].usage, null);
  assert(!JSON.stringify(first).includes('INTERNAL_DETAIL'));

  const rest = await readRunModelUsage(dir, 'latest', { taskId: 'task', afterSequence: first.nextSequence });
  assert.equal(rest.hasMore, false);
  assert.equal(rest.entries.length, 3);
  assert.equal(rest.entries[0].usage.prompt_tokens, 70);
  assert.equal(rest.entries[0].usage.completion_tokens, 0);
  assert.equal(rest.entries[1].usage, null);
  assert.equal(rest.entries[2].usage.prompt_tokens, null);
  assert.equal(rest.entries[2].usage.completion_tokens, 4);
  assert.deepEqual((await readRunModelUsage(dir, 'latest', { taskId: 'other-task' })).entries, []);
  console.log('PASS model usage journal: same-task lineage, paging, attempts without double counting, missing counters, numeric-only projection.');
} finally {
  await closeRunJournalStore(dir);
  assert.equal(dirname(dir), base);
  await rm(dir, { recursive: true, force: true });
}
