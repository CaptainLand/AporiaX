import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRunJournalEvent,
  beginRunJournal,
  closeRunJournalStore,
  finishRunJournal,
  getRunRecoveryContext,
  listRecoverableRuns,
  runJournalStats,
  updateRunJournalMetadata,
} from "../electron/run-store.js";

const root = await mkdtemp(join(tmpdir(), "aporiax-sqlite-store-"));
try {
  const legacyDirectory = join(root, "aporiax-runs");
  await mkdir(legacyDirectory, { recursive: true });
  await writeFile(
    join(legacyDirectory, "legacy.json"),
    JSON.stringify({
      runId: "legacy",
      taskId: "legacy-task",
      status: "paused",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      lastEventType: "control.paused",
    }),
    "utf8",
  );
  await writeFile(
    join(legacyDirectory, "legacy.jsonl"),
    `${JSON.stringify({ type: "run.created", at: "2026-01-01T00:00:00.000Z" })}\n${JSON.stringify({ type: "control.paused", at: "2026-01-01T00:01:00.000Z" })}\n`,
    "utf8",
  );

  const migrated = await listRecoverableRuns(root);
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].runId, "legacy");
  const legacyRecovery = await getRunRecoveryContext(root, "legacy");
  assert.deepEqual(
    legacyRecovery.events.map((event) => event.type),
    ["run.created", "control.paused"],
  );

  await beginRunJournal(root, {
    runId: "run-1",
    taskId: "task-1",
    prompt: "hello",
    workspacePath: "/tmp/workspace",
  });
  await appendRunJournalEvent(root, "run-1", {
    type: "tool.started",
    tool: "read_file",
    path: "src/a.js",
  });
  await updateRunJournalMetadata(root, "run-1", {
    status: "paused",
    lastEventType: "control.paused",
  });

  const recoverable = await listRecoverableRuns(root);
  assert.deepEqual(
    recoverable.map((record) => record.runId),
    ["legacy", "run-1"],
  );
  const context = await getRunRecoveryContext(root, "run-1");
  assert.equal(context.events.at(-1).type, "tool.started");
  assert.equal(context.events.at(-1).path, "src/a.js");

  await finishRunJournal(root, "run-1", {
    status: "completed",
    changes: [{ path: "src/a.js" }],
  });
  assert.deepEqual(
    (await listRecoverableRuns(root)).map((record) => record.runId),
    ["legacy"],
  );

  const stats = await runJournalStats(root);
  assert.equal(stats.version, 2);
  assert.equal(stats.runs, 2);
  assert.equal(stats.events, 5);
  assert.match(stats.databasePath, /aporiax-runs\.sqlite3$/);

  await closeRunJournalStore(root);
  const reopened = await getRunRecoveryContext(root, "run-1");
  assert(reopened.events.some((event) => event.type === "run.finished"));

  console.log("SQLite run event store smoke: PASS");
} finally {
  await closeRunJournalStore(root).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
