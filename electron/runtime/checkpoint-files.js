import { mkdir, copyFile, lstat, realpath, rename, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { hashFile } from '../storage/file-state.js';

let recoveryDirectory = () => join(tmpdir(), 'aporiax-workspace-recovery');
export function configureCheckpointFiles(readDirectory) { recoveryDirectory = readDirectory; }
const key = text => createHash('sha256').update(text).digest('hex');
const inside = (root, path) => { const rel = relative(root, path); return rel && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel); };
export function validCheckpointFile(ref) {
  return ref?.version === 1 && /^[a-f0-9]{64}$/.test(ref.sha256 || '') && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0;
}
async function location(workspaceRoot, path, ref, create = false) {
  const workspace = await realpath(workspaceRoot), target = resolve(workspace, path);
  if (!inside(workspace, target)) throw Error('Invalid checkpoint file target.');
  const configured = resolve(recoveryDirectory());
  if (create) await mkdir(configured, { recursive: true });
  const root = await realpath(configured);
  const directory = join(root, 'file-versions-v1', key(workspace), key(relative(workspace, target)));
  if (create) await mkdir(directory, { recursive: true });
  // Recovery references never select arbitrary filesystem paths, including
  // after IPC or process restart. Resolve only within the configured store.
  if (await realpath(directory) !== directory || !inside(root, directory)) throw Error('Invalid checkpoint storage directory.');
  return join(directory, ref.sha256 + '.bin');
}
export async function saveCheckpointFile(workspaceRoot, path, source, expectedHash) {
  const actual = await hashFile(source);
  if (expectedHash && actual.sha256 !== expectedHash) throw Error('Checkpoint source changed while saving.');
  const ref = { version: 1, sha256: actual.sha256, bytes: actual.bytes };
  const target = await location(workspaceRoot, path, ref, true);
  try { await inspectCheckpointFile(workspaceRoot, path, ref); return ref; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = join(dirname(target), randomUUID() + '.tmp');
  try {
    await copyFile(source, temporary);
    if ((await hashFile(temporary)).sha256 !== ref.sha256) throw Error('Checkpoint source changed during copy.');
    try { await rename(temporary, target); }
    catch (error) {
      // Concurrent workers may persist the identical content-addressed version.
      // Never delete an existing blob to make room; accept only a verified match.
      try { await inspectCheckpointFile(workspaceRoot, path, ref); }
      catch { throw error; }
    }
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
  return ref;
}
export async function inspectCheckpointFile(workspaceRoot, path, ref) {
  if (!validCheckpointFile(ref)) throw Error('Invalid checkpoint file reference.');
  const filePath = await location(workspaceRoot, path, ref);
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(filePath) !== filePath || stat.size !== ref.bytes) throw Error('Invalid checkpoint file.');
  const actual = await hashFile(filePath);
  if (actual.sha256 !== ref.sha256) throw Error('Checkpoint file checksum mismatch.');
  return { filePath, sha256: ref.sha256, bytes: ref.bytes };
}
