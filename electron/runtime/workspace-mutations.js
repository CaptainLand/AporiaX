import { mkdir, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, relative, isAbsolute, dirname, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeBuilderFiles } from '../harness/builder-merge.js';
import { serializeStorage } from '../storage/atomic-file.js';
import { runtimeRecoveryDirectory, saveRuntimeCheckpoint } from './durable-run.js';
import { filePathInside, nativeFilePath, nativeMutationScope, verifyNativeFileTarget } from './file-access-policy.js';

const state = (bytes) => bytes == null ? { missing: true, hash: null, content: null }
  : { missing: false, content: Buffer.from(bytes), hash: createHash('sha256').update(bytes).digest('hex') };
/** Shared recoverable commit primitive. No claim of an OS-level multi-file transaction. */
export async function mutateWorkspaceFiles({ workspaceRoot, edits, signal, recoveryDirectory, onPrepared, emit }) {
  const scoped = nativeMutationScope(workspaceRoot);
  workspaceRoot = await realpath(workspaceRoot);
  if (!Array.isArray(edits) || !edits.length || edits.length > 1200) throw new Error('Invalid mutation batch.');
  const originalRoot = workspaceRoot;
  const targets = [];
  for (const edit of edits) {
    const target = nativeFilePath(originalRoot, edit.path);
    if (!filePathInside(originalRoot, target) && !scoped) throw new Error('Invalid mutation path: external mutations require native file authorization.');
    targets.push(scoped ? await verifyNativeFileTarget(originalRoot, target, { writable: true }) : target);
  }
  if (targets.some(target => !filePathInside(originalRoot, target))) {
    workspaceRoot = dirname(targets[0]);
    for (const target of targets) {
      if (parse(target).root.toLowerCase() !== parse(workspaceRoot).root.toLowerCase()) throw new Error('Apply external multi-file changes one filesystem volume at a time.');
      while (!filePathInside(workspaceRoot, target)) workspaceRoot = dirname(workspaceRoot);
    }
    // New nested output directories may not exist yet. Use their real ancestor.
    while (true) {
      try { workspaceRoot = await realpath(workspaceRoot); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; workspaceRoot = dirname(workspaceRoot); }
    }
  }
  const paths = [], before = new Map(), after = new Map(), seen = new Set();
  for (const [index, edit] of edits.entries()) {
    const path = relative(resolve(workspaceRoot), targets[index]).replaceAll('\\', '/');
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (!path || isAbsolute(path) || path === '..' || path.startsWith('../') || seen.has(key)) throw new Error('Invalid or duplicate mutation path.');
    seen.add(key); paths.push(path); before.set(path, state(edit.before)); after.set(path, state(edit.after));
  }
  const directory = recoveryDirectory || runtimeRecoveryDirectory() || join(tmpdir(), 'aporiax-workspace-recovery');
  await mkdir(directory, { recursive: true });
  return serializeStorage(workspaceRoot, async () => {
    signal?.throwIfAborted();
    const id = randomUUID();
    const result = await mergeBuilderFiles({ workspaceRoot, paths, before, after, recoveryRoot: directory, signal, emit,
      beforeApply: scoped ? async path => {
        signal?.throwIfAborted();
        await verifyNativeFileTarget(originalRoot, resolve(workspaceRoot, path), { writable: true });
      } : undefined,
      onPrepared: async (recovery) => {
        await saveRuntimeCheckpoint({ scopeId: `mutation:${id}`, phase: 'mutation-prepared', recovery });
        await onPrepared?.(recovery);
      } });
    // Keep recovery until its commit is durable. A storage failure preserves the
    // backups even though host content may already be updated.
    await saveRuntimeCheckpoint({ scopeId: `mutation:${id}`, phase: 'mutation-committed', recovery: result });
    return result;
  });
}
