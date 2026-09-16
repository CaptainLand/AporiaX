import { stat } from "node:fs/promises";
import { getVerifiedWorkspaceRoot, verifyExistingTarget } from "./runtime/workspace-runtime.js";

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
    return { status: "exists", target, directory: info.isDirectory() };
  } catch (error) {
    if (/escapes|network share/i.test(error.message)) return { status: "outside", target };
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { status: "missing", target };
    return { status: "unavailable", target };
  }
}
