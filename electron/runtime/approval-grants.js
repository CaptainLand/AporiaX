import { createHash } from 'node:crypto';
import { dirname, extname, isAbsolute, relative } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

const BROWSER_CONTROLS = new Set(['browser_click', 'browser_fill', 'browser_press']);

// Only the native deletion preflight can describe this scope. Individual
// files still go through authorization, hash validation and recoverable delete.
export async function fileDeletionGrant(workspaceRoot, version, logicalPath, actor = 'main') {
  if (version.binary || relative(logicalPath, version.filePath)) return null;
  const extension = extname(version.filePath).toLowerCase();
  if (!/^\.[a-z0-9]{1,10}$/.test(extension)) return null;
  const root = await realpath(workspaceRoot);
  const directory = dirname(version.filePath);
  const path = relative(root, directory).replaceAll('\\', '/') || '.';
  if (path === '..' || path.startsWith('../') || isAbsolute(path)) return null;
  if (relative(directory, await realpath(directory))) return null;
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) return null;
  const id = createHash('sha256').update(JSON.stringify([root, directory, String(info.dev), String(info.ino), extension, actor])).digest('hex');
  return { id, view: { kind: 'delete-file', directory: path, extension } };
}

export function desktopApprovalGrant(details = {}) {
  if (details.toolName === 'delete_file' && details.deletionGrant?.view?.kind === 'delete-file' &&
    /^[a-f0-9]{64}$/.test(details.deletionGrant.id)) {
    return { key: `delete-file:${details.deletionGrant.id}`, view: details.deletionGrant.view };
  }
  return BROWSER_CONTROLS.has(details.toolName) ? { key: 'browser-control', view: { kind: 'browser-control' } } : null;
}
