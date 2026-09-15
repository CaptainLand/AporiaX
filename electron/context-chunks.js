import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

const CHUNK_BYTES = 64 * 1024;
const MAX_BYTES = 256 * 1024 * 1024;
export const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");

export function initializeChunkSchema(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS context_chunks (
    hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, payload BLOB NOT NULL
  );`);
}

export function storeBytes(database, bytes) {
  if (bytes.length > MAX_BYTES) throw new Error("RUN_CONTEXT_TOO_LARGE: decoded data exceeds 256 MiB.");
  const hashes = [];
  const find = database.prepare("SELECT bytes FROM context_chunks WHERE hash = ?");
  const insert = database.prepare("INSERT OR IGNORE INTO context_chunks(hash, bytes, payload) VALUES (?, ?, ?)");
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
    const hash = digest(chunk);
    if (!find.get(hash)) insert.run(hash, chunk.length, gzipSync(chunk, { level: 1 }));
    hashes.push(hash);
  }
  return { hashes, bytes: bytes.length, checksum: digest(bytes) };
}

export function loadBytes(database, record) {
  const bytes = loadByteRange(database, record, 0, record?.bytes);
  if (digest(bytes) !== record.checksum) throw new Error("RUN_CONTEXT_CORRUPT");
  return bytes;
}

export function loadByteRange(database, record, start, end) {
  if (!record || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || record.bytes > MAX_BYTES ||
    !Array.isArray(record.hashes) || record.hashes.length !== Math.ceil(record.bytes / CHUNK_BYTES)) throw new Error("RUN_CONTEXT_CORRUPT");
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > record.bytes) throw new Error("RUN_CONTEXT_CORRUPT");
  if (start === end) return Buffer.alloc(0);
  const first = Math.floor(start / CHUNK_BYTES);
  const last = Math.ceil(end / CHUNK_BYTES);
  const parts = record.hashes.slice(first, last).map((hash, index) => {
    const row = database.prepare("SELECT bytes, payload FROM context_chunks WHERE hash = ?").get(hash);
    if (!row) throw new Error("RUN_CONTEXT_CORRUPT: missing content chunk");
    const bytes = gunzipSync(row.payload, { maxOutputLength: CHUNK_BYTES });
    const expected = Math.min(CHUNK_BYTES, record.bytes - (first + index) * CHUNK_BYTES);
    if (bytes.length !== row.bytes || bytes.length !== expected || digest(bytes) !== hash) throw new Error("RUN_CONTEXT_CORRUPT: invalid content chunk");
    return bytes;
  });
  return Buffer.concat(parts).subarray(start - first * CHUNK_BYTES, end - first * CHUNK_BYTES);
}

// Long strings are stored independently: identical originals, file versions and
// messages share chunks even when their position in a snapshot changes.
export function encodeContext(database, state) {
  const strings = [];
  let totalBytes = 0;
  const visit = (value, path, depth) => {
    if (depth > 128) throw new Error("RUN_CONTEXT_TOO_DEEP");
    if (typeof value === "string") {
      const bytes = Buffer.from(value);
      totalBytes += bytes.length;
      if (totalBytes > MAX_BYTES) throw new Error("RUN_CONTEXT_TOO_LARGE: decoded strings exceed 256 MiB.");
      if (bytes.length < 4096) return value;
      strings.push({ path, ...storeBytes(database, bytes) });
      return null;
    }
    if (Array.isArray(value)) return value.map((item, index) => visit(item, [...path, index], depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, [...path, key], depth + 1)]));
    return value;
  };
  const data = visit(state, [], 0);
  return Buffer.from(JSON.stringify({ version: 1, data, strings }));
}

export function decodeContext(database, bytes) {
  const manifest = JSON.parse(bytes.toString());
  if (manifest.version !== 1 || !Array.isArray(manifest.strings)) throw new Error("RUN_CONTEXT_CORRUPT");
  let total = 0;
  for (const record of manifest.strings) {
    total += record.bytes;
    if (total > MAX_BYTES || !Array.isArray(record.path) || record.path.length > 128) throw new Error("RUN_CONTEXT_CORRUPT");
    const value = loadBytes(database, record).toString("utf8");
    if (!record.path.length) { manifest.data = value; continue; }
    let target = manifest.data;
    for (const key of record.path.slice(0, -1)) {
      if (!target || !Object.hasOwn(target, key)) throw new Error("RUN_CONTEXT_CORRUPT");
      target = target[key];
    }
    const key = record.path.at(-1);
    if (!target || !Object.hasOwn(target, key) || target[key] !== null) throw new Error("RUN_CONTEXT_CORRUPT");
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  }
  return manifest.data;
}
