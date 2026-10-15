import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "../control/credentials.js";

export async function createFileAccessSettings({ dataDirectory }) {
  const directory = join(dataDirectory, "security");
  const path = join(directory, "file-access.json");
  const protectedPaths = [directory, join(dataDirectory, "local-control"),
    ...["deepseek-credentials.json", "aporiax-providers.json", "aporiax-account-session.json", "aporiax-installation.json", "cloud-private-preview.json",
      "aporiax-mcp.json", "aporiax-extensions.json", "aporiax-tasks.json", "aporiax-runs",
      "aporiax-runs.sqlite3", "aporiax-runs.sqlite3-wal", "aporiax-runs.sqlite3-shm", "aporiax-runs.sqlite3-journal",
    ].map(name => join(dataDirectory, name))];
  let enabled = false, loadError = "", tail = Promise.resolve(), revision = 0;
  try {
    const value = await readPrivateJson(path);
    if (value.version !== 1 || typeof value.enabled !== "boolean") throw new Error("Invalid file-access settings.");
    enabled = value.enabled === true;
  } catch (error) { if (error.code !== "ENOENT") loadError = "文件权限配置读取失败，已保持关闭。"; }
  const snapshot = () => ({ enabled, ...(loadError ? { error: loadError } : {}) });
  return Object.freeze({
    snapshot,
    policy: () => ({ enabled, protectedPaths }),
    set(input = {}) {
      if (typeof input.enabled !== "boolean" || Object.keys(input).some(key => !["enabled", "riskAcknowledged"].includes(key))) return Promise.reject(new Error("Invalid global file permission settings."));
      if (input.enabled && input.riskAcknowledged !== true) return Promise.reject(new Error("Enabling global file access requires explicit local risk confirmation."));
      const version = ++revision;
      // Disable immediately, including while an earlier settings write awaits IO.
      if (!input.enabled) enabled = false;
      const operation = tail.catch(() => {}).then(async () => {
        await writePrivateJson(path, { version: 1, enabled: input.enabled });
        if (version === revision) enabled = input.enabled;
        loadError = "";
        return snapshot();
      });
      tail = operation;
      return operation;
    },
  });
}
