import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { initializeChunkSchema, encodeContext, decodeContext, storeBytes, loadBytes, loadByteRange, digest } from "./context-chunks.js";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isReplaySafeNativeTool } from "./runtime/durable-run.js";

const RUN_STORE_VERSION = 2;
const RUN_ID_PATTERN = /^[a-zA-Z0-9._-]{1,100}$/;
const LEGACY_MIGRATION_KEY = "legacy-jsonl-v1";
const databases = new Map();
const openingDatabases = new Map();
export const RUN_RESULT_MAX_BYTES = 2_000_000;
const RESULT_PRIORITY_FIELDS = ["status", "error", "usage", "cumulativeUsage", "usageHistoryComplete", "content", "summary", "workspace", "risks", "artifacts", "workspaceChanges", "selfCheck", "verification", "persistence", "anchor", "changes", "steps"];
const SECRET_FIELDS = /^(?:api.?key|.*apiKey|password|passphrase|authorization|proxyAuthorization|cookie|setCookie|credentials?|secrets?|clientSecret|accessKey(?:Id)?|secretAccessKey|sessionToken|accessToken|refreshToken|idToken|privateKey|cloudToken|bearerToken|authToken|token)$/i;

// Public task results are data, never live provider/configuration objects. Bound
// traversal before serialization, do not invoke getters/toJSON, and redact
// recognizable credentials while retaining usage token counts and artifacts.
export function sanitizeRunResult(input, { maxBytes = RUN_RESULT_MAX_BYTES } = {}) {
  const byteLimit = Math.max(1024, Math.min(RUN_RESULT_MAX_BYTES, Number(maxBytes) || RUN_RESULT_MAX_BYTES));
  let remaining = byteLimit - 512;
  let nodes = 0, truncated = false, redacted = false;
  const ancestors = new WeakSet();
  const takeString = (source) => {
    let value = source.slice(0, Math.min(source.length, 512_000, Math.max(0, remaining)));
    if (value.length !== source.length) truncated = true;
    value = value.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._~-]{8,}/gi, (_, scheme) => { redacted = true; return `${scheme} [REDACTED]`; })
      .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, () => { redacted = true; return "[REDACTED]"; })
      .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*([=:])\s*(["']?)[^\s"',;}]{4,}/gi,
        (_, key, separator, quote) => { redacted = true; return `${key}${separator}${quote}[REDACTED]`; });
    let encodedBytes = Buffer.byteLength(JSON.stringify(value));
    if (encodedBytes > remaining) {
      let low = 0, high = value.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(JSON.stringify(value.slice(0, mid))) <= remaining) low = mid;
        else high = mid - 1;
      }
      value = value.slice(0, low);
      if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
      encodedBytes = Buffer.byteLength(JSON.stringify(value));
      truncated = true;
    }
    remaining -= encodedBytes;
    return value;
  };
  const visit = (value, depth = 0) => {
    if (remaining < 32 || ++nodes > 40_000 || depth > 24) { truncated = true; return undefined; }
    if (value == null) { remaining -= 4; return null; }
    if (typeof value === "string") return takeString(value);
    if (typeof value === "number") {
      const output = Number.isFinite(value) ? value : null;
      remaining -= String(output).length;
      return output;
    }
    if (typeof value === "boolean") { remaining -= 5; return value; }
    if (typeof value === "bigint") return takeString(String(value));
    if (typeof value !== "object") return undefined;
    if (ancestors.has(value)) { truncated = true; return takeString("[Circular]"); }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) { truncated = true; return takeString("[Binary data omitted]"); }
    if (value instanceof Date) return takeString(Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString());
    if (value instanceof Error) return visit({ name: value.name, message: value.message, ...(value.code ? { code: value.code } : {}) }, depth + 1);
    ancestors.add(value);
    try {
      remaining -= 2;
      const output = Array.isArray(value) ? [] : Object.create(null);
      let keys = Object.keys(value);
      if (depth === 0) keys = [...RESULT_PRIORITY_FIELDS.filter(key => keys.includes(key)), ...keys.filter(key => !RESULT_PRIORITY_FIELDS.includes(key))];
      if (keys.length > 10_000) { keys = keys.slice(0, 10_000); truncated = true; }
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) { truncated = true; continue; }
        if (!("value" in descriptor) || ["__proto__", "constructor", "prototype"].includes(key)) { truncated = true; continue; }
        const keyBytes = Array.isArray(value) ? 1 : Buffer.byteLength(JSON.stringify(key)) + 2;
        if (key.length > 200 || keyBytes + 32 > remaining) { truncated = true; break; }
        remaining -= keyBytes;
        const secret = SECRET_FIELDS.test(key.replace(/[-_\s]/g, ""));
        if (secret) redacted = true;
        const item = visit(secret ? "[REDACTED]" : descriptor.value, depth + 1);
        if (item === undefined) { if (Array.isArray(value)) break; else continue; }
        if (Array.isArray(value)) output.push(item); else output[key] = item;
      }
      return output;
    } catch {
      truncated = true;
      return remaining >= 32 ? takeString("[Unserializable]") : undefined;
    } finally { ancestors.delete(value); }
  };
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : { status: "failed", content: typeof input === "string" ? input : "" };
  const candidate = visit(source);
  const result = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {};
  if (truncated || redacted) result.resultStorage = { version: 1, truncated, redacted, maxBytes: byteLimit };
  return result;
}

