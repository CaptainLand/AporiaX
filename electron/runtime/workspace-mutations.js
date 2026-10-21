import { mkdir, realpath, lstat, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, relative, isAbsolute, dirname, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeBuilderFiles } from '../harness/builder-merge.js';
import { serializeStorage } from '../storage/atomic-file.js';
import { runtimeRecoveryDirectory, saveRuntimeCheckpoint } from './durable-run.js';
import { filePathInside, nativeFilePath, nativeMutationScope, verifyNativeFileTarget } from './file-access-policy.js';
import { hashFile } from '../storage/file-state.js';

const state = (bytes) => bytes == null ? { missing: true, hash: null, content: null }
  : bytes.filePath ? { missing: false, hash: bytes.sha256, content: { filePath: bytes.filePath }, mode: bytes.mode }
  : { missing: false, content: Buffer.from(bytes), hash: createHash('sha256').update(bytes).digest('hex') };
const inlineSnapshotBytes = 128_000;
let configuredRecoveryDirectory = () => join(tmpdir(), 'aporiax-workspace-recovery');
const trustedRecoveryRoots = new Set();
// Main-process configuration only, not exposed to tools or renderer requests.
export function configureWorkspaceRecoveryDirectory(readDirectory) { configuredRecoveryDirectory = readDirectory; }

// Capture the approved version locally, even if the model only supplies a path.
// Repeated inspection after approval prevents deletion of newer human edits.
export async function prepareFileDeletion(workspaceRoot, input, { signal } = {}) {
  if (typeof input.path !== 'string' || /[*?]/.test(input.path)) throw new Error('DELETE_TARGET_INVALID: use one exact file path, never a glob.');
  const filePath = await verifyNativeFileTarget(workspaceRoot, input.path, { writable: true });
  if (!filePathInside(workspaceRoot, filePath) || filePath === resolve(workspaceRoot)) throw new Error('FILE_ACCESS_DENIED: delete_file cannot delete external files or the workspace root.');
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('DELETE_TARGET_INVALID: expected one regular workspace file. Directories and links are not supported.');
  const { sha256, bytes, content: inline } = await hashFile(filePath, { signal, captureBytes: inlineSnapshotBytes });
  let beforeContent = '', binary = true, previous = { filePath, sha256, bytes };
  if (inline) {
    const buffer = inline;
    try {
      beforeContent = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
      if (beforeContent.includes('\0')) throw new Error('binary');
      binary = false; previous = buffer;
    } catch { beforeContent = ''; }
  }
  if (input.expected_sha256 !== undefined && (typeof input.expected_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.expected_sha256) || sha256 !== input.expected_sha256.toLowerCase())) throw new Error('DELETE_PRECONDITION_FAILED: file changed; inspect it again before deleting.');
  return { filePath, previous, beforeContent, binary, sha256, bytes, fileBacked: !Buffer.isBuffer(previous) };
}

export async function inspectWorkspaceSnapshot(workspaceRoot, path, snapshot) {
  if (!snapshot || typeof snapshot.manifestPath !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.sha256 || '')) throw new Error('Invalid file snapshot reference.');
  const manifestPath = resolve(snapshot.manifestPath);
  const roots = [...trustedRecoveryRoots, resolve(configuredRecoveryDirectory())];
  const owner = roots.find(root => filePathInside(root, manifestPath) && manifestPath !== root);
  if (!owner || await realpath(manifestPath) !== manifestPath || !filePathInside(await realpath(owner), manifestPath)) throw new Error('File snapshot is outside trusted recovery storage.');
  if ((await lstat(manifestPath)).size > 1_000_000) throw new Error('Invalid recovery manifest size.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const canonicalRoot = await realpath(workspaceRoot), target = nativeFilePath(canonicalRoot, path);
  const entry = manifest.entries?.find(item => nativeFilePath(canonicalRoot, item.path) === target);
  if (manifest.version !== 1 || manifest.workspaceRoot !== canonicalRoot || manifest.status !== 'committed' ||
      !entry || entry.beforeMissing || !entry.afterMissing || entry.beforeHash !== snapshot.sha256 || !/^\d+\.before$/.test(entry.backup)) throw new Error('Snapshot does not match this workspace deletion.');
  const backup = join(dirname(manifestPath), entry.backup);
  if (await realpath(backup) !== backup || !(await lstat(backup)).isFile()) throw new Error('Invalid snapshot backup.');
  const actual = await hashFile(backup);
  if (actual.sha256 !== snapshot.sha256) throw new Error('File snapshot checksum mismatch; no file was restored.');
  return { filePath: backup, sha256: actual.sha256, bytes: actual.bytes, mode: entry.beforeMode };
}

export async function restoreWorkspaceSnapshot(workspaceRoot, path, snapshot, { expectedMissing = true, expectedHash = null } = {}) {
  const source = await inspectWorkspaceSnapshot(workspaceRoot, path, snapshot);
  const target = await verifyNativeFileTarget(workspaceRoot, path, { writable: true });
  if (!filePathInside(workspaceRoot, target)) throw new Error('Snapshot restore cannot leave its workspace.');
  let previous = null;
  try { previous = { filePath: target, ...await hashFile(target) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (expectedMissing ? previous !== null : previous === null || previous.sha256 !== expectedHash) throw new Error('DELETE_RESTORE_CONFLICT: file changed after restore preflight; newer content was preserved.');
  return mutateWorkspaceFiles({ workspaceRoot, edits: [{ path: target, before: previous, after: source }] });
}
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
  const directory = recoveryDirectory || runtimeRecoveryDirectory() || configuredRecoveryDirectory();
  trustedRecoveryRoots.add(resolve(directory));
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
