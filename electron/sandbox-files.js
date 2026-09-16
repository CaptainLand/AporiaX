import { createRequire } from "node:module";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Electron must treat another app's ASAR archives as ordinary files.
export const sandboxFs = process.versions.electron ? createRequire(import.meta.url)("original-fs") : fs;
const { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, symlink } = sandboxFs.promises;
export const SNAPSHOT_MAX_BYTES = 2 * 1024 ** 3;
export const SNAPSHOT_MAX_FILES = 200_000;

export function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function checkAbort(signal) {
  if (signal?.aborted) throw Object.assign(new Error("Sandbox execution was interrupted."), { name: "AbortError" });
}

export async function hashSandboxFile(path, signal) {
  const hash = createHash("sha256");
  for await (const chunk of sandboxFs.createReadStream(path)) { checkAbort(signal); hash.update(chunk); }
  return hash.digest("hex");
}

export async function atomicJson(path, value) {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

// No junctions/hardlinks into host dependencies. Resolve internal package links
// into independent files; fail closed on outside links, cycles and copy limits.
export async function copyPrivateDependencies(source, destination, workspaceRoot, budget, signal, ancestors = new Set(), mapping = null) {
  checkAbort(signal);
  budget.entries = (budget.entries || 0) + 1;
  if (budget.entries > (budget.maxFiles ?? SNAPSHOT_MAX_FILES) || ancestors.size > 128) throw new Error("Dependency tree exceeds the entry/depth budget.");
  const path = await realpath(source);
  if (!inside(workspaceRoot, path)) throw new Error(`Dependency link escapes the workspace: ${source}`);
  const info = await lstat(path);
  if (ancestors.has(path)) throw new Error(`Dependency link cycle: ${source}`);
  const sourceInfo = await lstat(source);
  mapping ||= { source: path, destination };
  if (sourceInfo.isSymbolicLink() && inside(mapping.source, path) && path !== mapping.source) {
    // Preserve package-manager bin/module semantics, but point ONLY into the
    // private copy. Dereferencing a bin JS file would break its __dirname.
    const privateTarget = join(mapping.destination, relative(mapping.source, path));
    const linkTarget = process.platform === "win32" && info.isDirectory() ? privateTarget : relative(dirname(destination), privateTarget);
    await symlink(linkTarget, destination, info.isDirectory() ? process.platform === "win32" ? "junction" : "dir" : "file");
    return;
  }
  if (info.isDirectory()) {
    const next = new Set(ancestors); next.add(path);
    await mkdir(destination, { recursive: true });
    for (const name of await readdir(path)) await copyPrivateDependencies(join(path, name), join(destination, name), workspaceRoot, budget, signal, next, mapping);
  } else if (info.isFile()) {
    budget.files++; budget.bytes += info.size;
    if (budget.files > (budget.maxFiles ?? SNAPSHOT_MAX_FILES) || budget.bytes > (budget.maxBytes ?? SNAPSHOT_MAX_BYTES)) {
      throw new Error("Safe workspace copy exceeds the file/byte budget. Narrow the workspace or choose another execution profile.");
    }
    await copyFile(path, destination, sandboxFs.constants.COPYFILE_FICLONE);
  } else throw new Error(`Unsupported dependency file: ${source}`);
}

async function guardedPath(root, relativePath, { createParent = false } = {}) {
  const target = resolve(root, relativePath);
  if (!relativePath || !inside(root, target) || target === resolve(root)) throw new Error("Unsafe sandbox sync path.");
  let parent = resolve(root);
  const parts = relative(root, dirname(target)).split(sep).filter(Boolean);
  for (const part of parts) {
    parent = join(parent, part);
    if (createParent) await mkdir(parent).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(root, await realpath(parent))) throw new Error("Sandbox sync parent changed or escaped.");
  }
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Sandbox sync target is not a regular file.");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return target;
}

