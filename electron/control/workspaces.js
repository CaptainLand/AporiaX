import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createTwoFilesPatch } from "diff";
import { sameSnapshotIdentity } from "./file-identity.js";
export { sameSnapshotIdentity } from "./file-identity.js";

const OMIT = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".aporiax-control-output"]);
const MAX_FILES = 30_000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_PATCH_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_MS = 2000;
const inside = (root, path) => {
  const rel = relative(root, path);
  return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};
const abort = (signal) => { if (signal?.aborted) throw Object.assign(new Error("Workspace preparation cancelled."), { name: "AbortError" }); };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function canonicalDestination(path) {
  let ancestor = resolve(path);
  const suffix = [];
  while (true) {
    try { return join(await realpath(ancestor), ...suffix); }
    catch (error) {
      if (error.code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
      suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
}

async function readWorkspaceFile(root, path, { expected = null, signal } = {}) {
  abort(signal);
  const canonical = await realpath(path);
  if (!inside(root, canonical)) throw new Error("CONTROL_WORKSPACE_LINK: file escaped its workspace.");
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > MAX_BYTES) throw new Error("CONTROL_WORKSPACE_FILE: invalid or oversized workspace file.");
    if (expected && !sameSnapshotIdentity(before, expected, { pathVsHandle: true }))
      throw new Error("CONTROL_WORKSPACE_CHANGED: source changed while taking its snapshot.");
    // Read only the admitted size, even if another process keeps growing a file.
    const bytes = Buffer.allocUnsafe(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      abort(signal);
      const { bytesRead } = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (!bytesRead) throw new Error("CONTROL_WORKSPACE_CHANGED: file changed while being read.");
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true }), current = await lstat(canonical, { bigint: true });
    if (!current.isFile() || !sameSnapshotIdentity(before, after) || !sameSnapshotIdentity(before, current, { pathVsHandle: true }) || await realpath(path) !== canonical)
      throw new Error("CONTROL_WORKSPACE_CHANGED: file changed while being read.");
    abort(signal);
    return bytes;
  } finally { await handle.close(); }
}

async function git(cwd, args, signal) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key) && !["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_TERMINAL_PROMPT"].includes(key)) delete env[key];
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, ...args], { cwd, env, signal, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (value) => { stdout = (stdout + value).slice(-64_000); });
    child.stderr.on("data", (value) => { stderr = (stderr + value).slice(-8_000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveResult(stdout.trim()) : reject(Object.assign(new Error(`Git workspace preparation failed: ${stderr.trim()}`), { code: "CONTROL_WORKTREE_FAILED" })));
  });
}

async function copySnapshot(sourceRoot, destination, baselineRoot, signal) {
  const budget = { files: 0, bytes: 0 };
  async function copy(source, path, ancestors = new Set()) {
    abort(signal);
    const canonical = await realpath(source);
    if (!inside(sourceRoot, canonical) || ancestors.has(canonical) || ancestors.size > 100) throw new Error("CONTROL_WORKSPACE_LINK: workspace link escapes its root or forms a cycle.");
    const info = await lstat(canonical, { bigint: true });
    if (info.isDirectory()) {
      const next = new Set(ancestors); next.add(canonical);
      await mkdir(join(destination, path), { recursive: true });
      await mkdir(join(baselineRoot, path), { recursive: true });
      for (const name of await readdir(canonical)) if (!OMIT.has(name)) await copy(join(canonical, name), join(path, name), next);
      return;
    }
    if (!info.isFile()) throw new Error("CONTROL_WORKSPACE_FILE: only regular workspace files can be copied.");
    budget.files++; budget.bytes += Number(info.size);
    if (budget.files > MAX_FILES || budget.bytes > MAX_BYTES) throw new Error("CONTROL_WORKSPACE_LIMIT: narrow the workspace (30,000 files / 256 MiB snapshot limit).");
    // Copy regular, resolved files. Never preserve links into the source workspace.
    const bytes = await readWorkspaceFile(sourceRoot, canonical, { expected: info, signal });
    await writeFile(join(destination, path), bytes, { mode: Number(info.mode) & 0o777, flag: "wx" });
    await writeFile(join(baselineRoot, path), bytes, { mode: 0o600, flag: "wx" });
  }
  await copy(sourceRoot, "");
  return budget;
}

