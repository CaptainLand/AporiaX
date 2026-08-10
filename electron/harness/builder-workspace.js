import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  ScopeLeaseManager,
  normalizeBuilderScopes,
  pathInsideScopes,
} from "./scope-leases.js";

const SNAPSHOT_MAX_FILES = 800;
const SNAPSHOT_MAX_BYTES = 24_000_000;
const SNAPSHOT_MAX_FILE_BYTES = 2_000_000;
const DIR_IGNORES = new Set([".git", "node_modules", "dist", "release", "coverage"]);

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

async function readFileState(root, path) {
  const absolute = resolve(root, ...String(path).split("/"));
  try {
    const stats = await lstat(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return { missing: true, hash: null, content: null };
    }
    if (stats.size > SNAPSHOT_MAX_FILE_BYTES) {
      throw new Error(
        `Builder scoped file exceeds ${SNAPSHOT_MAX_FILE_BYTES} bytes: ${path}`,
      );
    }
    const content = await readFile(absolute);
    return { missing: false, hash: hashBuffer(content), content };
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

async function captureScope(root, scopes) {
  const files = new Map();
  let totalBytes = 0;

  const captureFile = async (absolutePath) => {
    if (files.size >= SNAPSHOT_MAX_FILES) {
      throw new Error(`Builder scope snapshot exceeds ${SNAPSHOT_MAX_FILES} files.`);
    }
    const stats = await lstat(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return;
    if (stats.size > SNAPSHOT_MAX_FILE_BYTES) {
      throw new Error(
        `Builder scoped file exceeds ${SNAPSHOT_MAX_FILE_BYTES} bytes: ${normalizedRelative(root, absolutePath)}`,
      );
    }
    totalBytes += stats.size;
    if (totalBytes > SNAPSHOT_MAX_BYTES) {
      throw new Error(
        `Builder scope snapshot exceeds ${SNAPSHOT_MAX_BYTES} total bytes.`,
      );
    }
    const content = await readFile(absolutePath);
    files.set(normalizedRelative(root, absolutePath), {
      missing: false,
      hash: hashBuffer(content),
      content,
    });
  };

  const walk = async (absolutePath) => {
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
    .map((value) => value.trim())
    .filter(Boolean);
}

async function overlayDirtyWorkspace(workspaceRoot, worktreeRoot) {
  const [unstaged, staged, untracked] = await Promise.all([
    runGit(["diff", "--name-only", "-z", "HEAD"], workspaceRoot),
    runGit(["diff", "--cached", "--name-only", "-z", "HEAD"], workspaceRoot),
    runGit(["ls-files", "--others", "--exclude-standard", "-z"], workspaceRoot),
  ]);
  const paths = new Set([
    ...splitNull(unstaged.stdout),
    ...splitNull(staged.stdout),
    ...splitNull(untracked.stdout),
  ]);
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

export class BuilderWorkspaceManager {
  #leases;
  #eventBus;

  constructor({ eventBus = null, leases = null } = {}) {
    this.#eventBus = eventBus;
    this.#leases = leases || new ScopeLeaseManager();
  }

  leases() {
    return this.#leases.list();
  }

  async open({ workspaceRoot, agentId, writeScopes }) {
    const owner = String(agentId || "").trim();
    if (!owner) throw new Error("Builder agentId is required.");
    const scopes = normalizeBuilderScopes(writeScopes);
    const lease = this.#leases.acquire(owner, scopes);
    let baseDirectory = null;
    let worktreeRoot = null;
    try {
      await ensureGitWorkspace(workspaceRoot);
      baseDirectory = await mkdtemp(join(tmpdir(), "aporiax-builder-"));
      worktreeRoot = join(baseDirectory, "workspace");
      await runGit(
        ["worktree", "add", "--detach", worktreeRoot, "HEAD"],
        workspaceRoot,
      );
      await overlayDirtyWorkspace(workspaceRoot, worktreeRoot);
      const baseline = await captureScope(workspaceRoot, scopes);
      this.#eventBus?.emit({
        type: "builder.workspace.created",
        agentId: owner,
        writeScopes: scopes,
      });

      let closed = false;
      const close = async () => {
        if (closed) return;
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

      const merge = async () => {
        if (closed) throw new Error("Builder workspace is already closed.");
        const after = await captureScope(worktreeRoot, scopes);
        const paths = changedPaths(baseline, after);
        for (const path of paths) {
          if (!pathInsideScopes(path, scopes)) {
            throw new Error(
              `Builder produced a change outside its lease: ${path}`,
            );
          }
        }

        const conflicts = [];
        const currentStates = new Map();
        for (const path of paths) {
          const current = await readFileState(workspaceRoot, path);
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
          return { merged: false, conflicts, changes: [] };
        }

        const applied = [];
        try {
          for (const path of paths) {
            const next =
              after.get(path) || {
                missing: true,
                hash: null,
                content: null,
              };
            const target = resolve(workspaceRoot, ...path.split("/"));
            if (next.missing) {
              await rm(target, { recursive: true, force: true });
            } else {
              await mkdir(dirname(target), { recursive: true });
              await writeFile(target, next.content);
            }
            applied.push(path);
          }
        } catch (error) {
          for (const path of applied.reverse()) {
            const previous =
              currentStates.get(path) || { missing: true, content: null };
            const target = resolve(workspaceRoot, ...path.split("/"));
            if (previous.missing) {
              await rm(target, { recursive: true, force: true }).catch(
                () => undefined,
              );
            } else {
              await mkdir(dirname(target), { recursive: true }).catch(
                () => undefined,
              );
              await writeFile(target, previous.content).catch(
                () => undefined,
              );
            }
          }
          throw error;
        }

        const changes = paths.map((path) => ({
          path,
          created: !after.get(path)?.missing && !baseline.has(path),
          deleted: !baseline.get(path)?.missing && !after.has(path),
        }));
        this.#eventBus?.emit({
          type: "builder.merge.completed",
          agentId: owner,
          writeScopes: scopes,
          changes,
        });
        return { merged: true, conflicts: [], changes };
      };

      return Object.freeze({
        agentId: owner,
        workspaceRoot: worktreeRoot,
        writeScopes: Object.freeze([...scopes]),
        merge,
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