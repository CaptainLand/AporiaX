import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { privateDirectory, protectPrivatePath } from "./credentials.js";

const parse = value => value ? JSON.parse(value) : null;
export async function createControlStore(directory) {
  await privateDirectory(directory);
  const path = join(directory, "control.sqlite3");
  const database = new DatabaseSync(path);
  try {
  await protectPrivatePath(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL, result TEXT,
      UNIQUE(client_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS runs_client ON runs(client_id,created_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
      at TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq);
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), value TEXT NOT NULL
    );
  `);
  } catch (error) { database.close(); throw error; }
  const byId = (table, id) => parse(database.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id)?.value);
  const list = table => database.prepare(`SELECT value FROM ${table}`).all().map(row => parse(row.value));
  return {
    directory,
    setting(id, fallback) { const value = database.prepare("SELECT value FROM settings WHERE id=?").get(id); return value ? parse(value.value) : fallback; },
    setSetting(id, value) { database.prepare("INSERT INTO settings VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(id, JSON.stringify(value)); },
    clients: () => list("clients"), client: id => byId("clients", id),
    clientForToken(hash) { return parse(database.prepare("SELECT value FROM clients WHERE token_hash=?").get(hash)?.value); },
    putClient(client, hash) {
      if (hash) database.prepare("INSERT INTO clients VALUES (?,?,?)").run(client.id, hash, JSON.stringify(client));
      else database.prepare("UPDATE clients SET value=? WHERE id=?").run(JSON.stringify(client), client.id);
      return client;
    },
    workspaces: () => list("workspaces"), workspace: id => byId("workspaces", id),
    putWorkspace(workspace) { database.prepare("INSERT INTO workspaces VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,value=excluded.value").run(workspace.id, workspace.path, JSON.stringify(workspace)); return workspace; },
    removeWorkspace(id) { database.prepare("DELETE FROM workspaces WHERE id=?").run(id); },
    run: id => byId("runs", id),
    findRun(clientId, key) { const row = database.prepare("SELECT value,request_hash FROM runs WHERE client_id=? AND idempotency_key=?").get(clientId, key); return row ? { run: parse(row.value), hash: row.request_hash } : null; },
    runs({ clientId = "", limit = 100, before = "" } = {}) {
      // The immutable rowid cursor avoids page gaps if a run's status changes.
      const clauses = [], args = [];
      if (clientId) { clauses.push("client_id=?"); args.push(clientId); }
      if (before) { clauses.push("rowid < COALESCE((SELECT rowid FROM runs WHERE id=?),0)"); args.push(before); }
      args.push(limit);
      return database.prepare(`SELECT value FROM runs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY rowid DESC LIMIT ?`).all(...args).map(row => parse(row.value));
    },
    unfinished() { return database.prepare("SELECT value FROM runs WHERE status IN ('queued','starting','running','paused','waiting_question','waiting_approval','cancelling') ORDER BY rowid").all().map(row => parse(row.value)); },
    insertRun(run, key, hash) {
      database.prepare("INSERT INTO runs(id,client_id,idempotency_key,request_hash,status,created_at,value) VALUES (?,?,?,?,?,?,?)")
        .run(run.runId, run.clientId, key, hash, run.status, run.createdAt, JSON.stringify(run));
      return run;
    },
    updateRun(run) { database.prepare("UPDATE runs SET value=?,status=? WHERE id=?").run(JSON.stringify(run), run.status, run.runId); return run; },
    result(id) { return parse(database.prepare("SELECT result FROM runs WHERE id=?").get(id)?.result); },
    completeRun(run, result, artifacts = []) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare("DELETE FROM artifacts WHERE run_id=?").run(run.runId);
        const putArtifact = database.prepare("INSERT INTO artifacts VALUES (?,?,?)");
        for (const artifact of artifacts) {
          if (artifact.runId !== run.runId) throw new Error("Completion artifact belongs to a different run.");
          putArtifact.run(artifact.id, artifact.runId, JSON.stringify(artifact));
        }
        database.prepare("UPDATE runs SET value=?,status=?,result=? WHERE id=?").run(JSON.stringify(run), run.status, JSON.stringify(result), run.runId);
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
    event(runId, type, payload = {}) {
      const at = new Date().toISOString();
      const row = database.prepare("INSERT INTO events(run_id,at,type,payload) VALUES (?,?,?,?)").run(runId, at, type, JSON.stringify(payload));
      return { seq: Number(row.lastInsertRowid), at, type, payload };
    },
    events(runId, { afterSeq = 0, limit = 200 } = {}) {
      const rows = database.prepare("SELECT seq,at,type,payload FROM events WHERE run_id=? AND seq>? ORDER BY seq ASC LIMIT ?").all(runId, afterSeq, limit + 1);
      const events = rows.slice(0, limit).map(row => ({ seq: row.seq, at: row.at, type: row.type, payload: parse(row.payload) }));
      return { runId, events, nextSeq: events.at(-1)?.seq ?? afterSeq, hasMore: rows.length > limit };
    },
    latestEvent(runId, type) { const row = database.prepare("SELECT payload FROM events WHERE run_id=? AND type=? ORDER BY seq DESC LIMIT 1").get(runId, type); return row ? parse(row.payload) : null; },
    putArtifact(artifact) { database.prepare("INSERT OR REPLACE INTO artifacts VALUES (?,?,?)").run(artifact.id, artifact.runId, JSON.stringify(artifact)); return artifact; },
    artifact: id => byId("artifacts", id),
    artifacts(runId) { return database.prepare("SELECT value FROM artifacts WHERE run_id=? ORDER BY rowid").all(runId).map(row => parse(row.value)); },
    close() { database.close(); },
  };
}