/** External writers work on retained copies; this function never writes source files. */
export async function prepareControlWorkspace({ sourcePath, dataDirectory, runId, writable = false, signal } = {}) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId || "")) throw new Error("Invalid external run id.");
  const sourceRoot = await realpath(resolve(sourcePath));
  if (!(await lstat(sourceRoot)).isDirectory()) throw new Error("Workspace must be a directory.");
  abort(signal);
  if (!writable) return { workspacePath: sourceRoot, workspace: { mode: "read-only", sourcePath: sourceRoot, path: sourceRoot, mergeRequired: false } };
  const dataRoot = await canonicalDestination(dataDirectory);
  const container = join(dataRoot, "local-control-workspaces");
  if (inside(sourceRoot, container)) throw new Error("CONTROL_WORKSPACE_ROOT: choose a project directory that does not contain AporiaX application data.");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await mkdir(container, { recursive: true, mode: 0o700 });
  if (await realpath(container) !== container) throw new Error("CONTROL_WORKSPACE_ROOT: task storage directory must not be a symbolic link.");
  const directory = join(container, runId);
  const workspacePath = join(directory, "workspace"), baselineRoot = join(directory, "baseline");
  // Never reuse a retained run directory: it may contain user-created links or
  // an existing task's patch/baseline. Idempotency is handled before preparation.
  await mkdir(directory, { mode: 0o700 });
  let repositoryRoot = "", baseCommit = "", worktreeCreated = false;
  try {
    // No checkout: repository smudge filters and post-checkout hooks are not run.
    try {
      repositoryRoot = await git(sourceRoot, ["rev-parse", "--show-toplevel"], signal);
      if (await realpath(repositoryRoot) !== sourceRoot) repositoryRoot = "";
      if (repositoryRoot) baseCommit = await git(sourceRoot, ["rev-parse", "--verify", "HEAD"], signal);
    } catch (error) { if (signal?.aborted) throw error; repositoryRoot = ""; }
    if (repositoryRoot) {
      await git(sourceRoot, ["worktree", "add", "--detach", "--no-checkout", workspacePath, baseCommit], signal);
      worktreeCreated = true;
      await git(workspacePath, ["reset", "--mixed", baseCommit], signal);
    }
    await mkdir(workspacePath, { recursive: true, mode: 0o700 });
    await mkdir(baselineRoot, { recursive: true, mode: 0o700 });
    const snapshot = await copySnapshot(sourceRoot, workspacePath, baselineRoot, signal);
    const workspace = { mode: worktreeCreated ? "worktree" : "snapshot", sourcePath: sourceRoot, path: workspacePath,
      baseCommit: baseCommit || null, mergeRequired: true, retained: true, snapshot,
      excludedDirectories: [...OMIT], description: "Changes remain in this task workspace; the original project is not updated automatically." };
    await writeFile(join(directory, "workspace.json"), JSON.stringify(workspace, null, 2), { mode: 0o600 });
    return { workspacePath, workspace, baselineRoot };
  } catch (error) {
    if (repositoryRoot) await git(sourceRoot, ["worktree", "remove", "--force", workspacePath]).catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function inventory(root) {
  const files = new Map();
  let bytes = 0;
  async function walk(path = "", depth = 0) {
    if (depth > 100) throw new Error("Output workspace is too deep.");
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      if (OMIT.has(entry.name)) continue;
      const key = join(path, entry.name), full = join(root, key), info = await lstat(full, { bigint: true });
      if (info.isSymbolicLink()) continue; // An output link is never a downloadable file.
      if (!inside(root, await realpath(full))) throw new Error("Output path escaped its workspace.");
      if (info.isDirectory()) await walk(key, depth + 1);
      else if (info.isFile()) {
        if (files.size >= MAX_FILES || (bytes += Number(info.size)) > MAX_BYTES) throw new Error("Output exceeds the workspace inventory limit.");
        const value = await readWorkspaceFile(root, full, { expected: info });
        files.set(key, { hash: hash(value), bytes: value.length });
      }
    }
  }
  await walk(); return files;
}

