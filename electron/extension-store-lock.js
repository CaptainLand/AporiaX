import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// Cross-process writer serialization; the OS releases the lock after a crash.
// Files remain the public format. Do not steal a live lock based on its age.
export async function withExtensionWriteLock(directory, action) {
  await mkdir(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, ".extensions-writer.sqlite3"));
  let acquired = false;
  try {
    db.exec("PRAGMA busy_timeout = 0");
    const deadline = Date.now() + 5000;
    while (!acquired) {
      try { db.exec("BEGIN IMMEDIATE"); acquired = true; }
      catch (error) {
        if (![5, 6].includes(error.errcode) && !/locked|busy/i.test(error.message)) throw error;
        if (Date.now() >= deadline) throw new Error("Extensions are being updated by another process; retry shortly.");
        await new Promise((done) => setTimeout(done, 25));
      }
    }
    const result = await action();
    db.exec("COMMIT");
    acquired = false;
    return result;
  } finally {
    try { if (acquired) db.exec("ROLLBACK"); }
    finally { db.close(); }
  }
}
