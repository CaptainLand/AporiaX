import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  ScopeLeaseManager,
  normalizeBuilderScopes,
  pathInsideScopes,
} from "./scope-leases.js";

import { sharedScopeLeases } from "./shared-scope-leases.js";
import { mergeBuilderFiles } from "./builder-merge.js";

export function builderSnapshotLimits(input = {}) {
  const limit = (key, env, fallback, min, max) => {
    const raw = input[key] ?? process.env[env];
    if (raw == null || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${env}: expected ${min}–${max}.`);
    return value;
  };
  const limits = {
    maxFiles: limit("maxFiles", "APORIAX_BUILDER_MAX_FILES", 3000, 1, 10000),
    maxBytes: limit("maxBytes", "APORIAX_BUILDER_MAX_BYTES", 32_000_000, 1, 64_000_000),
    maxFileBytes: limit("maxFileBytes", "APORIAX_BUILDER_MAX_FILE_BYTES", 8_000_000, 1, 16_000_000),
  };
  if (limits.maxFileBytes > limits.maxBytes) throw new Error("Invalid Builder limits: maxFileBytes must not exceed maxBytes.");
  return limits;
}
const DIR_IGNORES = new Set([
  ".git",
  "node_modules",
  "dist",
  "release",
  "coverage",
]);

function runGit(args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (code) => {
      const result = {
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (result.exitCode !== 0) {
        rejectRun(
          new Error(
            result.stderr.trim() ||
              `git ${args.join(" ")} failed with exit code ${result.exitCode}.`,
          ),
        );
        return;
      }
      resolveRun(result);
    });
  });
}

function normalizedRelative(root, absolutePath) {
  return relative(root, absolutePath).replace(/\\/g, "/");
}

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function bufferLooksBinary(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  return sample.includes(0);
}

async function readFileState(root, path, limits, hashOnly = false) {
  const absolute = resolve(root, ...String(path).split("/"));
  try {
    const stats = await lstat(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return { missing: true, hash: null, content: null };
    }
    if (hashOnly) {
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(absolute)) digest.update(chunk);
      return { missing: false, hash: digest.digest("hex"), content: null };
    }
    if (stats.size > limits.maxFileBytes) {
      throw new Error(
        `Builder scoped file exceeds ${limits.maxFileBytes} bytes: ${path}. Narrow writeScopes or adjust APORIAX_BUILDER_MAX_FILE_BYTES.`,
      );
    }
    const content = await readFile(absolute);
    return {
      missing: false,
      hash: hashBuffer(content),
      content,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { missing: true, hash: null, content: null };
    }
    throw error;
  }
}

function sameState(left, right) {
  return (
    Boolean(left?.missing) === Boolean(right?.missing) &&
    (left?.missing || left?.hash === right?.hash)
  );
}

async function captureScope(root, scopes, limits, metadataOnly = false, signal) {
  const files = new Map();
  let totalBytes = 0;

  const captureFile = async (absolutePath) => {
    signal?.throwIfAborted();
    if (files.has(normalizedRelative(root, absolutePath))) return;
    if (files.size >= limits.maxFiles) {
      throw new Error(
        `Builder scope snapshot exceeds ${limits.maxFiles} files. Narrow writeScopes or adjust APORIAX_BUILDER_MAX_FILES.`,
      );
    }
    const stats = await lstat(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return;
    if (stats.size > limits.maxFileBytes) {
      throw new Error(
        `Builder scoped file exceeds ${limits.maxFileBytes} bytes: ${normalizedRelative(root, absolutePath)}`,
      );
    }
    totalBytes += stats.size;
    if (totalBytes > limits.maxBytes) {
      throw new Error(
        `Builder scope snapshot exceeds ${limits.maxBytes} total bytes. Narrow writeScopes or adjust APORIAX_BUILDER_MAX_BYTES.`,
      );
    }
    const content = metadataOnly ? Buffer.alloc(0) : await readFile(absolutePath);
    if (!metadataOnly) {
      const latest = await lstat(absolutePath);
      if (content.length !== stats.size || latest.size !== stats.size || latest.mtimeMs !== stats.mtimeMs) throw new Error(`Builder file changed during snapshot; retry after edits settle: ${normalizedRelative(root, absolutePath)}`);
    }
    files.set(normalizedRelative(root, absolutePath), {
      missing: false,
      hash: hashBuffer(content),
      content,
    });
  };

  const walk = async (absolutePath) => {
    signal?.throwIfAborted();
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (stats.isSymbolicLink()) return;
    if (stats.isFile()) {
      await captureFile(absolutePath);
      return;
    }
    if (!stats.isDirectory()) return;
    for (const entry of await readdir(absolutePath, { withFileTypes: true })) {
      if (DIR_IGNORES.has(entry.name) || entry.isSymbolicLink()) continue;
      await walk(join(absolutePath, entry.name));
    }
  };

  for (const scope of scopes) {
    await walk(resolve(root, ...scope.split("/")));
  }
  return files;
}

function changedPaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((path) => {
      const left = before.get(path) || { missing: true, hash: null };
      const right = after.get(path) || { missing: true, hash: null };
      return !sameState(left, right);
    })
    .sort();
}

function splitNull(buffer) {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

async function gitDirtyPathGroups(root) {
  const [tracked, untracked] = await Promise.all([
    runGit(["diff", "--name-only", "-z", "HEAD"], root),
    runGit(["ls-files", "--others", "--exclude-standard", "-z"], root),
  ]);
  return {
    tracked: [...new Set(splitNull(tracked.stdout))].sort(),
    untracked: [...new Set(splitNull(untracked.stdout))].sort(),
  };
}

async function gitDirtyPaths(root) {
  const groups = await gitDirtyPathGroups(root);
  return [...new Set([...groups.tracked, ...groups.untracked])].sort();
}

async function snapshotDirtyState(root) {
  const state = new Map();
  for (const path of await gitDirtyPaths(root)) {
    if (path === ".git" || path.startsWith(".git/")) continue;
    state.set(path, await readFileState(root, path, null, true));
  }
  return state;
}

function changedDirtyPaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => {
    const leftPresent = before.has(path);
    const rightPresent = after.has(path);
    if (leftPresent !== rightPresent) return true;
    return !sameState(before.get(path), after.get(path));
  });
}

async function overlayDirtyWorkspace(workspaceRoot, worktreeRoot, scopes) {
  const groups = await gitDirtyPathGroups(workspaceRoot);
  // Tracked dirty files are part of the user's current project state and are
  // overlaid repository-wide. Untracked files are overlaid only inside the
  // Builder's explicit write scopes. This avoids copying unrelated local
  // archives/build outputs into every worktree while preserving new source
  // files the Builder may legitimately own.
  const paths = [
    ...new Set([
      ...groups.tracked,
      ...groups.untracked.filter((path) => pathInsideScopes(path, scopes)),
    ]),
  ];
  for (const path of paths) {
    if (path === ".git" || path.startsWith(".git/")) continue;
    const source = resolve(workspaceRoot, ...path.split("/"));
    const target = resolve(worktreeRoot, ...path.split("/"));
    let stats;
    try {
      stats = await lstat(source);
    } catch (error) {
      if (error?.code === "ENOENT") {
        await rm(target, { recursive: true, force: true });
        continue;
      }
      throw error;
    }
    if (stats.isSymbolicLink() || stats.isDirectory() || !stats.isFile()) {
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

async function ensureGitWorkspace(workspaceRoot) {
  const top = (
    await runGit(["rev-parse", "--show-toplevel"], workspaceRoot)
  ).stdout
    .toString("utf8")
    .trim();
  if (resolve(top) !== resolve(workspaceRoot)) {
    throw new Error(
      "Builder isolation currently requires the selected workspace to be the Git repository root.",
    );
  }
  await runGit(["rev-parse", "--verify", "HEAD"], workspaceRoot);
}

function calculateLineChanges(previousContent, nextContent) {
  const toLines = (content) =>
    content === ""
      ? []
      : content.replace(/\r\n/g, "\n").split("\n");
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

function createCheckpoint(path, beforeState, afterState) {
  const before = beforeState || {
    missing: true,
    content: Buffer.alloc(0),
  };
  const after = afterState || {
    missing: true,
    content: Buffer.alloc(0),
  };
  if (
    (!before.missing && bufferLooksBinary(before.content)) ||
    (!after.missing && bufferLooksBinary(after.content))
  ) {
    throw new Error(
      `Builder merge rejects binary changes; keep Builder scopes to source/config text files: ${path}`,
    );
  }
  const beforeContent = before.missing
    ? ""
    : before.content.toString("utf8");
  const afterContent = after.missing
    ? ""
    : after.content.toString("utf8");
  const encoded = (!before.missing && !isUtf8(before.content)) || (!after.missing && !isUtf8(after.content));
  return {
    path,
    beforeContent: encoded && !before.missing ? before.content.toString("base64") : beforeContent,
    afterContent: encoded && !after.missing ? after.content.toString("base64") : afterContent,
    ...(!before.missing && !isUtf8(before.content) ? { beforeBase64: before.content.toString("base64") } : {}),
    ...(!after.missing && !isUtf8(after.content) ? { afterBase64: after.content.toString("base64") } : {}),
    beforeHash: before.missing ? null : hashBuffer(before.content),
    afterHash: after.missing ? null : hashBuffer(after.content),
    beforeMissing: Boolean(before.missing),
    afterMissing: Boolean(after.missing),
    binary: encoded,
    artifact: null,
    created: Boolean(before.missing && !after.missing),
    deleted: Boolean(!before.missing && after.missing),
    reverted: false,
    source: "builder-merge",
    ...calculateLineChanges(beforeContent, afterContent),
  };
}

export class BuilderWorkspaceManager {
  #leases;
  #eventBus;
  #onMergePrepared;
  #limits;

  constructor({ eventBus = null, leases = null, onMergePrepared = null, snapshotLimits } = {}) {
    this.#eventBus = eventBus;
    this.#leases = leases || sharedScopeLeases;
    this.#onMergePrepared = onMergePrepared;
    this.#limits = builderSnapshotLimits(snapshotLimits);
  }

  leases() {
    return this.#leases.list();
  }

  async open({ workspaceRoot, agentId, writeScopes, signal }) {
    signal?.throwIfAborted();
    const owner = String(agentId || "").trim();
    if (!owner) throw new Error("Builder agentId is required.");
    const scopes = normalizeBuilderScopes(writeScopes);
    workspaceRoot = await realpath(resolve(workspaceRoot));
    const lease = this.#leases.acquire(owner, scopes, { workspaceRoot });
    let baseDirectory = null;
    let worktreeRoot = null;
    try {
      await ensureGitWorkspace(workspaceRoot);
      await captureScope(workspaceRoot, scopes, this.#limits, true, signal);
      baseDirectory = await mkdtemp(join(tmpdir(), "aporiax-builder-"));
      worktreeRoot = join(baseDirectory, "workspace");
      await runGit(
        ["worktree", "add", "--detach", worktreeRoot, "HEAD"],
        workspaceRoot,
      );
      // Use the same physical spelling as verified tool paths on Windows.
      worktreeRoot = await realpath(worktreeRoot);
      await overlayDirtyWorkspace(workspaceRoot, worktreeRoot, scopes);
      signal?.throwIfAborted();
      const baseline = await captureScope(workspaceRoot, scopes, this.#limits);
      const worktreeDirtyBaseline = await snapshotDirtyState(worktreeRoot);
      this.#eventBus?.emit({
        type: "builder.workspace.created",
        agentId: owner,
        writeScopes: scopes,
      });

      let closed = false;
      let mergeInProgress = false;
      let mergeRecovery = null;
      const close = async ({ discardRecovery = false } = {}) => {
        if (closed) return;
        if (mergeInProgress) throw new Error("Builder merge is in progress.");
        if (mergeRecovery?.unresolved?.length && !discardRecovery) {
          throw new Error(`Builder recovery files were retained: ${mergeRecovery.manifestPath}`);
        }
        closed = true;
        try {
          await runGit(
            ["worktree", "remove", "--force", worktreeRoot],
            workspaceRoot,
          );
        } catch {
          await rm(worktreeRoot, { recursive: true, force: true }).catch(
            () => undefined,
          );
          await runGit(["worktree", "prune"], workspaceRoot).catch(
            () => undefined,
          );
        }
        await rm(baseDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
        lease.release();
        this.#eventBus?.emit({
          type: "builder.workspace.closed",
          agentId: owner,
        });
      };

      const performMerge = async () => {
        if (closed) throw new Error("Builder workspace is already closed.");
        const worktreeDirtyAfter = await snapshotDirtyState(worktreeRoot);
        const workerTouched = changedDirtyPaths(
          worktreeDirtyBaseline,
          worktreeDirtyAfter,
        );
        const outsideScopes = workerTouched.filter(
          (path) => !pathInsideScopes(path, scopes),
        );
        if (outsideScopes.length) {
          this.#eventBus?.emit({
            type: "builder.scope.violation",
            agentId: owner,
            writeScopes: scopes,
            paths: outsideScopes,
          });
          throw new Error(
            `Builder changed files outside its lease: ${outsideScopes.join(", ")}`,
          );
        }

        const after = await captureScope(worktreeRoot, scopes, this.#limits);
        const paths = changedPaths(baseline, after);
        const checkpoints = paths.map((path) =>
          createCheckpoint(path, baseline.get(path), after.get(path)),
        );

        const conflicts = [];
        const currentStates = new Map();
        for (const path of paths) {
          const current = await readFileState(workspaceRoot, path, this.#limits);
          currentStates.set(path, current);
          const expected =
            baseline.get(path) || {
              missing: true,
              hash: null,
              content: null,
            };
          if (!sameState(current, expected)) conflicts.push(path);
        }
        if (conflicts.length) {
          this.#eventBus?.emit({
            type: "builder.merge.conflict",
            agentId: owner,
            writeScopes: scopes,
            conflicts,
          });
          return {
            merged: false,
            conflicts,
            changes: [],
            checkpoints: [],
          };
        }

        mergeRecovery = await mergeBuilderFiles({ workspaceRoot, paths, before: currentStates, after,
          recoveryRoot: baseDirectory,
          onPrepared: async (recovery) => {
            mergeRecovery = recovery;
            await this.#onMergePrepared?.(recovery);
          },
          emit: (event) => this.#eventBus?.emit({ agentId: owner, ...event }),
        });

        const changes = checkpoints.map((checkpoint) => ({
          path: checkpoint.path,
          created: checkpoint.created,
          deleted: checkpoint.deleted,
          additions: checkpoint.additions,
          deletions: checkpoint.deletions,
        }));
        this.#eventBus?.emit({
          type: "builder.merge.completed",
          agentId: owner,
          writeScopes: scopes,
          changes,
        });
        return {
          merged: true,
          conflicts: [],
          changes,
          checkpoints,
          recovery: mergeRecovery,
        };
      };

      const merge = async () => {
        if (mergeInProgress) throw new Error("Builder merge is already in progress.");
        if (mergeRecovery?.unresolved?.length) throw new Error(`Resolve the previous Builder merge first: ${mergeRecovery.manifestPath}`);
        mergeInProgress = true;
        try { return await performMerge(); }
        catch (error) { if (error.mergeRecovery) mergeRecovery = error.mergeRecovery; throw error; }
        finally { mergeInProgress = false; }
      };

      const snapshot = async () => {
        if (closed) throw new Error("Builder workspace is already closed.");
        const after = await captureScope(worktreeRoot, scopes, this.#limits);
        return changedPaths(baseline, after).map((path) => createCheckpoint(path, baseline.get(path), after.get(path)));
      };

      return Object.freeze({
        agentId: owner,
        workspaceRoot: worktreeRoot,
        writeScopes: Object.freeze([...scopes]),
        merge,
        snapshot,
        close,
      });
    } catch (error) {
      lease.release();
      if (worktreeRoot) {
        await runGit(
          ["worktree", "remove", "--force", worktreeRoot],
          workspaceRoot,
        ).catch(() => undefined);
      }
      if (baseDirectory) {
        await rm(baseDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }
}

export function createBuilderWorkspaceManager(options) {
  return new BuilderWorkspaceManager(options);
}
