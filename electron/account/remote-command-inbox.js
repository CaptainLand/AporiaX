import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
export const remoteOwnerKey = (api, userId, deviceId) => {
  if (!userId || !deviceId) throw new Error('REMOTE_IDENTITY_REQUIRED');
  return createHash('sha256').update(JSON.stringify([api, userId, deviceId])).digest('hex');
};

// A durable inbox/outbox, not an exactly-once claim about external side effects.
// A crash between execution and receipt persistence is explicitly uncertain.
export function createRemoteCommandInbox(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS remote_inbox (
      owner TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, command TEXT NOT NULL,
      state TEXT NOT NULL, claim TEXT, status TEXT, result TEXT, updated INTEGER NOT NULL,
      PRIMARY KEY(owner,id));`);
  if (!db.prepare('PRAGMA table_info(remote_inbox)').all().some((column) => column.name === 'consumer'))
    db.exec('ALTER TABLE remote_inbox ADD COLUMN consumer TEXT');
  db.prepare(`UPDATE remote_inbox SET state='result', status='failed',
    result='REMOTE_RESULT_UNCERTAIN: Desktop restarted before saving the execution receipt. The operation may have happened; it was not replayed. Check the task or file before submitting a new command.', updated=?
    WHERE state='executing'`).run(Date.now());
  const row = (owner, id) => db.prepare('SELECT * FROM remote_inbox WHERE owner=? AND id=?').get(owner, id);
  return {
    ingest(owner, commands) {
      for (const command of commands) {
        if (typeof command?.id !== 'string' || !command.id || command.id.length > 200) throw new Error('REMOTE_COMMAND_INVALID');
        const body = JSON.stringify(stable({ id: command.id, type: command.type, localTaskId: command.localTaskId, payload: command.payload }));
        if (Buffer.byteLength(body) > 1_000_000) throw new Error('REMOTE_COMMAND_TOO_LARGE');
        const fingerprint = createHash('sha256').update(body).digest('hex');
        const existing = row(owner, command.id);
        if (existing && existing.fingerprint !== fingerprint) throw new Error('REMOTE_COMMAND_CONTENT_CHANGED');
        db.prepare(`INSERT OR IGNORE INTO remote_inbox(owner,id,fingerprint,command,state,updated) VALUES(?,?,?,?,'pending',?)`)
          .run(owner, command.id, fingerprint, body, Date.now());
      }
    },
    pending(owner) {
      return db.prepare("SELECT command FROM remote_inbox WHERE owner=? AND state='pending' ORDER BY updated LIMIT 20")
        .all(owner).map((item) => JSON.parse(item.command));
    },
    claim(owner, id, consumer = 'main') {
      const claim = randomUUID();
      const changed = db.prepare("UPDATE remote_inbox SET state='executing',claim=?,consumer=?,updated=? WHERE owner=? AND id=? AND state='pending'")
        .run(claim, String(consumer), Date.now(), owner, id).changes;
      return changed ? { ...JSON.parse(row(owner, id).command), claim } : null;
    },
    executing(owner, id, claim) {
      const item = row(owner, id);
      if (!item || item.state !== 'executing' || item.claim !== claim) throw new Error('REMOTE_CLAIM_INVALID');
      return JSON.parse(item.command);
    },
    complete(owner, id, claim, status, result) {
      if (!['accepted', 'completed', 'failed'].includes(status) || typeof result !== 'string' || result.length > 1_000_000) throw new Error('REMOTE_RECEIPT_INVALID');
      const item = row(owner, id);
      if (!item || item.claim !== claim) throw new Error('REMOTE_CLAIM_INVALID');
      if (item.state === 'result' || item.state === 'acked') return; // Never turn an ACK outage into a different business result.
      if (item.state !== 'executing') throw new Error('REMOTE_STATE_INVALID');
      db.prepare("UPDATE remote_inbox SET state='result',status=?,result=?,updated=? WHERE owner=? AND id=?")
        .run(status, result, Date.now(), owner, id);
    },
    receipts(owner) { return db.prepare("SELECT id,status,result FROM remote_inbox WHERE owner=? AND state='result' ORDER BY updated LIMIT 20").all(owner); },
    abandon(consumer) {
      db.prepare(`UPDATE remote_inbox SET state='result',status='failed',
        result='REMOTE_RESULT_UNCERTAIN: Desktop view closed before saving the receipt. The operation may have happened; it was not replayed. Inspect the task before submitting a new command.',updated=?
        WHERE state='executing' AND consumer=?`).run(Date.now(), String(consumer));
    },
    acknowledge(owner, id) { db.prepare("UPDATE remote_inbox SET state='acked',updated=? WHERE owner=? AND id=? AND state='result'").run(Date.now(), owner, id); },
    close() { db.close(); },
  };
}
