import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createTaskHistoryStore } from "../electron/task-history-store.js";
import { createTaskCheckpointWriter } from "../src/state/task-checkpoint-writer.js";
import { serializeDesktopTaskPreview } from "../src/state/task-store-core.js";

function clock() {
  const timers = new Map();
  let id = 0, t = 0;
  return {
    schedule: (callback, delay) => { timers.set(++id, { callback, delay }); return id; },
    cancel: key => timers.delete(key),
    now: () => t,
    get nextDelay() { return timers.values().next().value?.delay; },
    async tick() {
      const [key, { callback, delay }] = timers.entries().next().value;
      timers.delete(key);
      t += delay;
      callback();
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}
const ack = ({ tasks, deletedTaskIds }) => ({
  ok: true, saved: tasks.map(task => task.id), failed: [], deleted: deletedTaskIds,
});
const old = { id: "old", messages: [{ id: "old-user", role: "user", content: "old history" }] };
const task = { id: "active", messages: [] };

{
  const timer = clock();
  const writes = [];
  const resolveWrites = [];
  const writer = createTaskCheckpointWriter({
    baseline: [task, old], ...timer,
    save: patch => new Promise(resolve => { writes.push(patch); resolveWrites.push(() => resolve(ack(patch))); }),
  });
  writer.update([task, old]); await timer.tick();
  assert.equal(writes.length, 0, "hydration with the same records does not touch disk");
  let latest = { ...task, title: "first" };
  writer.update([latest, old]); await timer.tick();
  for (let i = 0; i < 320; i++) {
    latest = { ...task, title: `latest-${i}` };
    writer.update([latest, old]);
  }
  assert.equal(writes.length, 1, "streaming never queues a backlog behind an in-flight write");
  writer.remove("old");
  writer.update([latest]);
  resolveWrites.shift()();
  await new Promise(resolve => setImmediate(resolve));
  await timer.tick();
  assert.deepEqual(writes, [
    { tasks: [{ ...task, title: "first" }], deletedTaskIds: [] },
    { tasks: [latest], deletedTaskIds: ["old"] },
  ]);
  resolveWrites.shift()();
  await new Promise(resolve => setImmediate(resolve));
  writer.update([latest]); await timer.tick();
  assert.equal(writes.length, 2, "acknowledged references do not rewrite task or index");
  writer.dispose();
}

{
  const timer = clock();
  let attempts = 0;
  const errors = [];
  const writer = createTaskCheckpointWriter({
    baseline: [task], ...timer,
    save: async () => { attempts++; throw new Error("disk is busy"); },
    onError: error => errors.push(error),
  });
  writer.update([{ ...task, title: "dirty" }]);
  for (const expected of [350, 1_000, 3_000]) {
    assert.equal(timer.nextDelay, expected);
    await timer.tick();
  }
  assert.equal(timer.nextDelay, undefined);
  assert.equal(attempts, 3);
  assert.equal(errors.length, 1);
  writer.update([{ ...task, title: "newer" }]);
  assert.equal(timer.nextDelay, 30_000, "sustained failure cannot keep the writer in a hot loop");
  writer.dispose();
}

{
  const timer = clock();
  let attempts = 0;
  const errors = [];
  const writer = createTaskCheckpointWriter({
    baseline: [task], ...timer,
    save: async () => { attempts++; throw new Error("TASK_STORE_REVISION_CONFLICT"); },
    onError: error => errors.push(error),
  });
  writer.update([{ ...task, title: "stale" }]); await timer.tick();
  writer.update([{ ...task, title: "still stale" }]);
  assert.equal(timer.nextDelay, undefined);
  assert.equal(attempts, 1, "stale saves never retry destructively");
  assert.equal(errors.length, 1);
}

const tmp = resolve(tmpdir());
const dir = await mkdtemp(join(tmp, "aporiax-checkpoint-writer-"));
try {
  const store = createTaskHistoryStore(dir, { maxTaskJsonBytes: 2048 });
  await store.saveTasks([task, old, { id: "unseen", messages: [] }]);
  const initial = await store.loadSnapshot();
  const oldPath = join(store.root, "tasks", "old.json");
  const before = await readFile(oldPath, "utf8");
  const oldMtime = (await stat(oldPath)).mtimeMs;
  let revision = initial.revision;
  const calls = [];
  const timer = clock();
  let inFlight;
  const writer = createTaskCheckpointWriter({
    baseline: initial.tasks, ...timer,
    save: patch => {
      calls.push(patch);
      inFlight = store.saveTasks(patch.tasks, { expectedRevision: revision, deletedTaskIds: patch.deletedTaskIds })
        .then(result => { revision = result.revision; return result; });
      return inFlight;
    },
  });
  const active = initial.tasks.find(item => item.id === "active");
  const oversized = { id: "oversized", messages: [{ content: "x".repeat(3_000) }] };
  const changed = { ...active, messages: [{ id: "newest", role: "assistant", content: "finished" }] };
  writer.remove("unseen");
  writer.update([changed, oversized]); // Missing "old" is NOT a deletion.
  await timer.tick(); await inFlight;
  await timer.tick(); await inFlight;
  assert.deepEqual(calls, [
    { tasks: [changed, oversized], deletedTaskIds: ["unseen"] },
    { tasks: [], deletedTaskIds: ["unseen"] },
  ], "a permanent failure does not repeat the same write or block an unrelated deletion");
  assert.equal(await readFile(oldPath, "utf8"), before);
  assert.equal((await stat(oldPath)).mtimeMs, oldMtime, "untouched task file was never rewritten");
  const persisted = await createTaskHistoryStore(dir).loadTasks();
  assert.deepEqual(persisted.map(item => item.id), ["active", "old"]);
  assert.equal(persisted[0].messages[0].content, "finished");
  assert.match(await readFile(join(store.root, "deleted", `unseen.${revision}.json`), "utf8"), /"id":"unseen"/);

  // Repair a transient partial failure: only the unacknowledged version resends.
  const retryClock = clock();
  const proposals = [];
  const retry = createTaskCheckpointWriter({
    baseline: persisted, ...retryClock,
    save: async patch => {
      proposals.push(patch.tasks.map(item => item.id));
      return proposals.length === 1
        ? { ok: false, saved: ["active"], deleted: [], failed: [{ id: "old", code: "EBUSY" }] }
        : ack(patch);
    },
  });
  retry.update(persisted.map(item => ({ ...item, title: "renamed" })));
  await retryClock.tick(); await retryClock.tick();
  assert.deepEqual(proposals, [["active", "old"], ["old"]]);
} finally {
  if (dirname(dir) === tmp && basename(dir).startsWith("aporiax-checkpoint-writer-")) {
    await rm(dir, { recursive: true, force: true });
  }
}

const nested = { witness: { records: [{ content: "private-find" }] }, attachments: [{ dataUrl: "large-attachment" }], changes: [{ content: "full-diff" }] };
const previewSource = Array.from({ length: 80 }, (_, i) => ({
  id: `task-${i}`, messages: Array.from({ length: 40 }, (_, n) => ({
    id: `message-${n}`, role: "assistant", content: "示".repeat(20_000), ...nested,
  })),
}));
const preview = serializeDesktopTaskPreview(previewSource);
assert.equal(JSON.parse(preview).length, 16);
assert.equal(JSON.parse(preview)[0].messages[0].id, "message-30");
assert.ok(Buffer.byteLength(preview) < 520_000);
assert.doesNotMatch(preview, /private-find|large-attachment|full-diff/);
console.log("PASS incremental checkpoints: coalescing, bounded retries, explicit deletion, restart and bounded read-only preview.");
