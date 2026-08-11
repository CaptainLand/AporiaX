import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";
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

const SEARCH_MODES = new Set([
  "literal",
  "regex",
  "symbol",
  "definition",
  "references",
]);

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchPattern(query, mode) {
  if (mode === "literal") return query;
  if (mode === "regex") return query;
  const symbol = escapeRegex(query);
  if (mode === "definition") {
    return `(?:class|function|const|let|var|interface|type|def|fn|func|struct|enum)\\s+${symbol}\\b`;
  }
  return `\\b${symbol}\\b`;
}

function normalizeGlobs(value, limit = 32) {
  return [...new Set((Array.isArray(value) ? value : []).map(String).map((item) => item.trim()).filter(Boolean))]
    .slice(0, limit);
}

function globExpression(glob) {
  const source = String(glob || "").replace(/\\/g, "/");
  let output = "^";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "*" && source[index + 1] === "*") {
      output += ".*";
      index += 1;
    } else if (character === "*") {
      output += "[^/]*";
    } else if (character === "?") {
      output += "[^/]";
    } else {
      output += escapeRegex(character);
    }
  }
  return new RegExp(`${output}$`, "i");
}

function pathMatchesGlobs(path, includeGlobs, excludeGlobs) {
  const normalized = String(path || "").replace(/\\/g, "/");
  if (includeGlobs.length && !includeGlobs.some((glob) => globExpression(glob).test(normalized))) {
    return false;
  }
  return !excludeGlobs.some((glob) => globExpression(glob.replace(/^!+/, "")).test(normalized));
}

function parseRipgrepText(value) {
  if (typeof value === "string") return value;
  return String(value?.text || value?.bytes || "");
}

async function searchWithRipgrep({
  workspaceRoot,
  searchRoot,
  requestedPath,
  query,
  mode,
  caseSensitive,
  maxResults,
  includeGlobs,
  excludeGlobs,
  signal,
  ignores,
  maxFileBytes,
}) {
  const args = [
    "--json",
    "--line-number",
    "--column",
    "--no-messages",
    "--max-filesize",
    String(maxFileBytes),
    caseSensitive ? "--case-sensitive" : "--ignore-case",
  ];
  if (mode === "literal") args.push("--fixed-strings");
  for (const name of ignores) args.push("--glob", `!${name}/**`);
  for (const glob of includeGlobs) args.push("--glob", glob);
  for (const glob of excludeGlobs) args.push("--glob", `!${glob.replace(/^!+/, "")}`);
  args.push("--", searchPattern(query, mode), ".");

  return new Promise((resolvePromise, rejectPromise) => {
    const results = [];
    let buffer = "";
    let stderr = "";
    let settled = false;
    let truncated = false;
    let filesScanned = null;
    const child = spawn(rgPath, args, {
      cwd: searchRoot,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", handleAbort);
      callback(value);
    };
    const handleAbort = () => {
      child.kill();
      finish(rejectPromise, createAbortError());
    };
    const consume = (line) => {
      if (!line.trim()) return;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        return;
      }
      if (payload.type === "summary") {
        filesScanned = Number(payload.data?.stats?.searches) || null;
        return;
      }
      if (payload.type !== "match" || results.length >= maxResults) return;
      const data = payload.data || {};
      const relativeToSearch = parseRipgrepText(data.path);
      const absolutePath = resolve(searchRoot, relativeToSearch);
      if (!isPathInside(workspaceRoot, absolutePath)) return;
      const lineText = parseRipgrepText(data.lines).replace(/[\r\n]+$/, "");
      const submatch = data.submatches?.[0] || {};
      results.push({
        path: relative(workspaceRoot, absolutePath).replace(/\\/g, "/"),
        line: Number(data.line_number) || 1,
        column: Number(submatch.start) + 1 || 1,
        preview: lineText.length > 320 ? `${lineText.slice(0, 317)}...` : lineText,
      });
      if (results.length >= maxResults) {
        truncated = true;
        child.kill();
      }
    };

    signal?.addEventListener("abort", handleAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) consume(line);
    });
    child.stderr.on("data", (chunk) => {
      stderr = trimCommandOutput(stderr + chunk.toString("utf8"), 8_000);
    });
    child.on("error", (error) => finish(rejectPromise, error));
    child.on("close", (code) => {
      if (buffer) consume(buffer);
      if (!truncated && code !== 0 && code !== 1) {
        finish(rejectPromise, new Error(stderr.trim() || `ripgrep exited with code ${code}.`));
        return;
      }
      finish(resolvePromise, {
        query,
        path: requestedPath || ".",
        mode,
        caseSensitive,
        includeGlobs,
        excludeGlobs,
        engine: "ripgrep",
        semantic: false,
        heuristic: ["definition", "references"].includes(mode),
        results,
        filesScanned,
        truncated,
      });
    });
  });
}

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
  mode = "literal",
  includeGlobs = [],
  excludeGlobs = [],
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
  const normalizedMode = SEARCH_MODES.has(mode) ? mode : "literal";
  const normalizedIncludes = normalizeGlobs(includeGlobs);
  const normalizedExcludes = normalizeGlobs(excludeGlobs);
  const searchRoot = await verifyExistingTarget(
    workspaceRoot,
    requestedPath || ".",
  );
  const searchStats = await lstat(searchRoot);
  if (!searchStats.isDirectory()) {
    throw new Error("The search path must be a directory.");
  }
  try {
    return await searchWithRipgrep({
      workspaceRoot,
      searchRoot,
      requestedPath,
      query,
      mode: normalizedMode,
      caseSensitive,
      maxResults,
      includeGlobs: normalizedIncludes,
      excludeGlobs: normalizedExcludes,
      signal,
      ignores,
      maxFileBytes,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    // Keep a portable fallback for unsupported platforms or damaged optional binaries.
  }
  const normalizedQuery = caseSensitive ? query : query.toLowerCase();
  let fallbackRegex = null;
  if (normalizedMode !== "literal") {
    try {
      fallbackRegex = new RegExp(searchPattern(query, normalizedMode), caseSensitive ? "" : "i");
    } catch (error) {
      throw new Error(`Invalid search regular expression: ${error.message}`);
    }
  }
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
        const relativePath = relative(workspaceRoot, entryPath).replace(/\\/g, "/");
        if (!pathMatchesGlobs(relativePath, normalizedIncludes, normalizedExcludes)) continue;
        const stats = await lstat(entryPath);
        if (stats.size > maxFileBytes) continue;
        const content = await readFile(entryPath, "utf8");
        filesScanned += 1;
        if (content.includes("\0")) continue;
        const lines = content.replace(/\r\n/g, "\n").split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          const searchable = caseSensitive ? line : line.toLowerCase();
          const match = fallbackRegex ? fallbackRegex.exec(line) : null;
          const column = fallbackRegex ? match?.index ?? -1 : searchable.indexOf(normalizedQuery);
          if (column < 0) continue;
          results.push({
            path: relativePath,
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
    mode: normalizedMode,
    includeGlobs: normalizedIncludes,
    excludeGlobs: normalizedExcludes,
    engine: "node-fallback",
    semantic: false,
    results,
    filesScanned,
    truncated,
  };
}
