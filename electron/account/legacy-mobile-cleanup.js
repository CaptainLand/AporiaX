import { lstat, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

// Migration only: never read or upload these files, and never recurse into
// directories. The normal local task/history/project stores are not targets.
export const LEGACY_MOBILE_CACHE_FILES = Object.freeze([
  "aporiax-remote-file-access.json",
  "aporiax-remote-commands.sqlite3",
  "aporiax-remote-commands.sqlite3-wal",
  "aporiax-remote-commands.sqlite3-shm",
  "aporiax-remote-commands.sqlite3-journal",
]);

export async function cleanupLegacyMobileData(userDataPath) {
  const result = { removed: [], failed: [] };
  if (!isAbsolute(userDataPath)) throw new Error("USER_DATA_ABSOLUTE_PATH_REQUIRED");
  for (const name of LEGACY_MOBILE_CACHE_FILES) {
    const target = join(userDataPath, name);
    try {
      const entry = await lstat(target);
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        result.failed.push(name);
        continue;
      }
      await rm(target, { force: true });
      result.removed.push(name);
    } catch (error) {
      if (error?.code !== "ENOENT") result.failed.push(name);
    }
  }
  if (result.failed.length) {
    // A locked legacy cache must not disable normal sign-in or local tasks.
    console.warn("[privacy] Some legacy mobile caches could not be removed; close older app versions and restart.");
  }
  return result;
}
