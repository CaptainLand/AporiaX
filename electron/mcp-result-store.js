import { randomUUID } from "node:crypto";
import { mkdtemp, open, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Task-owned output, never an arbitrary filesystem path supplied by the model.
// Retained for this runtime; close removes only this store's own temporary directory.
export function createMcpResultStore() {
  let directory;
  let bytes = 0;
  let closed = false;
  let pending = Promise.resolve();
  const records = new Map();
  return {
    async put(text) {
      if (closed) throw new Error("MCP result store is closed.");
      const operation = pending.then(async () => {
      const size = Buffer.byteLength(text);
      if (size > 64_000_000 || bytes + size > 256_000_000) throw new Error("MCP result storage limit exceeded.");
      directory ||= mkdtemp(join(tmpdir(), "aporiax-mcp-results-"));
      const root = await directory;
      const id = randomUUID();
      const path = join(root, `${id}.json`);
      await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
      records.set(id, { path, size }); bytes += size;
      return { id, bytes: size, format: "json", lifetime: "current task runtime", readTool: "mcp_read_result" };
      });
      pending = operation.catch(() => {});
      return operation;
    },
    async read({ result_id: id, offset = 0, limit = 16_000 } = {}) {
      const record = records.get(id);
      if (!record) throw new Error("Unknown or expired MCP result reference.");
      const start = Number(offset);
      if (!Number.isSafeInteger(start) || start < 0 || start > record.size) throw new Error("Invalid MCP result byte offset.");
      const count = Math.min(32_000, Math.max(4, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 16_000));
      const file = await open(record.path, "r");
      try {
        const buffer = Buffer.alloc(Math.min(count, record.size - start));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
        if (bytesRead && (buffer[0] & 0xc0) === 0x80) throw new Error("Offset must be a UTF-8 boundary; use nextOffset from the previous page.");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead), { stream: start + bytesRead < record.size });
        const next = start + Buffer.byteLength(text);
        return { resultId: id, text, offset: start, nextOffset: next < record.size ? next : null, totalBytes: record.size, complete: next >= record.size };
      } finally { await file.close(); }
    },
    async close() {
      closed = true;
      await pending;
      records.clear();
      if (directory) await rm(await directory, { recursive: true, force: true });
    },
  };
}
