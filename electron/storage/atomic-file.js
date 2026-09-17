import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const queues = new Map();
/** Serialize in-process writers to the same authority, including separate store instances. */
export function serializeStorage(key, operation) {
  const normalized = process.platform === 'win32' ? resolve(key).toLowerCase() : resolve(key);
  const previous = queues.get(normalized) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(normalized, current);
  return current.finally(() => { if (queues.get(normalized) === current) queues.delete(normalized); });
}

/** Flush a unique sibling, then replace. A failed Windows rename NEVER deletes the old file. */
export async function atomicWriteFile(path, contents, { mode = 0o600, io = fs } = {}) {
  await io.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await io.open(temporary, 'wx', mode);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close(); handle = null;
    await io.rename(temporary, path);
  } finally {
    await handle?.close().catch(() => {});
    await io.rm(temporary, { force: true }).catch(() => {});
  }
}
