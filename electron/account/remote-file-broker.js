import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, parse, resolve } from "node:path";
import { platform } from "node:os";

export const REMOTE_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const REMOTE_FILE_PREVIEW_BYTES = 64 * 1024;
const MAX_DIRECTORY_ENTRIES = 400;
const CONFIG_VERSION = 1;

const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".conf", ".cpp", ".css", ".csv", ".env", ".go", ".h", ".hpp",
  ".html", ".ini", ".java", ".js", ".json", ".jsx", ".log", ".md", ".mjs", ".py",
  ".rs", ".sh", ".sql", ".svg", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml",
  ".yaml", ".yml",
]);

const MIME_TYPES = new Map([
  [".css", "text/css"], [".csv", "text/csv"], [".gif", "image/gif"],
  [".html", "text/html"], [".jpeg", "image/jpeg"], [".jpg", "image/jpeg"],
  [".js", "text/javascript"], [".json", "application/json"], [".md", "text/markdown"],
  [".pdf", "application/pdf"], [".png", "image/png"], [".svg", "image/svg+xml"],
  [".txt", "text/plain"], [".webp", "image/webp"], [".xml", "application/xml"],
]);

function mimeType(filePath) {
  return MIME_TYPES.get(extname(filePath).toLowerCase()) || "application/octet-stream";
}

function validateAbsoluteLocalPath(value) {
  const candidate = String(value || "").trim();
  if (!candidate || candidate.includes("\0") || !isAbsolute(candidate)) {
    throw new Error("REMOTE_FILE_ABSOLUTE_PATH_REQUIRED");
  }
  if (platform() === "win32") {
    if (candidate.startsWith("\\\\") || candidate.startsWith("\\\\?\\") || candidate.startsWith("\\\\.\\")) {
      throw new Error("REMOTE_FILE_NETWORK_OR_DEVICE_PATH_BLOCKED");
    }
    if (!/^[a-z]:[\\/]/i.test(candidate)) throw new Error("REMOTE_FILE_DRIVE_PATH_REQUIRED");
  }
  return resolve(candidate);
}

async function verifiedPath(value) {
  const lexical = validateAbsoluteLocalPath(value);
  const target = await realpath(lexical);
  if (platform() === "win32" && parse(target).root.toLowerCase() !== parse(lexical).root.toLowerCase()) {
    throw new Error("REMOTE_FILE_CROSS_DRIVE_LINK_BLOCKED");
  }
  return target;
}

function serializeEntry(targetPath, stats, type = stats.isDirectory() ? "directory" : "file") {
  return {
    name: basename(targetPath) || parse(targetPath).root,
    path: targetPath,
    type,
    size: stats.isFile() ? stats.size : null,
    modifiedAt: stats.mtime?.toISOString?.() || null,
    extension: stats.isFile() ? extname(targetPath).toLowerCase() : "",
    mime: stats.isFile() ? mimeType(targetPath) : null,
    readable: true,
  };
}

async function listWindowsRoots() {
  const letters = Array.from({ length: 26 }, (_value, index) => String.fromCharCode(65 + index));
  const roots = await Promise.all(letters.map(async (letter) => {
    const target = `${letter}:\\`;
    try {
      await access(target, fsConstants.R_OK);
      return serializeEntry(target, await stat(target), "directory");
    } catch {
      return null;
    }
  }));
  return roots.filter(Boolean);
}

export async function readRemoteFileSettings(configPath) {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    return { enabled: Boolean(parsed?.enabled), mode: "computer-read-only", maxBytes: REMOTE_FILE_MAX_BYTES };
  } catch {
    return { enabled: false, mode: "computer-read-only", maxBytes: REMOTE_FILE_MAX_BYTES };
  }
}

