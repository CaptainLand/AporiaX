import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, normalize } from "node:path";

const pathKey = path => process.platform === "win32" ? normalize(path).toLowerCase() : normalize(path);

// The caller is a main-process reader of saved desktop projects, never HTTP
// input. Only folder metadata is returned, not tasks, messages, or credentials.
export async function desktopWorkspaceCatalog(listWorkspaces, registered = []) {
  const rows = await listWorkspaces();
  if (!Array.isArray(rows)) throw new Error("Unable to read AporiaX project workspaces.");
  const result = new Map();
  for (const row of rows) {
    const source = row?.path;
    if (typeof source !== "string" || !source || source.includes("\0") || !isAbsolute(source)) continue;
    try {
      const path = await realpath(source);
      if (!(await stat(path)).isDirectory()) continue;
      const key = pathKey(path);
      if (result.has(key)) continue;
      // Preserve existing client grants only for the identical canonical path.
      // Renaming a project is safe; changing its folder never inherits a grant.
      const previous = registered.find(workspace => pathKey(workspace.path) === key);
      result.set(key, {
        id: previous?.id || `ws_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`,
        path, label: String(row.label || basename(path)).slice(0, 200), source: "aporiax",
      });
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error.code)) throw error;
      // A removed/offline project is not a currently usable workspace.
    }
  }
  return [...result.values()];
}
