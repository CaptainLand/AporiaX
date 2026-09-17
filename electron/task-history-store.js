import { createHash } from "node:crypto";
import { atomicWriteFile, serializeStorage } from "./storage/atomic-file.js";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export const TASK_HISTORY_STORE_VERSION = 1;
export const MAX_TASK_JSON_BYTES = 200 * 1024 * 1024;
export const TASK_JSON_TOO_LARGE = "TASK_JSON_TOO_LARGE";
const TASK_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function assertTaskId(id) {
  if (!TASK_ID_PATTERN.test(String(id || ""))) {
    throw new Error("Invalid task id for the task history store.");
  }
  return String(id);
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

const atomicWrite = atomicWriteFile;

function decodeDataUrl(dataUrl) {
  const value = String(dataUrl || "");
  const matched = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  if (!matched) return null;
  return {
    type: matched[1],
    buffer: Buffer.from(matched[2].replace(/\s/g, ""), "base64"),
  };
}

function asBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

export function isBlobHash(value) {
  return HASH_PATTERN.test(String(value || ""));
}

export function createTaskHistoryStore(
  dataDirectory,
  { maxTaskJsonBytes = MAX_TASK_JSON_BYTES } = {},
) {
  if (!dataDirectory) {
    throw new Error("Task history store requires a data directory.");
  }
  const taskJsonLimit = Math.max(1, Number(maxTaskJsonBytes) || MAX_TASK_JSON_BYTES);
  const root = join(String(dataDirectory), "aporiax-store");
  const tasksDir = join(root, "tasks");
  const blobsDir = join(root, "blobs");
  const indexPath = join(root, "index.json");
  const migrationPath = join(root, "migration.json");
  let diagnostics = [];
  let damagedIndex = false;
  const damagedTasks = new Set();
  const diagnose = (code, path, error) => {
    if (!diagnostics.some((item) => item.code === code && item.path === path))
      diagnostics.push({ code, path, error: String(error?.message || error) });
  };
  const legacyPaths = [
    join(String(dataDirectory), "aporiax-tasks.json"),
    join(String(dataDirectory), "deepagent-tasks.json"),
  ];

  const blobPath = (hash) => join(blobsDir, hash);
  const blobMetaPath = (hash) => join(blobsDir, `${hash}.json`);
  const taskPath = (taskId) => join(tasksDir, `${taskId}.json`);

  async function putBlob(data, { type = "application/octet-stream" } = {}) {
    const buffer = asBuffer(data);
    if (!buffer?.length) {
      throw new Error("Attachment content is empty.");
    }
    const hash = createHash("sha256").update(buffer).digest("hex");
    await mkdir(blobsDir, { recursive: true });
    const file = blobPath(hash);
    try {
      const existing = await readFile(file);
      if (createHash("sha256").update(existing).digest("hex") !== hash) throw new Error("ATTACHMENT_BLOB_CORRUPT");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await atomicWrite(file, buffer);
      await atomicWrite(
        blobMetaPath(hash),
        JSON.stringify({
          type: String(type || "application/octet-stream"),
          size: buffer.length,
        }),
      );
    }
    return {
      hash,
      type: String(type || "application/octet-stream"),
      size: buffer.length,
    };
  }

  async function readBlob(hash) {
    if (!isBlobHash(hash)) {
      throw new Error("Invalid attachment blob hash.");
    }
    const buffer = await readFile(blobPath(hash));
    if (createHash("sha256").update(buffer).digest("hex") !== hash) throw new Error("ATTACHMENT_BLOB_CORRUPT");
    let type = "application/octet-stream";
    try {
      const meta = JSON.parse(await readFile(blobMetaPath(hash), "utf8"));
      if (meta?.type) type = String(meta.type);
    } catch {
      // Sidecar metadata is optional for older blobs.
    }
    return { buffer, type, size: buffer.length };
  }

  async function persistAttachment(attachment) {
    if (!attachment || typeof attachment !== "object") return attachment;
    const decoded = decodeDataUrl(attachment.dataUrl);
    const raw = asBuffer(attachment.data);
    if (!decoded && !raw) {
      const next = { ...attachment };
      delete next.data;
      return next;
    }
    const stored = await putBlob(decoded?.buffer || raw, {
      type: decoded?.type || attachment.type || "application/octet-stream",
    });
    const next = {
      ...attachment,
      hash: stored.hash,
      type: attachment.type || stored.type,
      size: Number.isFinite(attachment.size) ? attachment.size : stored.size,
    };
    delete next.dataUrl;
    delete next.data;
    return next;
  }

  async function persistTask(task) {
    const messages = await Promise.all(
      (Array.isArray(task?.messages) ? task.messages : []).map(async (message) => ({
        ...message,
        attachments: await Promise.all(
          (Array.isArray(message?.attachments) ? message.attachments : []).map(
            persistAttachment,
          ),
        ),
      })),
    );
    return { ...task, messages };
  }

  function hydrateAttachment(attachment) {
    if (!attachment || typeof attachment !== "object") return attachment;
    const next = { ...attachment };
    delete next.data;
    return next;
  }

  function hydrateTask(task) {
    return {
      ...task,
      messages: (Array.isArray(task?.messages) ? task.messages : []).map(
        (message) => ({
          ...message,
          attachments: (Array.isArray(message?.attachments)
            ? message.attachments
            : []
          ).map(hydrateAttachment),
        }),
      ),
    };
  }

  async function readIndex() {
    try {
      const parsed = JSON.parse(await readFile(indexPath, "utf8"));
      if (!Array.isArray(parsed?.taskIds) || parsed.taskIds.some((id) => !TASK_ID_PATTERN.test(id)) ||
          !Number.isSafeInteger(parsed.revision ?? 0) || (parsed.revision ?? 0) < 0)
        throw new Error("Invalid task index.");
      return { taskIds: [...new Set(parsed.taskIds)], revision: parsed.revision ?? 0 };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      damagedIndex = true;
      diagnose("TASK_INDEX_CORRUPT", indexPath, error);
      return null;
    }
  }

  async function writeIndex(taskIds, revision) {
    await atomicWrite(indexPath, JSON.stringify({ version: TASK_HISTORY_STORE_VERSION,
      taskIds: [...new Set(taskIds)], revision, updatedAt: new Date().toISOString() }));
  }

  async function scanTaskIds() {
    try { return (await readdir(tasksDir)).filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5)).filter((id) => TASK_ID_PATTERN.test(id)); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  async function readTaskFile(taskId) {
    try {
      const parsed = JSON.parse(await readFile(taskPath(taskId), "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.id !== taskId)
        throw new Error("Invalid task record or mismatched id.");
      return parsed;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      damagedTasks.add(taskId);
      diagnose("TASK_FILE_CORRUPT", taskPath(taskId), error);
      return null;
    }
  }

  async function migrateLegacyIfNeeded() {
    let migration = null;
    try { migration = JSON.parse(await readFile(migrationPath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") { diagnose("TASK_MIGRATION_CORRUPT", migrationPath, error); return; } }
    const index = await readIndex();
    if (damagedIndex || migration?.status === "completed" || (index && !migration)) return;
    let legacy, legacyPath = "", sourceHash;
    for (const candidate of legacyPaths) {
      try {
        const bytes = await readFile(candidate);
        legacy = JSON.parse(bytes.toString("utf8"));
        sourceHash = createHash("sha256").update(bytes).digest("hex");
        legacyPath = candidate; break;
      } catch (error) {
        if (error.code !== "ENOENT") { diagnose("TASK_LEGACY_CORRUPT", candidate, error); return; }
      }
    }
    if (!legacyPath) return;
    if (!Array.isArray(legacy)) { diagnose("TASK_LEGACY_CORRUPT", legacyPath, "Expected an array."); return; }
    if (migration && migration.sourceHash !== sourceHash) {
      diagnose("TASK_MIGRATION_SOURCE_CHANGED", legacyPath, "Original migration source changed; manual reconciliation required."); return;
    }
    const pending = migration ? new Set(migration.pending) : null;
    const candidates = pending ? legacy.filter((task) => pending.has(String(task?.id || ""))) : legacy;
    // Write intent before any new index. On a crash, re-run only missing records;
    // never overwrite a newer task saved after an earlier partial migration.
    migration = { version: 1, status: "pending", sourceHash, source: legacyPath,
      pending: candidates.map((task) => String(task?.id || "")) };
    await atomicWrite(migrationPath, JSON.stringify(migration));
    const records = [];
    for (const task of candidates) {
      const existing = TASK_ID_PATTERN.test(String(task?.id || "")) ? await readTaskFile(task.id) : null;
      // A crash may have committed a task file but not its index entry. Adopt
      // that file using its current bytes rather than restoring an older copy.
      records.push(existing || task);
    }
    const result = await saveTasksInternal(records, { migration: true });
    migration.pending = result.failed.map((task) => task.id === "(missing)" ? "" : task.id);
    migration.status = migration.pending.length ? "partial" : "completed";
    await atomicWrite(migrationPath, JSON.stringify(migration));
    if (migration.pending.length) {
      diagnose("TASK_MIGRATION_PARTIAL", legacyPath, `${migration.pending.length} task(s) retained in the original file for retry.`);
      return;
    }
    // Keep an archive. Failure to archive NEVER authorizes deleting the source.
    try {
      try { await readFile(`${legacyPath}.migrated`); return; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await rename(legacyPath, `${legacyPath}.migrated`);
    } catch (error) { diagnose("TASK_MIGRATION_ARCHIVE_FAILED", legacyPath, error); }
  }

  async function loadTasksInternal() {
    diagnostics = []; damagedTasks.clear(); damagedIndex = false;
    await migrateLegacyIfNeeded();
    const index = await readIndex();
    const ids = index?.taskIds ?? await scanTaskIds();
    if (!index && !ids.length && !damagedIndex && !diagnostics.length) return null;
    const tasks = [];
    for (const id of ids) {
      const task = await readTaskFile(id);
      if (task) tasks.push(hydrateTask(task));
      else if (!damagedTasks.has(id)) diagnose("TASK_FILE_MISSING", taskPath(id), "Indexed task is missing; index entry retained.");
    }
    return tasks;
  }

  async function saveTasksInternal(tasks, options = {}) {
    if (!Array.isArray(tasks)) throw new Error("Tasks must be an array.");
    if (options.deletedTaskIds !== undefined && (!Array.isArray(options.deletedTaskIds) || options.deletedTaskIds.some(id => typeof id !== "string" || !TASK_ID_PATTERN.test(id))))
      throw new Error("Invalid explicit task deletion ids.");
    if (options.deletedTaskIds?.length && options.expectedRevision === undefined) throw new Error("Task deletion requires a revision.");
    if (options.deletedTaskIds?.some(id => tasks.some(task => task?.id === id))) throw new Error("Cannot save and delete the same task.");
    await mkdir(tasksDir, { recursive: true });
    await mkdir(blobsDir, { recursive: true });
    const index = await readIndex();
    if (damagedIndex) throw new Error("TASK_STORE_RECOVERY_REQUIRED: index is damaged; no task or index was overwritten.");
    const revision = index?.revision ?? 0;
    if (options.expectedRevision !== undefined && options.expectedRevision !== revision)
      throw new Error("TASK_STORE_REVISION_CONFLICT: reload and reconcile; stale snapshot was not saved.");
    const ids = new Set(index?.taskIds ?? await scanTaskIds());
    const saved = [], failed = [];
    const seen = new Set();
    for (const task of tasks) {
      const taskId = String(task?.id || "");
      if (!TASK_ID_PATTERN.test(taskId) || seen.has(taskId)) {
        failed.push({ id: taskId || "(missing)", error: "Invalid or duplicate task id." }); continue;
      }
      seen.add(taskId);
      try {
        const persisted = await persistTask(task);
        const serialized = JSON.stringify(persisted);
        if (Buffer.byteLength(serialized, "utf8") > taskJsonLimit)
          throw Object.assign(new Error(`Task JSON exceeds ${taskJsonLimit} bytes.`), { code: TASK_JSON_TOO_LARGE });
        const destination = taskPath(taskId);
        let previous;
        try {
          previous = await readFile(destination, "utf8");
          const record = JSON.parse(previous);
          if (!record || record.id !== taskId) throw new Error("Invalid existing task record.");
        } catch (error) {
          if (error.code !== "ENOENT") {
            damagedTasks.add(taskId);
            throw Object.assign(new Error("TASK_FILE_CORRUPT: original preserved; repair explicitly before replacing it."), { code: "TASK_FILE_CORRUPT" });
          }
        }
        if (previous !== serialized) await atomicWrite(destination, serialized);
        ids.add(taskId); saved.push(taskId);
      } catch (error) { failed.push({ id: taskId, error: error.message, code: error.code || "" }); }
    }
    // Absence from a renderer snapshot is NOT a deletion. Production clients
    // supply explicit ids AND a matching revision; partial saves never delete.
    const deleted = [];
    if (!failed.length && !options.migration && options.deletedTaskIds?.length) {
      if (options.expectedRevision === undefined) throw new Error("Task deletion requires a revision.");
      for (const id of options.deletedTaskIds) {
        assertTaskId(id);
        if (seen.has(id) || damagedTasks.has(id)) throw new Error("Cannot delete a present or damaged task implicitly.");
        if (ids.delete(id)) deleted.push(id);
      }
    }
    const nextRevision = revision + 1;
    await writeIndex([...ids], nextRevision);
    // Deletion becomes durable at index commit. Keep originals in a tombstone
    // directory for recovery; no recursive prune driven by a partial snapshot.
    for (const id of deleted) {
      try { const destination = join(root, "deleted", `${id}.${nextRevision}.json`);
        await mkdir(dirname(destination), { recursive: true }); await rename(taskPath(id), destination); }
      catch (error) { if (error.code !== "ENOENT") diagnose("TASK_DELETE_ARCHIVE_FAILED", taskPath(id), error); }
    }
    return { ok: failed.length === 0, saved, failed, deleted, revision: nextRevision };
  }

  const loadTasks = () => serializeStorage(root, loadTasksInternal);
  const loadSnapshot = () => serializeStorage(root, async () => {
    const tasks = await loadTasksInternal();
    return { tasks, revision: (await readIndex())?.revision ?? 0, diagnostics: [...diagnostics], readOnly: damagedIndex };
  });
  const saveTasks = (tasks, options = {}) => {
    // Snapshot at admission, not when the writer eventually acquires the queue.
    const snapshot = structuredClone(tasks), settings = structuredClone(options);
    return serializeStorage(root, () => saveTasksInternal(snapshot, settings));
  };

  async function hydrateAttachmentBytes(attachment) {
    if (!attachment?.hash || attachment.dataUrl) return attachment;
    const blob = await readBlob(attachment.hash);
    const type = attachment.type || blob.type || "application/octet-stream";
    return {
      ...attachment,
      type,
      size: attachment.size || blob.size,
      dataUrl: `data:${type};base64,${blob.buffer.toString("base64")}`,
    };
  }

  async function hydrateMessages(messages) {
    return Promise.all(
      (Array.isArray(messages) ? messages : []).map(async (message) => ({
        ...message,
        attachments: await Promise.all(
          (Array.isArray(message?.attachments) ? message.attachments : []).map(
            hydrateAttachmentBytes,
          ),
        ),
      })),
    );
  }

  return {
    root,
    blobPath,
    putBlob,
    readBlob,
    persistAttachment,
    persistTask,
    hydrateMessages,
    loadTask: (id) => readTaskFile(assertTaskId(id)),
    loadTasks,
    loadSnapshot,
    diagnostics: () => [...diagnostics],
    saveTasks,
  };
}
