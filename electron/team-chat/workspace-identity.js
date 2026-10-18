import { realpath, lstat } from 'node:fs/promises';

export async function memberWorkspaceIdentity(path) {
  const canonical = await realpath(path), info = await lstat(canonical, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('成员工作目录必须是可验证的目录。');
  return { path: canonical, dev: String(info.dev), ino: String(info.ino) };
}
export function sameMemberWorkspace(left, right) {
  const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
  return Boolean(left && right && canonical(left.path) === canonical(right.path) && left.dev === right.dev && left.ino === right.ino);
}