/** Retained patch and manifest are relative to the initial copy, including dirty source files. */
export async function finalizeControlWorkspace(handle, result) {
  if (!handle?.baselineRoot) return { ...result, workspace: handle?.workspace };
  const value = { ...result, workspace: handle.workspace };
  try {
    const before = await inventory(handle.baselineRoot), after = await inventory(handle.workspacePath);
    const changes = [], parts = []; let patchBytes = 0;
    const patchDeadline = Date.now() + MAX_DIFF_MS;
    for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const left = before.get(path), right = after.get(path);
      if (left?.hash === right?.hash) continue;
      const change = { path: path.split(sep).join("/"), status: !left ? "added" : !right ? "deleted" : "modified", beforeHash: left?.hash || null, afterHash: right?.hash || null, bytes: right?.bytes || 0 };
      changes.push(change);
      if ((left?.bytes || 0) + (right?.bytes || 0) > 2 * 1024 * 1024 || patchBytes >= MAX_PATCH_BYTES || Date.now() >= patchDeadline) {
        change.patchOmitted = true; change.patchOmittedReason = "size_or_time_limit"; continue;
      }
      const a = left ? await readWorkspaceFile(handle.baselineRoot, join(handle.baselineRoot, path)) : Buffer.alloc(0);
      const b = right ? await readWorkspaceFile(handle.workspacePath, join(handle.workspacePath, path)) : Buffer.alloc(0);
      if ((left && hash(a) !== left.hash) || (right && hash(b) !== right.hash)) throw new Error("Workspace changed while its patch was being generated.");
      if (!isUtf8(a) || !isUtf8(b) || a.includes(0) || b.includes(0)) { change.patchOmitted = true; change.patchOmittedReason = "binary"; continue; }
      const patch = createTwoFilesPatch(left ? `a/${change.path}` : "/dev/null", right ? `b/${change.path}` : "/dev/null", a.toString("utf8"), b.toString("utf8"), undefined, undefined,
        { timeout: Math.min(250, Math.max(1, patchDeadline - Date.now())), maxEditLength: 20_000 });
      if (patch === undefined) { change.patchOmitted = true; change.patchOmittedReason = "diff_limit"; continue; }
      if (patchBytes + Buffer.byteLength(patch) > MAX_PATCH_BYTES) { change.patchOmitted = true; change.patchOmittedReason = "patch_size_limit"; continue; }
      parts.push(patch); patchBytes += Buffer.byteLength(patch);
    }
    const out = join(handle.workspacePath, ".aporiax-control-output");
    try { const info = await lstat(out); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Output manifest directory was replaced."); }
    catch (error) { if (error.code !== "ENOENT") throw error; await mkdir(out, { mode: 0o700 }); }
    // Replace a malicious existing output symlink rather than following it.
    for (const name of ["changes.patch", "manifest.json"]) await rm(join(out, name), { force: true });
    await writeFile(join(out, "changes.patch"), parts.join("\n"), { mode: 0o600, flag: "wx" });
    await writeFile(join(out, "manifest.json"), JSON.stringify({ workspace: handle.workspace, changes, patchComplete: changes.every(x => !x.patchOmitted) }, null, 2), { mode: 0o600, flag: "wx" });
    value.workspaceChanges = changes;
    value.artifacts = [...(Array.isArray(result?.artifacts) ? result.artifacts : []),
      { name: "changes.patch", path: ".aporiax-control-output/changes.patch", mimeType: "text/x-diff" },
      { name: "manifest.json", path: ".aporiax-control-output/manifest.json", mimeType: "application/json" },
      ...changes.filter(x => x.status !== "deleted").slice(0, 100).map(x => ({ name: x.path, path: x.path }))];
    if (changes.some(x => x.patchOmitted)) value.risks = [...(Array.isArray(result?.risks) ? result.risks : []), "Some binary/large or costly file changes are available as files but omitted from the text patch. See manifest.json."];
  } catch (error) {
    value.risks = [...(Array.isArray(result?.risks) ? result.risks : []), `Workspace retained, but output manifest needs inspection: ${error.message}`];
  }
  return value;
}
