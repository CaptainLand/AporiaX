import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessTaskRuntime } from '../electron/harness/task-runtime.js';
import { createWitnessMonitor } from '../electron/witness-monitor.js';
import { beginRunJournal, appendRunJournalEvent, closeRunJournalStore, readRunEvents, readRunResult, readRunWitnessHistory } from '../electron/run-store.js';
import { collectTaskRouteRuns } from '../src/p0-model.js';
import { routeActivityRecords } from '../src/conversation/route-activity-model.js';
import { taskAttemptWitness } from '../src/state/task-witness.js';

const directory = await mkdtemp(join(tmpdir(), 'aporia-witness-continuation-'));
const runtime = createHarnessTaskRuntime({ dataDirectory: directory });
const taskId = 'task';
const workflow = async (runId, tool, parent = null) => {
  const live = [];
  const result = await runtime.start({ runId, taskId, metadata: { sourceUserId: 'user' },
    recoveryContext: parent ? await runtime.recoveryContext(parent) : null,
    onEvent: event => { if (event.witness) live.push(event.witness); },
    execute: async ({ emit }) => {
      const monitor = createWitnessMonitor({ emit });
      try {
        monitor.observe({ type: 'turn.started', continuing: Boolean(parent) });
        monitor.observe({ type: 'tool.started', callId: 'reused-provider-call-id', tool });
        monitor.observe({ type: 'tool.completed', callId: 'reused-provider-call-id', tool, success: true });
        monitor.observe({ type: 'turn.completed', status: 'partial' });
        return { status: 'partial', witness: monitor.snapshot() };
      } finally { monitor.dispose(); }
    },
  });
  return { result, live };
};
const actions = witness => witness.records.filter(item => item.kind === 'tool').map(item => item.tool);
try {
  const original = await workflow('original', 'write_file');
  const retry = await workflow('retry', 'browser_open', 'original');
  const next = await workflow('again', 'browser_screenshot', 'retry');
  assert.deepEqual(actions(original.result.witness), ['write_file']);
  assert.deepEqual(actions(retry.live[0]), ['write_file'], 'history is present from the first live update');
  assert.equal(retry.live[0].current.eventType, 'turn.continued');
  assert.deepEqual(actions(retry.result.witness), ['write_file', 'browser_open']);
  assert.deepEqual(actions(next.result.witness), ['write_file', 'browser_open', 'browser_screenshot']);
  assert.equal(new Set(next.result.witness.records.map(item => item.id)).size, next.result.witness.records.length);
  assert.deepEqual(actions((await readRunResult(directory, 'again')).witness), actions(next.result.witness), 'finished timeline reloads from the durable lineage');
  assert.deepEqual(actions((await readRunResult(directory, 'original')).witness), ['write_file'], 'original audit is unchanged');
  const rawEvent = (await readRunEvents(directory, 'retry')).events.filter(event => event.witness).at(-1);
  assert.deepEqual(actions(rawEvent.witness), ['browser_open'], 'live stitching does not copy old snapshots into the new journal');
  assert.equal(await readRunWitnessHistory(directory, 'original', 'different-task'), null);

  await beginRunJournal(directory, { runId: 'interrupted', taskId });
  await appendRunJournalEvent(directory, 'interrupted', { type: 'witness.updated', witness: original.result.witness });
  assert.deepEqual(actions((await workflow('after-interruption', 'read_file', 'interrupted')).live[0]), ['write_file'], 'also recover the last heartbeat of an interrupted attempt without a final result');

  const note = { id: 'user', role: 'user', content: 'Continue calculator work' };
  const first = { role: 'assistant', id: 'a', runId: 'original', sourceUserId: 'user', witness: original.result.witness, supersededByRetryId: 'b' };
  const second = { role: 'assistant', id: 'b', runId: 'retry', sourceUserId: 'user', recoveryOfRunId: 'original', witness: rawEvent.witness };
  const unrelated = { role: 'assistant', id: 'c', runId: 'unrelated', sourceUserId: 'different-user', witness: original.result.witness };
  const task = { messages: [note, first, second, unrelated] };
  assert.deepEqual(actions(taskAttemptWitness(task.messages, { ...second, witness: null, status: 'running' })), ['write_file'], 'no empty Witness before the first backend event');
  assert.deepEqual(actions(taskAttemptWitness(task.messages, { ...second, witness: retry.result.witness })), ['write_file', 'browser_open'], 'do not stitch the durable timeline twice');
  const runs = collectTaskRouteRuns(task);
  assert.deepEqual(runs.map(run => run.runId), ['retry', 'unrelated'], 'a retry is the same visible round');
  assert.deepEqual(routeActivityRecords(runs[0]).filter(item => item.kind === 'tool').map(item => item.tool), ['write_file', 'browser_open']);
  console.log('PASS Witness: seamless live history, repeated continuation, result reload, crash heartbeat fallback, lineage isolation, one visible task round.');
} finally {
  await closeRunJournalStore(directory);
  await rm(directory, { recursive: true, force: true });
}
