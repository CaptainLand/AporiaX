import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { runtimeRunState } from './durable-run.js';
import { filePathInside, verifyNativeFileTarget } from './file-access-policy.js';
import { mutateWorkspaceFiles } from './workspace-mutations.js';

const scriptExtensions = new Set(['.js', '.mjs', '.cjs', '.py', '.ps1', '.sh', '.bat', '.cmd']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const refused = reason => Object.assign(new Error(`TEMPORARY_CHECK_REFUSED: ${reason}`), { code: 'TEMPORARY_CHECK_REFUSED' });
const ledger = () => runtimeRunState('temporary-check-files', () => new Map());

export async function validateTemporaryCheckCreation(workspaceRoot, path, { created, content } = {}) {
  if (!ledger()) throw refused('Temporary scripts require an active task.');
  const root = await realpath(workspaceRoot);
  const target = await verifyNativeFileTarget(root, path, { writable: true });
  if (!created || !filePathInside(root, target) || target === root) throw refused('Only a newly created workspace file can be registered.');
  if (!scriptExtensions.has(extname(target).toLowerCase()) || typeof content !== 'string' || content.length > 100_000) throw refused('Only a small temporary self-check script can be registered.');
  return target;
}

export async function registerTemporaryCheck(workspaceRoot, path, content) {
  const root = await realpath(workspaceRoot);
  const target = await verifyNativeFileTarget(root, path, { writable: true });
  const records = ledger();
  if (!records || !filePathInside(root, target)) throw refused('No active task registration scope.');
  const info = await lstat(target), bytes = await readFile(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || hash(bytes) !== hash(Buffer.from(content))) throw refused('File changed before registration.');
  records.set(target, { root, hash: hash(bytes), dev: info.dev, ino: info.ino });
}

/** No model-supplied registration receipt, filename guess, recursive rm, or shell.
 * Registry lives only in trusted task memory; after a restart the exemption is
 * lost rather than trusting model history to reconstruct deletion authority.
 */
export async function cleanupTemporaryCheck(workspaceRoot, path, { signal } = {}) {
  const root = await realpath(workspaceRoot);
  const target = await verifyNativeFileTarget(root, path, { writable: true });
  const record = ledger()?.get(target);
  if (!record || record.root !== root || !filePathInside(root, target)) throw refused('File was not registered by this active task.');
  const info = await lstat(target), bytes = await readFile(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.dev !== record.dev || info.ino !== record.ino || hash(bytes) !== record.hash) throw refused('Registered script was modified or replaced; automatic cleanup is not allowed.');
  signal?.throwIfAborted();
  await mutateWorkspaceFiles({ workspaceRoot: root, signal, edits: [{ path: target, before: bytes, after: null }] });
  ledger().delete(target);
  return { path, deleted: true, recoverable: true, beforeContent: bytes.toString('utf8') };
}
