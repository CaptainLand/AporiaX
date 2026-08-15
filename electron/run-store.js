import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const RUN_STORE_VERSION = 2;
const RUN_ID_PATTERN = /^[a-zA-Z0-9._-]{1,100}$/;
const LEGACY_MIGRATION_KEY = "legacy-jsonl-v1";
const databases = new Map();

function assertRunId(runId) {
  if (!RUN_ID_PATTERN.test(String(runId || ""))) {
    throw new Error("Invalid run id for the persistent run store.");
  }
  return String(runId);
}

function getRunStoreDirectory(dataDirectory) {
  return join(dataDirectory, "aporiax-runs");
}

function getDatabasePath(dataDirectory) {
  return join(dataDirectory, "aporiax-runs.sqlite3");
}

function asString(value, limit = 0) {
  const output = String(value ?? "");
  return limit > 0 ? output.slice(0, limit) : output;
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function initializeSchema(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS event_store_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT ${RUN_STORE_VERSION},
      task_id TEXT NOT NULL DEFAULT '',
      assistant_id TEXT NOT NULL DEFAULT '',
      source_user_id TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      workspace_path TEXT NOT NULL DEFAULT '',
      provider_id TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL DEFAULT '',
      recovery_of_run_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      last_event_type TEXT NOT NULL DEFAULT '',
      resumed_by_run_id TEXT NOT NULL DEFAULT '',
      resumed_at TEXT,
      recovered_at TEXT
    );

    CREATE TABLE IF NOT EXISTS run_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_run_events_run_sequence
      ON run_events(run_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_runs_status_started
      ON runs(status, started_at);
  `);
}

function insertEvent(database, runId, event, { at = null } = {}) {
  const timestamp = asString(at || event?.at || event?.timestamp || new Date().toISOString());
  const record = {
    at: timestamp,
    runId,
    ...(event && typeof event === "object" ? event : {}),
  };
  const type = asString(record.type || "unknown", 200) || "unknown";
  database
    .prepare(
      `INSERT INTO run_events (run_id, at, type, payload_json)
       VALUES (?, ?, ?, ?)`,
    )
    .run(runId, timestamp, type, JSON.stringify(record));
  return record;
}

function rowToMetadata(row) {
  if (!row) return null;
  return {
    version: Number(row.version) || RUN_STORE_VERSION,
    runId: row.run_id,
    taskId: row.task_id || "",
    assistantId: row.assistant_id || "",
    sourceUserId: row.source_user_id || "",
    prompt: row.prompt || "",
    workspacePath: row.workspace_path || "",
    providerId: row.provider_id || "",
    modelId: row.model_id || "",
    recoveryOfRunId: row.recovery_of_run_id || "",
    status: row.status,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || undefined,
    lastEventType: row.last_event_type || "",
    resumedByRunId: row.resumed_by_run_id || undefined,
    resumedAt: row.resumed_at || undefined,
    recoveredAt: row.recovered_at || undefined,
  };
}

async function migrateLegacyStore(database, dataDirectory) {
  const marker = database
    .prepare("SELECT value FROM event_store_meta WHERE key = ?")
    .get(LEGACY_MIGRATION_KEY);
  if (marker) return;

  const directory = getRunStoreDirectory(dataDirectory);
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  database.exec("BEGIN IMMEDIATE");
  try {
    const existingRun = database.prepare("SELECT 1 FROM runs WHERE run_id = ?");
    const insertRun = database.prepare(`
      INSERT INTO runs (
        run_id, version, task_id, assistant_id, source_user_id, prompt,
        workspace_path, provider_id, model_id, recovery_of_run_id, status,
        started_at, updated_at, completed_at, last_event_type,
        resumed_by_run_id, resumed_at, recovered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const fileName of jsonFiles) {
      const metadataPath = join(directory, fileName);
      const metadata = safeJsonParse(await readFile(metadataPath, "utf8"));
      const rawRunId = metadata?.runId || fileName.replace(/\.json$/i, "");
      let runId;
      try {
        runId = assertRunId(rawRunId);
      } catch {
        continue;
      }
      if (existingRun.get(runId)) continue;
      const startedAt = asString(metadata?.startedAt || new Date().toISOString());
      const updatedAt = asString(metadata?.updatedAt || startedAt);
      insertRun.run(
        runId,
        RUN_STORE_VERSION,
        asString(metadata?.taskId),
        asString(metadata?.assistantId),
        asString(metadata?.sourceUserId),
        asString(metadata?.prompt, 40_000),
        asString(metadata?.workspacePath),
        asString(metadata?.providerId),
        asString(metadata?.modelId),
        asString(metadata?.recoveryOfRunId),
        asString(metadata?.status || "interrupted"),
        startedAt,
        updatedAt,
        metadata?.completedAt ? asString(metadata.completedAt) : null,
        asString(metadata?.lastEventType),
        asString(metadata?.resumedByRunId),
        metadata?.resumedAt ? asString(metadata.resumedAt) : null,
        metadata?.recoveredAt ? asString(metadata.recoveredAt) : null,
      );

      const eventsPath = join(directory, `${runId}.jsonl`);
      try {
        const lines = (await readFile(eventsPath, "utf8"))
          .split(/\r?\n/)
          .filter(Boolean);
        for (const line of lines) {
          const event = safeJsonParse(line);
          if (!event || typeof event !== "object") continue;
          insertEvent(database, runId, event, {
            at: event.at || event.timestamp || startedAt,
          });
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }

    database
      .prepare(
        `INSERT OR REPLACE INTO event_store_meta (key, value, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(LEGACY_MIGRATION_KEY, "complete", new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function getDatabase(dataDirectory) {
  const directory = String(dataDirectory || "").trim();
  if (!directory) throw new Error("A data directory is required for the run store.");
  if (databases.has(directory)) return databases.get(directory);
  await mkdir(directory, { recursive: true });
  const database = new DatabaseSync(getDatabasePath(directory));
  try {
    initializeSchema(database);
    await migrateLegacyStore(database, directory);
  } catch (error) {
    database.close();
    throw error;
  }
  databases.set(directory, database);
  return database;
}

export async function closeRunJournalStore(dataDirectory = null) {
  if (dataDirectory != null) {
    const key = String(dataDirectory || "").trim();
    const database = databases.get(key);
    if (!database) return false;
    databases.delete(key);
    database.close();
    return true;
  }
  for (const database of databases.values()) database.close();
  databases.clear();
  return true;
}

export async function beginRunJournal(dataDirectory, input) {
  const runId = assertRunId(input?.runId);
  const database = await getDatabase(dataDirectory);
  const now = new Date().toISOString();
  const metadata = {
    version: RUN_STORE_VERSION,
    runId,
    taskId: asString(input?.taskId),
    assistantId: asString(input?.assistantId),
    sourceUserId: asString(input?.sourceUserId),
    prompt: asString(input?.prompt, 40_000),
    workspacePath: asString(input?.workspacePath),
    providerId: asString(input?.providerId),
    modelId: asString(input?.modelId),
    recoveryOfRunId: asString(input?.recoveryOfRunId),
    status: "running",
    startedAt: now,
    updatedAt: now,
    lastEventType: "run.created",
  };

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO runs (
          run_id, version, task_id, assistant_id, source_user_id, prompt,
          workspace_path, provider_id, model_id, recovery_of_run_id, status,
          started_at, updated_at, last_event_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        RUN_STORE_VERSION,
        metadata.taskId,
        metadata.assistantId,
        metadata.sourceUserId,
        metadata.prompt,
        metadata.workspacePath,
        metadata.providerId,
        metadata.modelId,
        metadata.recoveryOfRunId,
        metadata.status,
        now,
        now,
        metadata.lastEventType,
      );
    insertEvent(database, runId, {
      type: "run.created",
      taskId: metadata.taskId,
      assistantId: metadata.assistantId,
      sourceUserId: metadata.sourceUserId,
    }, { at: now });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return metadata;
}

export async function appendRunJournalEvent(dataDirectory, runId, event) {
  const safeRunId = assertRunId(runId);
  const database = await getDatabase(dataDirectory);
  const record = insertEvent(database, safeRunId, event);
  database
    .prepare(
      `UPDATE runs SET updated_at = ?, last_event_type = ? WHERE run_id = ?`,
    )
    .run(record.at, asString(record.type || "unknown", 200), safeRunId);
  return record;
}

export async function updateRunJournalMetadata(dataDirectory, runId, patch) {
  const safeRunId = assertRunId(runId);
  const database = await getDatabase(dataDirectory);
  const current = rowToMetadata(
    database.prepare("SELECT * FROM runs WHERE run_id = ?").get(safeRunId),
  );
  if (!current) throw new Error(`Unknown run journal: ${safeRunId}`);
  const next = {
    ...current,
    ...(patch && typeof patch === "object" ? patch : {}),
    version: RUN_STORE_VERSION,
    runId: safeRunId,
    updatedAt: new Date().toISOString(),
  };
  database
    .prepare(
      `UPDATE runs SET
        version = ?, task_id = ?, assistant_id = ?, source_user_id = ?,
        prompt = ?, workspace_path = ?, provider_id = ?, model_id = ?,
        recovery_of_run_id = ?, status = ?, started_at = ?, updated_at = ?,
        completed_at = ?, last_event_type = ?, resumed_by_run_id = ?,
        resumed_at = ?, recovered_at = ?
       WHERE run_id = ?`,
    )
    .run(
      RUN_STORE_VERSION,
      asString(next.taskId),
      asString(next.assistantId),
      asString(next.sourceUserId),
      asString(next.prompt, 40_000),
      asString(next.workspacePath),
      asString(next.providerId),
      asString(next.modelId),
      asString(next.recoveryOfRunId),
      asString(next.status || "running"),
      asString(next.startedAt || current.startedAt),
      next.updatedAt,
      next.completedAt ? asString(next.completedAt) : null,
      asString(next.lastEventType),
      asString(next.resumedByRunId),
      next.resumedAt ? asString(next.resumedAt) : null,
      next.recoveredAt ? asString(next.recoveredAt) : null,
      safeRunId,
    );
  return next;
}

export async function finishRunJournal(dataDirectory, runId, result) {
  const now = new Date().toISOString();
  await appendRunJournalEvent(dataDirectory, runId, {
    type: "run.finished",
    status: result?.status || "failed",
    changedFiles: result?.changes?.length || 0,
    at: now,
  });
  return updateRunJournalMetadata(dataDirectory, runId, {
    status: result?.status || "failed",
    completedAt: now,
    lastEventType: "run.finished",
  });
}

export async function listRecoverableRuns(dataDirectory) {
  const database = await getDatabase(dataDirectory);
  return database
    .prepare(
      `SELECT * FROM runs
       WHERE status IN ('running', 'paused')
       ORDER BY started_at ASC`,
    )
    .all()
    .map(rowToMetadata);
}

export async function getRunRecoveryContext(dataDirectory, runId) {
  const safeRunId = assertRunId(runId);
  const database = await getDatabase(dataDirectory);
  const metadata = rowToMetadata(
    database.prepare("SELECT * FROM runs WHERE run_id = ?").get(safeRunId),
  );
  if (!metadata) throw new Error(`Unknown run journal: ${safeRunId}`);
  const events = database
    .prepare(
      `SELECT at, type, payload_json FROM (
         SELECT sequence, at, type, payload_json
         FROM run_events
         WHERE run_id = ?
         ORDER BY sequence DESC
         LIMIT 120
       ) ORDER BY sequence ASC`,
    )
    .all(safeRunId)
    .map((row) => safeJsonParse(row.payload_json, { at: row.at, type: row.type }))
    .filter(Boolean)
    .map((event) => ({
      at: event.at || event.timestamp || null,
      type: event.type || "unknown",
      tool: event.tool || null,
      path: event.path || null,
      command: event.command || null,
      status: event.status || null,
      title: event.title || null,
      detail: event.detail || null,
      error: event.error ? String(event.error).slice(0, 500) : null,
    }));
  return {
    runId: metadata.runId,
    taskId: metadata.taskId,
    sourceUserId: metadata.sourceUserId,
    prompt: metadata.prompt,
    workspacePath: metadata.workspacePath,
    startedAt: metadata.startedAt,
    lastEventType: metadata.lastEventType,
    events,
  };
}

export async function markRunRecoveryStarted(dataDirectory, runId, resumedByRunId) {
  await appendRunJournalEvent(dataDirectory, runId, {
    type: "run.recovery_started",
    resumedByRunId,
  });
  return updateRunJournalMetadata(dataDirectory, runId, {
    status: "interrupted",
    resumedByRunId: asString(resumedByRunId),
    resumedAt: new Date().toISOString(),
    lastEventType: "run.recovery_started",
  });
}

export async function acknowledgeRecoverableRun(dataDirectory, runId) {
  await appendRunJournalEvent(dataDirectory, runId, {
    type: "run.recovery_acknowledged",
  });
  return updateRunJournalMetadata(dataDirectory, runId, {
    status: "interrupted",
    recoveredAt: new Date().toISOString(),
    lastEventType: "run.recovery_acknowledged",
  });
}

export async function runJournalStats(dataDirectory) {
  const database = await getDatabase(dataDirectory);
  const runCount = Number(database.prepare("SELECT COUNT(*) AS count FROM runs").get()?.count || 0);
  const eventCount = Number(database.prepare("SELECT COUNT(*) AS count FROM run_events").get()?.count || 0);
  return {
    version: RUN_STORE_VERSION,
    databasePath: getDatabasePath(dataDirectory),
    runs: runCount,
    events: eventCount,
  };
}
