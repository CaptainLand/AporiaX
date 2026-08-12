import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const MAX_EXTERNAL_DIRECTORY_ENTRIES = 200;

function abortError() {
  const error = new Error("The run was interrupted.");
  error.name = "AbortError";
  return error;
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function entryType(entry) {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

/**
 * `read_external_file` remains the single external-read capability, but an
 * absolute directory path may now be inspected as a bounded, non-recursive
 * listing. Returning null delegates ordinary files back to the existing file /
 * PDF reader. No write primitive is exposed here.
 */
export async function tryReadExternalDirectory(requestedPath, { signal } = {}) {
  assertNotAborted(signal);
  if (typeof requestedPath !== "string" || !requestedPath.trim() || requestedPath.includes("\0")) {
    return null;
  }
  if (!isAbsolute(requestedPath)) return null;

  const lexicalPath = resolve(requestedPath);
  const lexicalStats = await lstat(lexicalPath);
  if (lexicalStats.isSymbolicLink()) {
    throw new Error("Refusing to follow a symbolic link outside the workspace.");
  }
  if (!lexicalStats.isDirectory()) return null;

  const verifiedPath = await realpath(lexicalPath);
  const verifiedStats = await lstat(verifiedPath);
  if (!verifiedStats.isDirectory() || verifiedStats.isSymbolicLink()) {
    throw new Error("External path is not a real directory.");
  }

  assertNotAborted(signal);
  const allEntries = await readdir(verifiedPath, { withFileTypes: true });
  allEntries.sort((left, right) => left.name.localeCompare(right.name));
  const visible = allEntries.slice(0, MAX_EXTERNAL_DIRECTORY_ENTRIES);

  return {
    path: verifiedPath,
    kind: "directory",
    external: true,
    readOnly: true,
    entries: visible.map((entry) => ({
      name: entry.name,
      type: entryType(entry),
    })),
    truncated: allEntries.length > visible.length,
    totalEntries: allEntries.length,
  };
}
