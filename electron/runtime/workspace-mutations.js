import { mkdir, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeBuilderFiles } from '../harness/builder-merge.js';
import { serializeStorage } from '../storage/atomic-file.js';
import { runtimeRecoveryDirectory, saveRuntimeCheckpoint } from './durable-run.js';

const state = (bytes) => bytes == null ? { missing: true, hash: null, content: null }
  : { missing: false, content: Buffer.from(bytes), hash: createHash('sha256').update(bytes).digest('hex') };
/** Shared recoverable commit primitive. No claim of an OS-level multi-file transaction. */
export async function mutateWorkspaceFiles({ workspaceRoot, edits, signal, recoveryDirectory, onPrepared, emit }) {
  workspaceRoot = await realpath(workspaceRoot);
  if (!Array.isArray(edits) || !edits.length || edits.length > 1200) throw new Error('Invalid mutation batch.');
  const paths = [], before = new Map(), after = new Map(), seen = new Set();
  for (const edit of edits) {
    const path = relative(resolve(workspaceRoot), resolve(workspaceRoot, edit.path)).replaceAll('\\', '/');
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
