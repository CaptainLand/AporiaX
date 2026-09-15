import { DatabaseSync } from "node:sqlite";
import { stat } from "node:fs/promises";

// SQLite uses process-owned OS locks, released even after an abrupt crash.
// JSON remains the data format. The transaction only serializes its writers;
// no timeout/mtime heuristic is allowed to steal an active writer's lock.
export async function withUnderstandingWriteLock(filePath, action, { timeoutMs = 5000 } = {}) {
  const database = new DatabaseSync(`${filePath}.writer.sqlite3`);
  let acquired = false;
  try {
    database.exec("PRAGMA busy_timeout = 0");
    const deadline = Date.now() + timeoutMs;
    while (!acquired) {
      try { database.exec("BEGIN IMMEDIATE"); acquired = true; }
      catch (error) {
        if (![5, 6].includes(error.errcode) && !/database (?:is )?(?:locked|busy)/i.test(error.message)) throw error;
        if (Date.now() >= deadline) throw new Error("Understanding store is busy; retry after the other writer finishes.");
        await new Promise((done) => setTimeout(done, 25));
      }
    }
    // Old versions wrote empty lock files with no owner. There is no safe way
    // to distinguish a crashed old writer from an active one: do not delete it.
    const legacy = await stat(`${filePath}.lock`).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (legacy) throw Object.assign(new Error(`UNDERSTANDING_LEGACY_LOCK: 发现旧版写锁。请退出旧版 AporiaX，确认没有其他写入进程后移走该锁文件：${filePath}.lock。理解库正文未修改。`), { code: "UNDERSTANDING_LEGACY_LOCK" });
    const result = await action();
    database.exec("COMMIT");
    acquired = false;
    return result;
  } finally {
    try { if (acquired) database.exec("ROLLBACK"); }
    finally { database.close(); }
  }
}
