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
  writeFile,
  statfs,
  open,
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
import { saveCheckpointFile } from '../runtime/checkpoint-files.js';

export function builderSnapshotLimits(input = {}) {
  const limit = (key, env, fallback, min, max) => {
    const raw = input[key] ?? process.env[env];
    if (raw == null || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${env}: expected ${min}–${max}.`);
    return value;
  };
  const limits = {
    maxFiles: limit('maxFiles', 'APORIAX_BUILDER_MAX_FILES', 100000, 1, 1000000),
    maxBytes: limit('maxBytes', 'APORIAX_BUILDER_MAX_BYTES', 2_000_000_000, 1, 16_000_000_000),
    maxFileBytes: limit('maxFileBytes', 'APORIAX_BUILDER_MAX_FILE_BYTES', 64_000_000, 1, 1_000_000_000),
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
  '.tmp', '.aporiax', '.cache',
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
      return { missing: false, hash: digest.digest("hex"), content: hashOnly === 'file' ? { filePath: absolute } : null, bytes: stats.size };
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

async function captureScope(root, scopes, limits, metadataOnly = false, signal, destination = null) {
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
    const content = metadataOnly ? null : await readFile(absolutePath);
    let hash = content ? hashBuffer(content) : null;
    if (metadataOnly === 'copy') {
      const target = join(destination, normalizedRelative(root, absolutePath));
      await mkdir(dirname(target), { recursive: true }); await copyFile(absolutePath, target);
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(target)) { signal?.throwIfAborted(); digest.update(chunk); }
      hash = digest.digest('hex');
    } else if (metadataOnly === 'hash') {
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(absolutePath)) { signal?.throwIfAborted(); digest.update(chunk); }
      hash = digest.digest('hex');
    }
    if (metadataOnly !== true) {
      const latest = await lstat(absolutePath);
      if (content && content.length !== stats.size || latest.size !== stats.size || latest.mtimeMs !== stats.mtimeMs) throw new Error(`Builder file changed during snapshot; retry after edits settle: ${normalizedRelative(root, absolutePath)}`);
    }
    files.set(normalizedRelative(root, absolutePath), {
      missing: false,
      hash,
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
  try { await runGit(["rev-parse", "--verify", "HEAD"], workspaceRoot); return true; }
  catch {
    // An unborn branch is valid; broken/detached HEAD is not silently repaired.
    const branch = (await runGit(['symbolic-ref', '--quiet', 'HEAD'], workspaceRoot)).stdout.toString().trim();
    if (!branch.startsWith('refs/heads/')) throw Error('Builder requires a valid Git branch.');
    await runGit(['status', '--porcelain=v1'], workspaceRoot);
    return false;
  }
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

async function createCheckpoint(path, beforeState, afterState, ownerRoot, budget = { remaining: 8_000_000 }) {
  // Keep small source diffs convenient, but bound the whole snapshot's inline
  // payload. File versions beyond that budget live in verified disk storage.
  const versions = {};
  let fileBackedBinary = false;
  for (const [side, state] of [['before', beforeState], ['after', afterState]]) {
    if (!state?.missing && state?.content?.filePath) {
      const size = (await lstat(state.content.filePath)).size;
      if (size <= 128_000 && size <= budget.remaining) {
        budget.remaining -= size;
        state.content = await readFile(state.content.filePath);
        if (hashBuffer(state.content) !== state.hash) throw Error(`Checkpoint changed: ${path}`);
      } else {
        versions[side] = await saveCheckpointFile(ownerRoot, path, state.content.filePath, state.hash);
        const handle = await open(state.content.filePath, 'r');
        try {
          const sample = Buffer.alloc(Math.min(size, 8192)); await handle.read(sample, 0, sample.length, 0);
          fileBackedBinary ||= bufferLooksBinary(sample) || !isUtf8(sample);
        } finally { await handle.close(); }
      }
    }
  }
  const before = beforeState || {
    missing: true,
    content: Buffer.alloc(0),
  };
  const after = afterState || {
    missing: true,
    content: Buffer.alloc(0),
  };
  const encoded = fileBackedBinary || [before, after].some(state => !state.missing && Buffer.isBuffer(state.content) && (bufferLooksBinary(state.content) || !isUtf8(state.content)));
  const beforeContent = before.missing
    ? ""
    : versions.before ? '' : before.content.toString("utf8");
  const afterContent = after.missing
    ? ""
    : versions.after ? '' : after.content.toString("utf8");
  return {
    path,
    beforeContent: encoded && !before.missing && !versions.before ? before.content.toString("base64") : beforeContent,
    afterContent: encoded && !after.missing && !versions.after ? after.content.toString("base64") : afterContent,
    ...(encoded && !before.missing && !versions.before && !isUtf8(before.content) ? { beforeBase64: before.content.toString('base64') } : {}),
    ...(encoded && !after.missing && !versions.after && !isUtf8(after.content) ? { afterBase64: after.content.toString('base64') } : {}),
    beforeHash: before.missing ? null : before.hash,
    afterHash: after.missing ? null : after.hash,
    beforeBytes: before.missing ? 0 : before.bytes ?? before.content.length,
    afterBytes: after.missing ? 0 : after.bytes ?? after.content.length,
    ...(Object.keys(versions).length ? { fileVersions: versions, previewTruncated: true } : {}),
    beforeMissing: Boolean(before.missing),
    afterMissing: Boolean(after.missing),
    binary: encoded,
    artifact: null,
    created: Boolean(before.missing && !after.missing),
    deleted: Boolean(!before.missing && after.missing),
    reverted: false,
    source: "builder-merge",
    ...(encoded || Object.keys(versions).length ? { additions: 0, deletions: 0 } : calculateLineChanges(beforeContent, afterContent)),
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

  async open({ workspaceRoot, agentId, writeScopes, signal, commandWorkspace = false }) {
    signal?.throwIfAborted();
    const owner = String(agentId || "").trim();
    if (!owner) throw new Error("Builder agentId is required.");
    const scopes = normalizeBuilderScopes(writeScopes, { allowRoot: commandWorkspace });
    workspaceRoot = await realpath(resolve(workspaceRoot));
    // Inspection/command workers do not reserve the entire repository. Reserve
    // only the paths they actually changed, at conflict-checked integration.
    const lease = commandWorkspace ? { release() {} } : this.#leases.acquire(owner, scopes, { workspaceRoot });
    let baseDirectory = null;
    let worktreeRoot = null;
    let linkedWorktree = false;
    try {
      let hasHead;
      if (commandWorkspace) {
        try { hasHead = await ensureGitWorkspace(workspaceRoot); }
        catch { hasHead = false; } // plain folders are valid command workspaces
      } else hasHead = await ensureGitWorkspace(workspaceRoot);
      await captureScope(workspaceRoot, scopes, this.#limits, true, signal);
      baseDirectory = await mkdtemp(join(tmpdir(), "aporiax-builder-"));
      worktreeRoot = join(baseDirectory, "workspace");
      if (hasHead) { await runGit(
        ["worktree", "add", "--detach", worktreeRoot, "HEAD"],
        workspaceRoot,
      ); linkedWorktree = true; }
      else {
        await mkdir(worktreeRoot);
        const disk = await statfs(baseDirectory);
        const free = Number(disk.bavail) * Number(disk.bsize);
        const copyLimits = { ...this.#limits, maxBytes: Math.min(this.#limits.maxBytes, Math.max(0, Math.floor(free - 512 * 1024 ** 2))) };
        const snapshot = await captureScope(workspaceRoot, ['.'], copyLimits, 'copy', signal, worktreeRoot);
        // The baseline commit is confined to a new private repository. No user
        // index, branch, hooks, attributes or commits are touched.
        try {
          await runGit(['-c', 'init.templateDir=', 'init'], worktreeRoot);
          await runGit(['-c', 'user.name=AporiaX', '-c', 'user.email=local@aporiax.invalid', '-c', 'core.hooksPath=' + join(baseDirectory, 'no-hooks'), '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', 'Private Builder baseline'], worktreeRoot);
        } catch (error) {
          if (!commandWorkspace) throw error;
          this.#eventBus?.emit({ type: 'subagent.resource.warning', agentId: owner,
            detail: 'Git is unavailable in the private command copy; ordinary command and file checks remain available.', recoverable: true });
        }
        if (changedPaths(snapshot, await captureScope(workspaceRoot, ['.'], copyLimits, 'hash', signal)).length) throw Error('Workspace changed during Builder snapshot; retry once edits settle.');
      }
      // Use the same physical spelling as verified tool paths on Windows.
      worktreeRoot = await realpath(worktreeRoot);
      if (linkedWorktree) await overlayDirtyWorkspace(workspaceRoot, worktreeRoot, scopes);
      signal?.throwIfAborted();
      const baselineRoot = join(baseDirectory, 'baseline');
      const baseline = await captureScope(workspaceRoot, scopes, this.#limits, 'copy', signal, baselineRoot);
      const materialize = async (root, metadata, paths) => {
        const content = new Map();
        for (const path of paths) if (metadata.has(path)) {
          const state = await readFileState(root, path, this.#limits, 'file');
          if (!sameState(state, metadata.get(path))) throw Error(`Builder snapshot changed while reading: ${path}`);
          content.set(path, state);
        }
        return content;
      };
      const dirtySnapshot = () => linkedWorktree ? snapshotDirtyState(worktreeRoot) : captureScope(worktreeRoot, ['.'], this.#limits, 'hash');
      const worktreeDirtyBaseline = await dirtySnapshot();
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
          if (linkedWorktree) await runGit(
            ["worktree", "remove", "--force", worktreeRoot],
            workspaceRoot,
          );
        } catch {
          await rm(worktreeRoot, { recursive: true, force: true }).catch(
            () => undefined,
          );
          if (linkedWorktree) await runGit(["worktree", "prune"], workspaceRoot).catch(
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
        const worktreeDirtyAfter = await dirtySnapshot();
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

        const afterMetadata = await captureScope(worktreeRoot, scopes, this.#limits, 'hash', signal);
        const paths = changedPaths(baseline, afterMetadata);
        if (!paths.length) return { merged: true, conflicts: [], changes: [], checkpoints: [] };
        let integrationLease;
        if (commandWorkspace && paths.length) {
          try { integrationLease = this.#leases.acquire(owner, paths, { workspaceRoot }); }
          catch { return { merged: false, conflicts: paths, changes: [], checkpoints: [] }; }
        }
        try {
        const before = await materialize(baselineRoot, baseline, paths);
        const after = await materialize(worktreeRoot, afterMetadata, paths);
        const checkpoints = [], budget = { remaining: 8_000_000 };
        for (const path of paths) checkpoints.push(await createCheckpoint(path, before.get(path), after.get(path), workspaceRoot, budget));

        const conflicts = [];
        const currentStates = new Map();
        for (const path of paths) {
          const current = await readFileState(workspaceRoot, path, this.#limits, 'file');
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
        } finally { integrationLease?.release(); }
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
        const metadata = await captureScope(worktreeRoot, scopes, this.#limits, 'hash');
        const paths = changedPaths(baseline, metadata);
        const before = await materialize(baselineRoot, baseline, paths), after = await materialize(worktreeRoot, metadata, paths);
        const checkpoints = [], budget = { remaining: 8_000_000 };
        for (const path of paths) checkpoints.push(await createCheckpoint(path, before.get(path), after.get(path), workspaceRoot, budget));
        return checkpoints;
      };

      return Object.freeze({
        agentId: owner,
        workspaceRoot: worktreeRoot,
        isolationMode: linkedWorktree ? 'git-worktree' : 'private-snapshot',
        writeScopes: Object.freeze([...scopes]),
        merge,
        snapshot,
        close,
      });
    } catch (error) {
      lease.release();
      if (worktreeRoot && linkedWorktree) {
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
