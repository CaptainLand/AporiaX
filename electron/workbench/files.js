import { lstat, readFile, readdir } from "node:fs/promises";
import { extname } from "node:path";
import JSZip from "jszip";
import { getVerifiedWorkspaceRoot, verifyExistingTarget } from "../runtime/workspace-runtime.js";

export async function readWorkbenchFile(workspacePath, requestedPath) {
  const root = await getVerifiedWorkspaceRoot(workspacePath);
  const path = await verifyExistingTarget(root, requestedPath);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("预览仅支持不超过 16 MB 的普通文件。");
  const extension = extname(path).slice(1).toLowerCase();
  const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }[extension];
  if (!mime && extension !== "docx") return { kind: "text" };
  const buffer = await readFile(path);
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
      else if (item.isFile() && path.toLowerCase().includes(needle)) entries.push({ path, name: item.name, type: "file" });
      if (entries.length >= 200) break;
    }
  }
  return { entries, truncated: queue.length > 0 || entries.length >= 200 || visited >= 20000 };
}
