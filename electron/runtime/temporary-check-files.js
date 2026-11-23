import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname } from 'node:path';
import { runtimeRunState } from './durable-run.js';
import { filePathInside, verifyNativeFileTarget } from './file-access-policy.js';
import { mutateWorkspaceFiles } from './workspace-mutations.js';

const temporaryCheckExtensions = new Set(['.js', '.mjs', '.cjs', '.py', '.ps1', '.sh', '.bat', '.cmd', '.html', '.htm']);
const maxTemporaryCheckBytes = 100_000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const refused = (reason, message) => Object.assign(new Error(`TEMPORARY_CHECK_REFUSED: ${reason}: ${message}`), { code: 'TEMPORARY_CHECK_REFUSED', reason });
const ledger = () => runtimeRunState('temporary-check-files', () => new Map());

function validateTemporaryCheckContent(target, content) {
  const extension = extname(target).toLowerCase();
  if (!temporaryCheckExtensions.has(extension)) throw refused('UNSUPPORTED_FILE_TYPE', `File type ${extension || '(no extension)'} cannot be registered. Supported temporary self-check scripts and HTML test pages: ${[...temporaryCheckExtensions].join(', ')}.`);
  if (typeof content !== 'string') throw refused('INVALID_CONTENT', 'Temporary self-check content must be a UTF-8 text string.');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > maxTemporaryCheckBytes) throw refused('CONTENT_TOO_LARGE', `Temporary self-check content is ${bytes} UTF-8 bytes; the registration limit is ${maxTemporaryCheckBytes} bytes.`);
}

export async function prepareTemporaryCheckUpdate(workspaceRoot, path, before) {
  const records = ledger();
  if (!records?.size) return null;
  const root = await realpath(workspaceRoot), target = await verifyNativeFileTarget(root, path, { writable: true });
  const record = records.get(target);
  if (!record || record.root !== root || hash(Buffer.from(before || '')) !== record.hash) return null;
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.dev !== record.dev || info.ino !== record.ino) return null;
  return { ...record, target };
}

export async function completeTemporaryCheckUpdate(receipt, after) {
  if (!receipt) return false;
  const records = ledger();
  if (records?.get(receipt.target)?.hash !== receipt.hash) return false;
  // A tracked compare-and-write may replace the inode. Revalidate its resulting
  // bytes; an external edit cannot renew the original deletion authority.
  records.delete(receipt.target);
  if (after == null || Buffer.byteLength(after) > maxTemporaryCheckBytes) return false;
  try {
    await registerTemporaryCheck(receipt.root, receipt.target, after);
    return true;
  } catch { return false; }
}

export async function validateTemporaryCheckCreation(workspaceRoot, path, { created, content } = {}) {
  if (!ledger()) throw refused('NO_ACTIVE_TASK', 'Temporary self-check files require an active task.');
  const root = await realpath(workspaceRoot);
  const target = await verifyNativeFileTarget(root, path, { writable: true });
  if (!filePathInside(root, target) || target === root) throw refused('OUTSIDE_WORKSPACE', 'Only a workspace file can be registered for temporary cleanup.');
  if (!created && !await prepareTemporaryCheckUpdate(root, path, await readFile(target, 'utf8'))) throw refused('NOT_OWNED', 'Only a newly created workspace file or this task’s unchanged registered self-check file can be registered. Existing user files and externally changed files do not qualify.');
  validateTemporaryCheckContent(target, content);
  return target;
}

export async function registerTemporaryCheck(workspaceRoot, path, content) {
  const root = await realpath(workspaceRoot);
  const target = await verifyNativeFileTarget(root, path, { writable: true });
  const records = ledger();
  if (!records) throw refused('NO_ACTIVE_TASK', 'Temporary self-check files require an active task registration scope.');
  if (!filePathInside(root, target)) throw refused('OUTSIDE_WORKSPACE', 'Only a workspace file can be registered for temporary cleanup.');
  validateTemporaryCheckContent(target, content);
  const info = await lstat(target), bytes = await readFile(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw refused('UNSAFE_FILE', 'Temporary cleanup requires one regular file with no symbolic or hard links.');
  if (hash(bytes) !== hash(Buffer.from(content))) throw refused('CONTENT_CHANGED', 'File changed before registration; automatic cleanup authority was not granted.');
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
  if (!record || record.root !== root || !filePathInside(root, target)) throw refused('NOT_REGISTERED', 'File was not registered by this active task.');
  const info = await lstat(target), bytes = await readFile(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.dev !== record.dev || info.ino !== record.ino || hash(bytes) !== record.hash) throw refused('FILE_CHANGED', 'Registered self-check file was modified or replaced; automatic cleanup is not allowed.');
  signal?.throwIfAborted();
  await mutateWorkspaceFiles({ workspaceRoot: root, signal, edits: [{ path: target, before: bytes, after: null }] });
  ledger().delete(target);
  return { path, deleted: true, recoverable: true, beforeContent: bytes.toString('utf8') };
}
