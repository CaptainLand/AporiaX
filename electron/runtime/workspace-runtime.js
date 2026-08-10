import { spawn } from "node:child_process";
import {
  lstat,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";

export const MAX_COMMAND_OUTPUT_CHARS = 80_000;
export const MAX_SEARCH_FILE_BYTES = 2_000_000;
export const TREE_IGNORES = new Set([
  ".git",
  ".idea",
  ".next",
  ".turbo",
  ".vscode",
  "coverage",
  "dist",
  "node_modules",
]);

function createAbortError() {
  const error = new Error("The run was interrupted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

export function isPathInside(rootPath, candidatePath) {
  const pathFromRoot = relative(rootPath, candidatePath);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

export function resolveWorkspacePath(workspaceRoot, requestedPath) {
  if (typeof requestedPath !== "string" || requestedPath.includes("\0")) {
    throw new Error("Invalid workspace path.");
  }
  const targetPath = resolve(workspaceRoot, requestedPath || ".");
  if (!isPathInside(workspaceRoot, targetPath)) {
    throw new Error("Path escapes the authorized workspace.");
  }
  return targetPath;
}

export async function getVerifiedWorkspaceRoot(workspacePath) {
  if (typeof workspacePath !== "string" || !workspacePath.trim()) {
    throw new Error("A workspace directory is required.");
  }
  const workspaceRoot = await realpath(resolve(workspacePath));
  const workspaceStats = await lstat(workspaceRoot);
  if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink()) {
    throw new Error("The workspace must be a real directory.");
  }
  return workspaceRoot;
}

export async function verifyExistingTarget(workspaceRoot, requestedPath) {
  const lexicalTarget = resolveWorkspacePath(workspaceRoot, requestedPath);
  const verifiedTarget = await realpath(lexicalTarget);
  if (!isPathInside(workspaceRoot, verifiedTarget)) {
    throw new Error("Resolved path escapes the authorized workspace.");
  }
  return verifiedTarget;
}

export async function verifyWritableTarget(workspaceRoot, requestedPath) {
  const targetPath = resolveWorkspacePath(workspaceRoot, requestedPath);
  const verifiedParent = await realpath(dirname(targetPath));
  if (!isPathInside(workspaceRoot, verifiedParent)) {
    throw new Error("Resolved parent path escapes the authorized workspace.");
  }
  try {
    const targetStats = await lstat(targetPath);
    if (targetStats.isSymbolicLink() || targetStats.isDirectory()) {
      throw new Error("Refusing to overwrite a symbolic link or directory.");
    }
    const verifiedTarget = await realpath(targetPath);
    if (!isPathInside(workspaceRoot, verifiedTarget)) {
      throw new Error("Resolved file escapes the authorized workspace.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return targetPath;
}

export function calculateLineChanges(previousContent, nextContent) {
  const toLines = (content) =>
    content === ""
      ? []
      : String(content).replace(/\r\n/g, "\n").split("\n");
  const before = toLines(previousContent);
  const after = toLines(nextContent);

  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] ===
      after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    additions: Math.max(0, after.length - prefix - suffix),
    deletions: Math.max(0, before.length - prefix - suffix),
  };
}

function trimCommandOutput(value, maxOutputChars = MAX_COMMAND_OUTPUT_CHARS) {
  if (value.length <= maxOutputChars) return value;
  const half = Math.floor(maxOutputChars / 2);
  return `${value.slice(0, half)}\n\n… output truncated …\n\n${value.slice(-half)}`;
}

export async function runGitCommand({
  args,
  cwd,
  signal,
  maxOutputChars = MAX_COMMAND_OUTPUT_CHARS,
}) {
  throwIfAborted(signal);
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn("git", args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", handleAbort);
      callback(value);
    };
    const handleAbort = () => {
      child.kill();
      finish(rejectPromise, createAbortError());
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 30_000);

    signal?.addEventListener("abort", handleAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout = trimCommandOutput(stdout + chunk.toString("utf8"), maxOutputChars);
    });
    child.stderr.on("data", (chunk) => {
      stderr = trimCommandOutput(stderr + chunk.toString("utf8"), maxOutputChars);
    });
    child.on("error", (error) => finish(rejectPromise, error));
    child.on("close", (code, signalName) => {
      finish(resolvePromise, {
        exitCode: typeof code === "number" ? code : null,
        signal: signalName || null,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

export async function searchWorkspaceText({
  workspaceRoot,
  requestedPath,
  query,
  caseSensitive,
  maxResults,
  signal,
  ignores = TREE_IGNORES,
  maxFileBytes = MAX_SEARCH_FILE_BYTES,
}) {
  if (
    typeof query !== "string" ||
    !query ||
    query.length > 500 ||
    query.includes("\0")
  ) {
    throw new Error("Search query must be between 1 and 500 characters.");
  }
  const searchRoot = await verifyExistingTarget(
    workspaceRoot,
    requestedPath || ".",
  );
  const searchStats = await lstat(searchRoot);
  if (!searchStats.isDirectory()) {
    throw new Error("The search path must be a directory.");
  }
  const normalizedQuery = caseSensitive ? query : query.toLowerCase();
  const results = [];
  let filesScanned = 0;
  let truncated = false;

  async function visit(directoryPath) {
    throwIfAborted(signal);
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      throwIfAborted(signal);
      if (results.length >= maxResults) {
        truncated = true;
        return;
      }
      if (ignores.has(entry.name) || entry.isSymbolicLink()) continue;
      const entryPath = resolve(directoryPath, entry.name);
      if (!isPathInside(workspaceRoot, entryPath)) continue;
      if (entry.isDirectory()) {
        await visit(entryPath);
        if (truncated) return;
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stats = await lstat(entryPath);
        if (stats.size > maxFileBytes) continue;
        const content = await readFile(entryPath, "utf8");
        filesScanned += 1;
        if (content.includes("\0")) continue;
        const lines = content.replace(/\r\n/g, "\n").split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          const searchable = caseSensitive ? line : line.toLowerCase();
          const column = searchable.indexOf(normalizedQuery);
          if (column === -1) continue;
          results.push({
            path: relative(workspaceRoot, entryPath).replace(/\\/g, "/"),
            line: index + 1,
            column: column + 1,
            preview: line.length > 320 ? `${line.slice(0, 317)}...` : line,
          });
          if (results.length >= maxResults) {
            truncated = true;
            return;
          }
        }
      } catch (error) {
        if (error?.name === "AbortError") throw error;
      }
    }
  }

  await visit(searchRoot);
  return {
    query,
    path: requestedPath || ".",
    caseSensitive,
    results,
    filesScanned,
    truncated,
  };
}
