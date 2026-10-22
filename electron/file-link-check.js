import { stat } from "node:fs/promises";
import { getVerifiedWorkspaceRoot, verifyExistingTarget, toWorkspaceRelativePath } from "./runtime/workspace-runtime.js";

export function fileLinkError(error, target) {
  const path = String(target || '').slice(0, 240);
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return Object.assign(new Error(`找不到文件：${path}。请确认文件名和路径是否完整。`), { code: 'FILE_LINK_MISSING' });
  if (/escapes|network share/i.test(error?.message || '')) return Object.assign(new Error(`该路径不在当前工作区内：${path}。请切换到对应项目，或使用明确的外部文件预览。`), { code: 'FILE_LINK_OUTSIDE' });
  return error;
}

// Existence only, not authorization to read or execute. Never guess a replacement.
export async function checkWorkspaceFileLink(workspacePath, target) {
  if (!workspacePath) return { status: "unavailable", target };
  let root;
  try { root = await getVerifiedWorkspaceRoot(workspacePath); }
  catch { return { status: "unavailable", target }; }
  try {
    const path = await verifyExistingTarget(root, target);
    const info = await stat(path);
    if (!info.isFile() && !info.isDirectory()) return { status: "unavailable", target };
    return { status: "exists", target: toWorkspaceRelativePath(root, path), directory: info.isDirectory() };
  } catch (error) {
    if (/escapes|network share/i.test(error.message)) return { status: "outside", target, message: fileLinkError(error, target).message };
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { status: "missing", target, message: fileLinkError(error, target).message };
    return { status: "unavailable", target };
  }
}
