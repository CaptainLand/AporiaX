import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => Boolean(a?.missing) === Boolean(b?.missing) && (a?.missing || a?.hash === b?.hash);
const absent = () => ({ missing: true, hash: null, content: null });

// This is conflict protection, not an OS sandbox. Refuse symlink/directory
// substitutions and never recursively delete a merge target.
async function targetPath(root, path) {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Invalid merge path: ${path}`);
  if (await fs.realpath(root) !== root) throw new Error("Builder workspace root changed.");
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink() || (current === target ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`Merge path changed type: ${path}`);
    }
  }
  return target;
}

async function stateAt(target) {
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular merge target: ${target}`);
    const content = await fs.readFile(target);
    return { missing: false, hash: digest(content), content, mode: stat.mode & 0o777 };
  } catch (error) { if (error.code === "ENOENT") return absent(); throw error; }
}

// Stage next to the destination, flush, then rename. Never truncate the live
// target and never fall back to unlink + copy when rename fails on Windows.
async function atomicWrite(target, content, { mode = 0o600, beforeReplace } = {}) {
  const temporary = join(dirname(target), `.${basename(target)}.aporiax-${randomUUID()}.tmp`);
  let handle;
  let owned = false;
  try {
    handle = await fs.open(temporary, "wx", mode);
    owned = true;
    await handle.writeFile(content);
    if (process.platform !== "win32") await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = null;
    await beforeReplace?.();
    await fs.rename(temporary, target);
    owned = false;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (owned) {
      try { await fs.rm(temporary, { force: true }); }
      catch (cleanupError) { error.temporaryFile = temporary; error.cleanupError = cleanupError.message; }
    }
    throw error;
  }
}

async function replaceState(root, path, desired, expected) {
  const target = await targetPath(root, path);
  const assertUnchanged = async () => {
    await targetPath(root, path);
    if (!same(await stateAt(target), expected)) throw new Error(`Merge target changed concurrently: ${path}`);
  };
  await assertUnchanged();
  if (desired.missing) {
    await fs.rm(target, { force: true });
  } else {
    await fs.mkdir(dirname(target), { recursive: true });
    await targetPath(root, path);
    await atomicWrite(target, desired.content, { mode: expected.mode ?? desired.mode ?? 0o644, beforeReplace: assertUnchanged });
  }
}

export async function mergeBuilderFiles({ workspaceRoot, paths, before, after, recoveryRoot, onPrepared, emit, signal }) {
  const root = await fs.realpath(workspaceRoot);
  const recoveryDirectory = await fs.mkdtemp(join(recoveryRoot, "merge-recovery-"));
  const manifestPath = join(recoveryDirectory, "manifest.json");
  const manifest = {
    version: 1, workspaceRoot: root, createdAt: new Date().toISOString(), status: "preparing",
    entries: paths.map((path, index) => ({ path, beforeHash: before.get(path)?.hash ?? null,
      beforeMissing: before.get(path)?.missing ?? true, afterHash: after.get(path)?.hash ?? null,
      afterMissing: after.get(path)?.missing ?? true, backup: `${index}.before`, state: "planned" })),
  };
  const summary = () => ({ manifestPath, status: manifest.status,
    affected: manifest.entries.filter(e => e.state !== "planned").map(e => e.path),
    restored: manifest.entries.filter(e => e.state === "restored").map(e => e.path),
    unresolved: manifest.status === "committed" ? [] : manifest.entries.filter(e => ["rollback-failed", "conflict", "attempted", "applied"].includes(e.state)).map(e => e.path),
    ...(manifest.recordError ? { recordError: manifest.recordError } : {}),
  });
  const save = () => atomicWrite(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2)));
  const attempted = [];
  try {
    // All originals are on disk BEFORE any destination is touched.
    for (const entry of manifest.entries) {
      const original = before.get(entry.path) || absent();
      const current = await stateAt(await targetPath(root, entry.path));
      if (!same(current, original)) throw new Error(`Merge target changed concurrently: ${entry.path}`);
      entry.beforeMode = current.mode;
      if (!original.missing) await atomicWrite(join(recoveryDirectory, entry.backup), original.content);
    }
    manifest.status = "prepared";
    await save();
    await onPrepared?.(summary());
    for (const entry of manifest.entries) {
      signal?.throwIfAborted();
      // A crash at/after replacement leaves an inspectable intent, even if the
      // following journal write never happens.
      entry.state = "attempted";
      attempted.push(entry);
      manifest.status = "applying";
      await save();
      await replaceState(root, entry.path, after.get(entry.path) || absent(), {
        ...(before.get(entry.path) || absent()), mode: entry.beforeMode,
      });
      entry.state = "applied";
      await save();
    }
    manifest.status = "committed";
    await save();
    return summary();
  } catch (cause) {
    manifest.status = "rolling-back";
    manifest.error = String(cause.message || cause);
    if (cause.temporaryFile) manifest.temporaryFile = cause.temporaryFile;
    for (const entry of [...attempted].reverse()) {
      const original = { ...(before.get(entry.path) || absent()), mode: entry.beforeMode };
      const desired = after.get(entry.path) || absent();
      try {
        const current = await stateAt(await targetPath(root, entry.path));
        if (!same(current, original)) {
          // Never roll back over a later human/other-process modification.
          if (!same(current, desired)) {
            entry.state = "conflict";
            entry.rollbackError = "Target no longer matches either recorded version; newer content was preserved.";
            continue;
          }
          await replaceState(root, entry.path, original, current);
        }
        entry.state = "restored";
      } catch (error) {
        entry.state = "rollback-failed";
        entry.rollbackError = String(error.message || error);
        if (error.temporaryFile) entry.temporaryFile = error.temporaryFile;
      }
    }
    manifest.status = summary().unresolved.length ? "recovery-required" : "rolled-back";
    try { await save(); } catch (error) { manifest.recordError = String(error.message || error); }
    const recovery = summary();
    const detail = recovery.unresolved.length
      ? `未恢复文件：${recovery.unresolved.join(", ")}。请先核对文件，不要直接重复合并。`
      : "本次已尝试的文件均已恢复或保持原样。";
    const error = Object.assign(new Error(
      `BUILDER_MERGE_FAILED: ${cause.message || cause}。${detail} 恢复记录：${manifestPath}${recovery.recordError ? "（记录更新失败，请按实际文件核对）" : ""}`,
      { cause }), { code: "BUILDER_MERGE_FAILED", mergeRecovery: recovery });
    try { emit?.({ type: "builder.merge.failed", error: error.message, recovery }); } catch { /* observers cannot replace the recovery error */ }
    throw error;
  }
}