export async function writeRemoteFileSettings(configPath, enabled) {
  const payload = { version: CONFIG_VERSION, enabled: Boolean(enabled), updatedAt: new Date().toISOString() };
  await mkdir(parse(configPath).dir, { recursive: true });
  await writeFile(configPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
  return { enabled: payload.enabled, mode: "computer-read-only", maxBytes: REMOTE_FILE_MAX_BYTES };
}

export async function listRemoteRoots() {
  if (platform() === "win32") return listWindowsRoots();
  const root = "/";
  await access(root, fsConstants.R_OK);
  return [serializeEntry(root, await stat(root), "directory")];
}

export async function listRemoteDirectory(requestedPath) {
  const directoryPath = await verifiedPath(requestedPath);
  const directoryStats = await lstat(directoryPath);
  if (!directoryStats.isDirectory()) throw new Error("REMOTE_FILE_DIRECTORY_REQUIRED");
  const entries = (await readdir(directoryPath, { withFileTypes: true })).slice(0, MAX_DIRECTORY_ENTRIES);
  const items = [];
  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);
    try {
      const entryStats = await lstat(entryPath);
      items.push(serializeEntry(entryPath, entryStats, entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "link" : "file"));
    } catch {
      items.push({ name: entry.name, path: entryPath, type: "unavailable", size: null, modifiedAt: null, extension: "", mime: null, readable: false });
    }
  }
  items.sort((left, right) => {
    const leftRank = left.type === "directory" ? 0 : left.type === "file" ? 1 : 2;
    const rightRank = right.type === "directory" ? 0 : right.type === "file" ? 1 : 2;
    return leftRank - rightRank || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return { path: directoryPath, parent: parse(directoryPath).root === directoryPath ? null : parse(directoryPath).dir, truncated: entries.length >= MAX_DIRECTORY_ENTRIES, items };
}

export async function previewRemoteFile(requestedPath) {
  const filePath = await verifiedPath(requestedPath);
  const fileStats = await lstat(filePath);
  if (!fileStats.isFile()) throw new Error("REMOTE_FILE_REGULAR_FILE_REQUIRED");
  const descriptor = serializeEntry(filePath, fileStats);
  const extension = extname(filePath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension) && !descriptor.mime?.startsWith("text/")) {
    return { ...descriptor, previewType: descriptor.mime?.startsWith("image/") ? "image" : descriptor.mime === "application/pdf" ? "pdf" : "binary", content: null };
  }
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(REMOTE_FILE_PREVIEW_BYTES, Math.max(1, fileStats.size)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { ...descriptor, previewType: "text", content: buffer.subarray(0, bytesRead).toString("utf8"), truncated: fileStats.size > bytesRead };
  } finally {
    await handle.close();
  }
}

export async function prepareRemoteFileDownload(requestedPath, upload) {
  const filePath = await verifiedPath(requestedPath);
  const fileStats = await lstat(filePath);
  if (!fileStats.isFile()) throw new Error("REMOTE_FILE_REGULAR_FILE_REQUIRED");
  if (fileStats.size > REMOTE_FILE_MAX_BYTES) throw new Error("REMOTE_FILE_TOO_LARGE");
  const metadata = serializeEntry(filePath, fileStats);
  const buffer = await readFile(filePath);
  await upload({ buffer, name: metadata.name, mime: metadata.mime, size: metadata.size });
  return { name: metadata.name, size: metadata.size, mime: metadata.mime, expiresInSeconds: 600 };
}

export async function executeRemoteFileCommand(command, { configPath, confirm, upload }) {
  const settings = await readRemoteFileSettings(configPath);
  if (!settings.enabled) throw new Error("REMOTE_FILE_ACCESS_DISABLED");
  const commandType = String(command?.type || "");
  if (commandType === "files_roots") return { roots: await listRemoteRoots(), readOnly: true };
  if (commandType === "files_list") return listRemoteDirectory(command?.payload?.path);
  if (!["file_preview", "file_download"].includes(commandType)) throw new Error("REMOTE_FILE_COMMAND_UNSUPPORTED");
  const requestedPath = validateAbsoluteLocalPath(command?.payload?.path);
  const approved = await confirm({ action: commandType === "file_preview" ? "preview" : "download", path: requestedPath });
  if (!approved) throw new Error("REMOTE_FILE_APPROVAL_DENIED");
  if (commandType === "file_preview") return previewRemoteFile(requestedPath);
  return prepareRemoteFileDownload(requestedPath, upload);
}
