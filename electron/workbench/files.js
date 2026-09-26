import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import JSZip from "jszip";
import { normalizeLocalPath } from "../link-target.js";
import {
  getVerifiedWorkspaceRoot,
  verifyExistingTarget,
} from "../runtime/workspace-runtime.js";

async function resolveWorkbenchReadPath(workspacePath, requestedPath, authorizeExternal) {
  try {
    const root = await getVerifiedWorkspaceRoot(workspacePath);
    return { path: await verifyExistingTarget(root, requestedPath), external: false };
  } catch (error) {
    const normalized = normalizeLocalPath(requestedPath);
    if (authorizeExternal && normalized && isAbsolute(normalized)) {
      const candidate = await realpath(resolve(normalized));
      if (!(await lstat(candidate)).isFile()) throw new Error("只能预览普通文件。");
      if (!await authorizeExternal(candidate)) throw new Error("已取消工作区外文件预览。");
      if (await realpath(resolve(normalized)) !== candidate) throw new Error("文件位置已变化，请重新授权。");
      return { path: candidate, external: true };
    }
    throw error;
  }
}

export async function readWorkbenchFile(workspacePath, requestedPath, { authorizeExternal } = {}) {
  const { path, external } = await resolveWorkbenchReadPath(workspacePath, requestedPath, authorizeExternal);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("预览仅支持不超过 16 MB 的普通文件。");
  const extension = extname(path).slice(1).toLowerCase();
  const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }[extension];
  if (!mime && extension !== "docx" && extension !== "pdf" && !external) return { kind: "text" };
  const buffer = await readFile(path);
  if (extension === "pdf") return { kind: "pdf", data: buffer.toString("base64"), size: stat.size, path: requestedPath, readOnly: true };
  if (!mime && extension !== "docx") {
    const binary = buffer.includes(0);
    return { kind: binary ? "binary" : "text", binary, readOnly: true,
      truncated: buffer.length > 200000, content: binary ? "" : buffer.toString("utf8").slice(0, 200000), path: requestedPath };
  }
  if (extension === "docx") {
    const zip = await JSZip.loadAsync(buffer);
    const files = Object.values(zip.files);
    const expanded = files.reduce((total, f) => total + (f._data?.uncompressedSize || 0), 0);
    if (files.length > 4000 || expanded > 64 * 1024 * 1024 || !zip.file("word/document.xml")) throw new Error("DOCX 结构无效或解压内容过大。");
  }
  return { kind: mime ? "image" : "docx", mime, data: buffer.toString("base64"), size: stat.size, path: requestedPath };
}

export async function searchWorkbenchFiles(workspacePath, query) {
  const root = await getVerifiedWorkspaceRoot(workspacePath);
  const needle = String(query || "").trim().toLowerCase().slice(0, 200);
  if (!needle) return { entries: [], truncated: false };
  const queue = ["."]; const entries = []; let visited = 0;
  const ignore = new Set(["node_modules", ".git", "release", "dist", ".next", ".gradle", "build"]);
  while (queue.length && visited < 20000 && entries.length < 200) {
    const dir = queue.shift();
    const verified = await verifyExistingTarget(root, dir);
    for (const item of await readdir(verified, { withFileTypes: true })) {
      if (++visited > 20000) break;
      if (item.isSymbolicLink() || ignore.has(item.name)) continue;
      const path = dir === "." ? item.name : `${dir}/${item.name}`;
      if (item.isDirectory()) queue.push(path);
      if ((item.isFile() || item.isDirectory()) && path.toLowerCase().includes(needle)) entries.push({ path, name: item.name, type: item.isDirectory() ? "directory" : "file" });
      if (entries.length >= 200) break;
    }
  }
  return { entries, truncated: queue.length > 0 || entries.length >= 200 || visited >= 20000 };
}