async function currentHash(root, path) {
  try { return await hashSandboxFile(await guardedPath(root, path)); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function replaceFile(source, target) {
  const temporary = join(dirname(target), `.aporiax-sync-${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary, sandboxFs.constants.COPYFILE_EXCL);
    const file = await open(temporary, "r+");
    try { await file.sync(); } finally { await file.close(); }
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

// Serialize AporiaX writers across worker processes. Never steal an active lock.
async function syncLock(root, locksDirectory) {
  await mkdir(locksDirectory, { recursive: true });
  const path = join(locksDirectory, createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex") + ".lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, "wx", 0o600);
      await file.writeFile(String(process.pid)); await file.close();
      return () => rm(path, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(await readFile(path, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Sandbox sync lock needs manual inspection.");
      try { process.kill(pid, 0); }
      catch (probe) { if (probe.code === "ESRCH" && attempt === 0) { await rm(path, { force: true }); continue; } }
      throw new Error("Another sandbox is synchronizing this workspace; output has been retained for recovery.");
    }
  }
}

export async function applySandboxChanges({ workspaceRoot, sandboxWorkspace, sandboxDirectory, baselineFiles, sandboxFiles, manifest, signal, beforeApply }) {
  const release = await syncLock(workspaceRoot, join(dirname(sandboxDirectory), ".locks"));
  const manifestPath = join(sandboxDirectory, "recovery.json");
  const changes = [...new Set([...baselineFiles.keys(), ...sandboxFiles.keys()])]
    .filter((path) => baselineFiles.get(path) !== sandboxFiles.get(path))
    .map((path) => ({ path, before: baselineFiles.get(path) ?? null, after: sandboxFiles.get(path) ?? null, state: "prepared" }));
  try {
    const conflicts = [];
    for (const change of changes) if (await currentHash(workspaceRoot, change.path) !== change.before) conflicts.push(change.path);
    if (conflicts.length) throw new Error(`Local sandbox did not apply changes because the original workspace changed during execution: ${conflicts.slice(0, 5).join(", ")}`);
    for (const change of changes) {
      checkAbort(signal);
      if (change.before !== null) {
        const backup = join(sandboxDirectory, "before", change.path);
        await mkdir(dirname(backup), { recursive: true });
        await copyFile(await guardedPath(workspaceRoot, change.path), backup);
        if (await hashSandboxFile(backup) !== change.before) throw new Error("Workspace changed while preparing sandbox backup.");
      }
      if (change.after !== null) {
        const pending = join(sandboxDirectory, "pending", change.path);
        await mkdir(dirname(pending), { recursive: true });
        await copyFile(await guardedPath(sandboxWorkspace, change.path), pending);
        if (await hashSandboxFile(pending) !== change.after) throw new Error("Sandbox output changed while preparing sync.");
      }
    }
    manifest.state = "applying"; manifest.changes = changes;
    await atomicJson(manifestPath, manifest);
    try {
      for (const change of changes) {
        checkAbort(signal);
        await beforeApply?.(change); // deterministic fault injection for disk/race regression tests
        if (await currentHash(workspaceRoot, change.path) !== change.before) throw new Error("Workspace changed immediately before sandbox writeback.");
        const target = await guardedPath(workspaceRoot, change.path, { createParent: true });
        change.state = "applying"; await atomicJson(manifestPath, manifest);
        if (change.after === null) await rm(target);
        else await replaceFile(join(sandboxDirectory, "pending", change.path), target);
        change.state = "applied"; await atomicJson(manifestPath, manifest);
      }
    } catch (error) {
      // Roll back only our exact writes, never a later user edit. Originals and
      // pending outputs remain in the recovery directory even if rollback fails.
      for (const change of [...changes].reverse().filter((item) => item.state !== "prepared")) {
        try {
          const now = await currentHash(workspaceRoot, change.path);
          if (now !== change.after) { change.state = now === change.before ? "rolled-back" : "manual-recovery"; continue; }
          const target = await guardedPath(workspaceRoot, change.path, { createParent: true });
          if (change.before === null) await rm(target, { force: true });
          else await replaceFile(join(sandboxDirectory, "before", change.path), target);
          change.state = "rolled-back";
        } catch { change.state = "manual-recovery"; }
      }
      manifest.state = "recovery-required";
      await atomicJson(manifestPath, manifest).catch(() => {});
      throw error;
    }
    return { written: changes.filter((item) => item.after !== null).length, deleted: changes.filter((item) => item.after === null).length, changed: changes.length };
  } finally { await release(); }
}
