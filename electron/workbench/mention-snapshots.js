import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWriteFile, serializeStorage } from "../storage/atomic-file.js";

// A browser reference belongs to one user message, not to the current page in
// that tab forever. Keep it locally before inference; never refresh on retry.
export function createFrozenBrowserMentionReader({ directory, taskId, workspacePath = "", retry = false, readContext }) {
  return async (token, message = {}) => {
    if (token.kind !== "browser") return readContext(token);
    if (!taskId || !message.id) return { missing: true, reason: "snapshot-identity-missing; select the page in a new message" };
    const root = workspacePath ? resolve(workspacePath) : "";
    const scope = [String(taskId), process.platform === "win32" ? root.toLowerCase() : root, String(message.id), token.value];
    const key = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
    const file = join(directory, key + ".json");
    return serializeStorage(file, async () => {
      try {
        if ((await stat(file)).size > 200_000) throw new Error("Browser snapshot is too large.");
        const saved = JSON.parse(await readFile(file, "utf8"));
        if (saved.version !== 1 || saved.key !== key) throw new Error("Invalid browser snapshot.");
        return saved.state === "captured" && typeof saved.content === "string"
          ? saved.content : { missing: true, reason: "snapshot-unavailable; select the page in a new message" };
      } catch (error) {
        if (error.code !== "ENOENT") throw error; // Corruption is never permission to read a different page.
      }
      if (retry) return { missing: true, reason: "snapshot-missing; select the page in a new message" };
      // A crash after capture but before commit must not authorize recapture.
      await atomicWriteFile(file, JSON.stringify({ version: 1, key, state: "pending" }));
      const value = await readContext(token);
      if (!value || value.missing) return { missing: true };
      const serialized = typeof value === "string" ? value : JSON.stringify(value);
      const content = serialized.slice(0, 24_000) + (serialized.length > 24_000 ? "\n[Snapshot truncated]" : "");
      await atomicWriteFile(file, JSON.stringify({ version: 1, key, state: "captured", content }));
      return content;
    });
  };
}
