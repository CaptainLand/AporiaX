import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { parsePatch } from "diff";

export const NATIVE_FILE_TOOLS = new Set(["list_directory", "read_file", "read_external_file", "search_text", "inspect_office_file", "write_file", "apply_patch", "create_word_document", "create_presentation", "create_spreadsheet"]);
const WRITES = new Set(["write_file", "apply_patch", "create_word_document", "create_presentation", "create_spreadsheet"]);
const scope = new AsyncLocalStorage();
let settings = () => ({ enabled: false, protectedPaths: [] });
// Trusted main-process wiring only. This function is not exposed over IPC or tools.
export function configureNativeFileAccess(readSettings) { settings = readSettings; }
export function outsideFileAccessEnabled() { return settings()?.enabled === true; }
const credentialRoots = [".ssh", ".aws", ".azure", ".gnupg", ".kube"].map(name => join(homedir(), name));
export function filePathInside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
const denied = message => Object.assign(new Error(`FILE_ACCESS_DENIED: ${message}`), { code: "FILE_ACCESS_DENIED", retryable: false });

export function nativeFilePath(root, value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw denied("Invalid file path.");
  let normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("//")) throw denied("Network and device paths are not supported.");
  if (process.platform === "win32") {
    if (normalized.replace(/^[a-z]:\//i, "/").includes(":")) throw denied("Alternate data streams and drive-relative paths are not supported.");
    if (normalized.split("/").some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /[. ]$/.test(part) && part !== "." && part !== "..")) throw denied("Ambiguous Windows file path.");
    // Match the established workspace-root spelling /src/file on Windows.
    if (normalized.startsWith("/")) normalized = normalized.replace(/^\/+/, "");
  }
  return resolve(root, normalized);
}

async function assertProtected(root, path, writable) {
  const configured = settings()?.protectedPaths || [];
  for (const value of [...credentialRoots, ...configured]) {
    if (filePathInside(value, path)) throw denied("Application settings or credential directories are protected.");
    const canonical = await realpath(value).catch(() => null);
    if (canonical && filePathInside(canonical, path)) throw denied("Resolved application settings or credential directory is protected.");
  }
  const segments = path.split(/[\\/]/);
  if (writable && segments.some(part => [".git", ".aporiax"].includes(part.toLowerCase()))) throw denied("Control metadata cannot be modified by file tools.");
  if (!filePathInside(root, path) && /^(?:\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa)|credentials(?:\.json)?|[^/\\]+\.(?:pem|key|p12|pfx))$/i.test(basename(path))) throw denied("External credential files are protected.");
}

export async function requiresGuardedFileSearch(root, searchPath) {
  if (!filePathInside(root, searchPath)) return true;
  for (const path of [...credentialRoots, ...(settings()?.protectedPaths || [])]) {
    if (filePathInside(searchPath, path)) return true;
    const canonical = await realpath(path).catch(() => null);
    if (canonical && filePathInside(searchPath, canonical)) return true;
  }
  // Ordinary project searches keep ripgrep; it does not follow symlinks.
  return false;
}

// Resolves the nearest existing ancestor too, including for newly created files.
// No lexical/realpath mismatch is treated as an implicit extension of authority.
export async function verifyNativeFileTarget(root, value, { writable = false } = {}) {
  const target = nativeFilePath(root, value);
  await assertProtected(root, target, writable);
  if (!filePathInside(root, target) && !outsideFileAccessEnabled()) throw denied("工作区外文件访问已关闭，请由用户在控制板开启全局文件权限。");
  let ancestor = target;
  const suffix = [];
  while (true) {
    try {
      const info = await lstat(ancestor);
      if (writable && ancestor === target && (!info.isFile() || info.isSymbolicLink())) throw denied("Refusing to overwrite a link or non-file.");
      const canonical = join(await realpath(ancestor), ...suffix);
      await assertProtected(root, canonical, writable);
      if (!filePathInside(root, canonical) && !outsideFileAccessEnabled()) throw denied("Resolved path escapes the authorized workspace.");
      // Don't follow a workspace junction into arbitrary host locations, even
      // when broad access is on. The model must use the explicit external path.
      if (filePathInside(root, target) && !filePathInside(root, canonical)) throw denied("Workspace link escapes its root; use an explicit authorized path.");
      if (writable && ancestor !== target && !info.isDirectory()) throw denied("Parent is not a directory.");
      return canonical;
    } catch (error) {
      if (error.code !== "ENOENT" || !writable || dirname(ancestor) === ancestor) throw error;
      suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
}

export async function verifyExternalFileTarget(root, value) {
  // Windows /path is drive-relative to fs, but workspace-relative to native
  // tools. External reads require one unambiguous, fully qualified spelling.
  if (typeof value !== "string" || !isAbsolute(value) ||
      (process.platform === "win32" && !/^[a-z]:[/\\]/i.test(value))) {
    throw denied("External file path must be absolute and fully qualified.");
  }
  const target = await verifyNativeFileTarget(root, value);
  if ((await lstat(value)).isSymbolicLink()) throw denied("External symbolic links are not accepted.");
  return target;
}

export async function assertNativeFileTool({ toolName, input = {}, workspaceRoot } = {}) {
  if (!NATIVE_FILE_TOOLS.has(toolName)) return;
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) throw denied("A workspace is required for native file access.");
  if (toolName === "apply_patch" && input.patch?.trim()) {
    for (const patch of parsePatch(input.patch)) {
      const value = patch.newFileName && patch.newFileName !== "/dev/null" ? patch.newFileName : patch.oldFileName;
      await verifyNativeFileTarget(workspaceRoot, String(value || "").replace(/^[ab][\\/]/, ""), { writable: true });
    }
  } else if (toolName === "read_external_file") await verifyExternalFileTarget(workspaceRoot, input.path);
  else await verifyNativeFileTarget(workspaceRoot, input.path || ".", { writable: WRITES.has(toolName) });
  if (toolName === "create_word_document") for (const block of input.blocks || []) if (block.type === "image") await verifyNativeFileTarget(workspaceRoot, block.path);
}

export function withNativeFileScope(toolName, workspaceRoot, callback) {
  return scope.run(NATIVE_FILE_TOOLS.has(toolName) ? { toolName, workspaceRoot: resolve(workspaceRoot || ".") } : null, callback);
}
export function nativeMutationScope(workspaceRoot) {
  const value = scope.getStore();
  return Boolean(value && WRITES.has(value.toolName) && resolve(workspaceRoot) === value.workspaceRoot);
}