function pageInteger(value, fallback, maximum, { allowZero = false } = {}) {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error("Invalid run store pagination.");
  return Math.min(value, maximum);
}

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
    PRAGMA synchronous = FULL;
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
    CREATE TABLE IF NOT EXISTS run_checkpoints (
      run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_operations (
      operation_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      tool TEXT NOT NULL,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_operations_run ON run_operations(run_id);
    CREATE TABLE IF NOT EXISTS run_contexts (
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      scope_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      checksum TEXT NOT NULL,
      payload BLOB NOT NULL,
      PRIMARY KEY (run_id, scope_id)
    );
    CREATE TABLE IF NOT EXISTS user_clarifications (
      scope_key TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_results (
      run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
      completed_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
  initializeChunkSchema(database);
  if (!database.prepare("PRAGMA table_info(run_contexts)").all().some((column) => column.name === "format"))
    database.exec("ALTER TABLE run_contexts ADD COLUMN format TEXT NOT NULL DEFAULT 'json-gzip'");
  database.exec(`CREATE TABLE IF NOT EXISTS run_evidence (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    manifest TEXT NOT NULL, created_at TEXT NOT NULL
  );`);
  if (!database.prepare("PRAGMA table_info(run_evidence)").all().some((column) => column.name === "checksum"))
    database.exec("ALTER TABLE run_evidence ADD COLUMN checksum TEXT NOT NULL DEFAULT ''");
  if (!database.prepare("PRAGMA table_info(run_evidence)").all().some((column) => column.name === "bytes")) {
    database.exec("ALTER TABLE run_evidence ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0");
    for (const row of database.prepare("SELECT id,manifest FROM run_evidence").all())
      database.prepare("UPDATE run_evidence SET bytes=? WHERE id=?").run(JSON.parse(row.manifest).bytes, row.id);
  }
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
  if (openingDatabases.has(directory)) return openingDatabases.get(directory);
  const opening = openDatabase(directory);
  openingDatabases.set(directory, opening);
  try { return await opening; } finally { openingDatabases.delete(directory); }
}

async function openDatabase(directory) {
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
  await Promise.all([...openingDatabases.values()]);
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
  return (await appendRunJournalEvents(dataDirectory, runId, [event]))[0];
}

// Stream events share one durable transaction; effect/checkpoint boundaries flush
// their queue first. FULL synchronous durability remains enabled.
export async function appendRunJournalEvents(dataDirectory, runId, events) {
  if (!events.length) return [];
  const safeRunId = assertRunId(runId);
  const database = await getDatabase(dataDirectory);
  database.exec("BEGIN IMMEDIATE");
  try {
    const records = events.map((event) => insertEvent(database, safeRunId, event));
    const last = records.at(-1);
    database.prepare("UPDATE runs SET updated_at = ?, last_event_type = ? WHERE run_id = ?")
      .run(last.at, asString(last.type || "unknown", 200), safeRunId);
    database.exec("COMMIT");
    return records;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export async function saveRunContext(dataDirectory, runId, scopeId, state) {
  const database = await getDatabase(dataDirectory);
  const parsed = typeof state === "string" ? JSON.parse(state) : state;
  database.exec("BEGIN IMMEDIATE");
  try {
    const bytes = encodeContext(database, parsed);
    if (bytes.length > 16_000_000) throw new Error("RUN_CONTEXT_TOO_LARGE: snapshot manifest exceeds 16 MB.");
    database.prepare("INSERT OR REPLACE INTO run_contexts (run_id, scope_id, updated_at, checksum, payload, format) VALUES (?, ?, ?, ?, ?, 'chunks-v1')")
      .run(assertRunId(runId), String(scopeId), new Date().toISOString(), digest(bytes), gzipSync(bytes, { level: 1 }));
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

function readRunContexts(database, runId) {
  const result = Object.create(null);
  for (const row of database.prepare("SELECT scope_id, checksum, payload, format FROM run_contexts WHERE run_id = ?").all(runId)) {
    const bytes = gunzipSync(row.payload, { maxOutputLength: 16_000_000 });
    if (createHash("sha256").update(bytes).digest("hex") !== row.checksum) throw new Error("RUN_CONTEXT_CORRUPT");
    result[row.scope_id] = row.format === "chunks-v1" ? decodeContext(database, bytes) : JSON.parse(bytes.toString("utf8"));
  }
  return result;
}

export async function putRunEvidence(dataDirectory, runId, text) {
  const database = await getDatabase(dataDirectory);
  const bytes = Buffer.from(text);
  if (bytes.length > 64_000_000) throw new Error("MCP result storage limit exceeded.");
  const id = randomUUID();
  database.exec("BEGIN IMMEDIATE");
  try {
    const used = database.prepare("SELECT COALESCE(SUM(bytes),0) AS total FROM run_evidence WHERE run_id=?").get(assertRunId(runId)).total;
    if (used + bytes.length > 256_000_000) throw new Error("MCP result storage limit exceeded: 256 MB per run.");
    const manifest = JSON.stringify(storeBytes(database, bytes));
    database.prepare("INSERT INTO run_evidence(id, run_id, manifest, created_at, checksum, bytes) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, assertRunId(runId), manifest, new Date().toISOString(), digest(Buffer.from(manifest)), bytes.length);
    database.exec("COMMIT");
    return { id, bytes: bytes.length, format: "json", lifetime: "task recovery chain", readTool: "mcp_read_result" };
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

export async function readRunEvidence(dataDirectory, runId, { result_id, offset = 0, limit = 16000 } = {}) {
  const database = await getDatabase(dataDirectory);
  const row = database.prepare(`WITH RECURSIVE ancestors(id, task_id, depth) AS (
    SELECT run_id, task_id, 0 FROM runs WHERE run_id = ? UNION ALL
    SELECT r.recovery_of_run_id, a.task_id, a.depth + 1 FROM runs r JOIN ancestors a ON r.run_id = a.id
    JOIN runs parent ON parent.run_id = r.recovery_of_run_id AND parent.task_id = a.task_id WHERE a.depth < 100
  ) SELECT e.manifest,e.checksum FROM run_evidence e JOIN ancestors a ON a.id = e.run_id WHERE e.id = ? LIMIT 1`).get(assertRunId(runId), String(result_id || ""));
  if (!row) throw new Error("Unknown or expired MCP result reference for this task.");
  if (row.checksum && digest(Buffer.from(row.manifest)) !== row.checksum) throw new Error("RUN_CONTEXT_CORRUPT");
  const manifest = JSON.parse(row.manifest);
  const total = manifest.bytes;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total || !Number.isSafeInteger(limit) || limit < 4 || limit > 32000) throw new Error("Invalid MCP result page.");
  const end = Math.min(total, offset + limit);
  const bytes = row.checksum ? loadByteRange(database, manifest, offset, end) : loadBytes(database, manifest).subarray(offset, end);
  if (bytes.length && (bytes[0] & 0xc0) === 0x80) throw new Error("Offset must be a UTF-8 boundary.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: end < total });
  const next = offset + Buffer.byteLength(text);
  return { resultId: result_id, text, offset, nextOffset: next < total ? next : null, totalBytes: total, complete: next >= total };
}

export async function saveRunCheckpoint(dataDirectory, runId, checkpoint) {
  const database = await getDatabase(dataDirectory);
  const previous = database.prepare("SELECT payload_json FROM run_checkpoints WHERE run_id = ?").get(assertRunId(runId));
  const snapshot = safeJsonParse(previous?.payload_json, { version: 1, agents: {} });
  snapshot.agents ||= {};
  const scope = String(checkpoint.scopeId || runId);
  snapshot.agents[scope] = { ...snapshot.agents[scope], ...checkpoint, savedAt: new Date().toISOString() };
  if (scope === runId) snapshot.main = snapshot.agents[scope];
  const json = JSON.stringify(snapshot);
  if (Buffer.byteLength(json) > 2_000_000) throw new Error("CHECKPOINT_TOO_LARGE");
  database.prepare("INSERT OR REPLACE INTO run_checkpoints (run_id, updated_at, payload_json) VALUES (?, ?, ?)")
    .run(assertRunId(runId), new Date().toISOString(), json);
}

export async function saveRunOperation(dataDirectory, runId, operation) {
  const database = await getDatabase(dataDirectory);
  database.prepare("INSERT OR REPLACE INTO run_operations (operation_id, run_id, tool, state, updated_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
    .run(operation.operationId, assertRunId(runId), operation.tool, operation.state, new Date().toISOString(), JSON.stringify(operation));
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
  const safeRunId = assertRunId(runId);
  const database = await getDatabase(dataDirectory);
  const now = new Date().toISOString();
  const stored = sanitizeRunResult(result);
  const status = asString(stored.status || "failed", 100);
  stored.status = status;
  // The terminal event, metadata and complete result commit together. A retry
  // cannot replace an earlier result or append a second terminal event.
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = database.prepare("SELECT * FROM runs WHERE run_id = ?").get(safeRunId);
    if (!current) throw new Error(`Unknown run journal: ${safeRunId}`);
    if (!database.prepare("SELECT 1 FROM run_results WHERE run_id = ?").get(safeRunId)) {
      database.prepare("INSERT INTO run_results (run_id, completed_at, payload_json) VALUES (?, ?, ?)")
        .run(safeRunId, now, JSON.stringify(stored));
      insertEvent(database, safeRunId, { type: "run.finished", status, changedFiles: stored.changes?.length || 0, at: now });
      database.prepare("UPDATE runs SET status = ?, updated_at = ?, completed_at = ?, last_event_type = 'run.finished' WHERE run_id = ?")
        .run(status, now, now, safeRunId);
    }
    const metadata = rowToMetadata(database.prepare("SELECT * FROM runs WHERE run_id = ?").get(safeRunId));
    database.exec("COMMIT");
    return metadata;
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

// Public control reads deliberately do not load private recovery contexts or
// perform the unresolved-operation inference used by the recovery UI.
export async function listRunRecords(dataDirectory, { runIds, taskId, status, workspacePath, limit = 100, offset = 0 } = {}) {
  const database = await getDatabase(dataDirectory);
  const conditions = [], values = [];
  if (runIds !== undefined) {
    if (!Array.isArray(runIds) || runIds.length > 500) throw new Error("Invalid run id filter.");
    if (!runIds.length) return [];
    conditions.push(`run_id IN (${runIds.map(() => "?").join(",")})`);
    values.push(...runIds.map(assertRunId));
  }
  for (const [column, value] of [["task_id", taskId], ["workspace_path", workspacePath]]) {
    if (value !== undefined) { conditions.push(`${column} = ?`); values.push(String(value)); }
  }
  if (status !== undefined) {
    const statuses = Array.isArray(status) ? status : [status];
    if (!statuses.length) return [];
    if (statuses.length > 20) throw new Error("Invalid run status filter.");
    conditions.push(`status IN (${statuses.map(() => "?").join(",")})`);
    values.push(...statuses.map(value => asString(value, 100)));
  }
  values.push(pageInteger(limit, 100, 500), pageInteger(offset, 0, 1_000_000, { allowZero: true }));
  return database.prepare(`SELECT * FROM runs ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY started_at DESC, run_id ASC LIMIT ? OFFSET ?`)
    .all(...values).map(rowToMetadata);
}

export async function readRunResult(dataDirectory, runId) {
  const database = await getDatabase(dataDirectory);
  const row = database.prepare("SELECT payload_json FROM run_results WHERE run_id = ?").get(assertRunId(runId));
  return row ? safeJsonParse(row.payload_json) : null;
}

export async function readRunEvents(dataDirectory, runId, { afterSequence = 0, limit = 200, offset = 0 } = {}) {
  const safeRunId = assertRunId(runId);
  const after = pageInteger(afterSequence, 0, Number.MAX_SAFE_INTEGER, { allowZero: true });
  const count = pageInteger(limit, 200, 1000);
  const skip = pageInteger(offset, 0, 1_000_000, { allowZero: true });
  const database = await getDatabase(dataDirectory);
  const rows = database.prepare("SELECT sequence, at, type, payload_json FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ? OFFSET ?")
    .all(safeRunId, after, count + 1, skip);
  const events = [];
  let bytes = 0;
  for (const row of rows.slice(0, count)) {
    const payload = sanitizeRunResult(safeJsonParse(row.payload_json, {}), { maxBytes: 256_000 });
    const event = { ...payload, sequence: Number(row.sequence), runId: safeRunId, at: row.at, type: row.type };
    const size = Buffer.byteLength(JSON.stringify(event));
    if (events.length && bytes + size > RUN_RESULT_MAX_BYTES) break;
    events.push(event);
    bytes += size;
  }
  return { runId: safeRunId, events, nextSequence: events.at(-1)?.sequence || after, hasMore: rows.length > events.length };
}

export async function listRecoverableRuns(dataDirectory) {
  const database = await getDatabase(dataDirectory);
  return database
    .prepare(
      `SELECT * FROM runs
       WHERE (status IN ('running', 'paused') OR
         (status IN ('failed', 'interrupted', 'blocked', 'partial', 'needs_input') AND
           (EXISTS (SELECT 1 FROM run_checkpoints WHERE run_checkpoints.run_id = runs.run_id) OR
            EXISTS (SELECT 1 FROM run_operations WHERE run_operations.run_id = runs.run_id))))
         AND recovered_at IS NULL AND resumed_by_run_id = ''
       ORDER BY started_at ASC`,
    )
    .all()
    .map(rowToMetadata);
}

export async function findConfirmedRunOperation(dataDirectory, runId, fingerprint) {
  const database = await getDatabase(dataDirectory);
  const row = database.prepare(
    "WITH RECURSIVE ancestors(run_id, parent_id, depth) AS (" +
    "SELECT run_id, recovery_of_run_id, 0 FROM runs WHERE run_id = ? UNION ALL " +
    "SELECT r.run_id, r.recovery_of_run_id, a.depth + 1 FROM runs r JOIN ancestors a ON r.run_id = a.parent_id WHERE a.depth < 100) " +
    "SELECT o.payload_json, o.run_id FROM run_operations o JOIN ancestors a ON o.run_id = a.run_id " +
    "WHERE json_extract(o.payload_json, '$.fingerprint') = ? " +
    "AND (a.depth > 0 OR json_extract(o.payload_json, '$.recoveredFrom') IS NOT NULL) " +
    "ORDER BY a.depth ASC, o.updated_at DESC, o.rowid DESC LIMIT 1",
  ).get(assertRunId(runId), fingerprint);
  const operation = row ? safeJsonParse(row.payload_json) : null;
  if (operation?.state !== "confirmed") return null;
  // operation_id is globally unique: never replace an ancestor's audit row.
  return row.run_id === runId ? operation : { ...operation,
    operationId: "replay-" + createHash("sha256").update(runId + ":" + operation.operationId).digest("hex"),
    recoveredFrom: operation.operationId };
}

export async function getRunRecoveryContext(dataDirectory, runId) {
  const safeRunId = assertRunId(runId);
  const database = await getDatabase(dataDirectory);
  const metadata = rowToMetadata(
    database.prepare("SELECT * FROM runs WHERE run_id = ?").get(safeRunId),
  );
  if (!metadata) throw new Error(`Unknown run journal: ${safeRunId}`);
  const checkpointRow = database.prepare("SELECT payload_json, updated_at FROM run_checkpoints WHERE run_id = ?").get(safeRunId);
  const operations = database.prepare("SELECT payload_json FROM run_operations WHERE run_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 80")
    .all(safeRunId).map((row) => safeJsonParse(row.payload_json)).filter(Boolean).reverse()
    .map((operation) => isReplaySafeNativeTool(operation.tool) ? { ...operation, replaySafe: true } : operation);
  const unresolvedOperations = database.prepare("SELECT payload_json FROM run_operations WHERE run_id = ? AND state IN ('started', 'uncertain') ORDER BY updated_at")
    .all(safeRunId).map((row) => safeJsonParse(row.payload_json)).filter((operation) => operation && !isReplaySafeNativeTool(operation.tool));
  if (!checkpointRow && !operations.length) {
    unresolvedOperations.push({ operationId: "legacy-unconfirmed", tool: "legacy-run", state: "uncertain", error: "旧记录缺少持久化操作凭据；继续写入前必须核对已有结果。" });
  }
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
      ...(event.type === "steering.queued" && event.message ? {
        message: { id: asString(event.message.id), role: "user", content: asString(event.message.content, 40_000) },
      } : {}),
      error: event.error ? String(event.error).slice(0, 500) : null,
    }));
  return {
    checkpoint: checkpointRow ? { ...safeJsonParse(checkpointRow.payload_json, {}), savedAt: checkpointRow.updated_at } : null,
    contexts: readRunContexts(database, safeRunId),
    operations,
    unresolvedOperations,
    runId: metadata.runId,
    taskId: metadata.taskId,
    assistantId: metadata.assistantId,
    sourceUserId: metadata.sourceUserId,
    prompt: metadata.prompt,
    workspacePath: metadata.workspacePath,
    providerId: metadata.providerId,
    modelId: metadata.modelId,
    recoveryOfRunId: metadata.recoveryOfRunId,
    status: metadata.status,
    startedAt: metadata.startedAt,
    updatedAt: metadata.updatedAt,
    completedAt: metadata.completedAt || null,
    lastEventType: metadata.lastEventType,
    resumedByRunId: metadata.resumedByRunId || null,
    resumedAt: metadata.resumedAt || null,
    recoveredAt: metadata.recoveredAt || null,
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

// Local-only ledger. CAS prevents concurrent attempts from resetting/exceeding a budget.
export async function readClarificationLedger(dataDirectory, key) {
  const database = await getDatabase(dataDirectory);
  const row = database.prepare("SELECT payload_json FROM user_clarifications WHERE scope_key=?").get(key);
  return row ? JSON.parse(row.payload_json) : null;
}
export async function writeClarificationLedger(dataDirectory, key, state, revision) {
  if (!/^[a-f0-9]{64}$/.test(key) || state.revision !== revision + 1) throw new Error("CLARIFICATION_LEDGER_INVALID");
  const database = await getDatabase(dataDirectory);
  const payload = JSON.stringify(state);
  const result = revision === 0
    ? database.prepare("INSERT OR IGNORE INTO user_clarifications(scope_key,revision,payload_json) VALUES(?,?,?)").run(key, state.revision, payload)
    : database.prepare("UPDATE user_clarifications SET revision=?,payload_json=? WHERE scope_key=? AND revision=?").run(state.revision, payload, key, revision);
  if (Number(result.changes) !== 1) throw new Error("CLARIFICATION_LEDGER_CONFLICT");
}
