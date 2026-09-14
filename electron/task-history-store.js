import { createHash } from "node:crypto";
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

async function atomicWrite(filePath, contents) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, contents);
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EEXIST") {
      await rm(filePath, { force: true });
      await rename(tempPath, filePath);
      return;
    }
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

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
      await readFile(file);
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
      const ids = Array.isArray(parsed?.taskIds) ? parsed.taskIds : [];
      return ids.map(String).filter((id) => TASK_ID_PATTERN.test(id));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return null;
    }
  }

  async function writeIndex(taskIds) {
    await atomicWrite(
      indexPath,
      JSON.stringify({
        version: TASK_HISTORY_STORE_VERSION,
        taskIds,
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  async function readTaskFile(taskId) {
    try {
      const parsed = JSON.parse(await readFile(taskPath(taskId), "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return null;
    }
  }

  async function migrateLegacyIfNeeded() {
    const existing = await readIndex();
    if (existing) return;
    let legacy;
    let legacyPath = "";
    for (const candidate of legacyPaths) {
      try {
        legacy = JSON.parse(await readFile(candidate, "utf8"));
        legacyPath = candidate;
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (!legacyPath) return;
    if (!Array.isArray(legacy)) return;
    const result = await saveTasks(legacy, {
      writeIndex: false,
      pruneStale: false,
    });
    await writeIndex(result.saved);
    try {
      await rename(legacyPath, `${legacyPath}.migrated`);
    } catch {
      await rm(legacyPath, { force: true });
    }
  }

  async function loadTasks() {
    await migrateLegacyIfNeeded();
    let ids = await readIndex();
    if (!ids) {
      try {
        ids = (await readdir(tasksDir))
          .filter((name) => name.endsWith(".json"))
          .map((name) => name.slice(0, -5))
          .filter((id) => TASK_ID_PATTERN.test(id));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        return null;
      }
    }
    const tasks = [];
    for (const id of ids) {
      if (!TASK_ID_PATTERN.test(id)) continue;
      const task = await readTaskFile(id);
      if (task) tasks.push(hydrateTask(task));
    }
    return tasks;
  }

  async function saveTasks(tasks, { writeIndex: shouldWriteIndex = true, pruneStale = true } = {}) {
    if (!Array.isArray(tasks)) {
      throw new Error("Tasks must be an array.");
    }
    await mkdir(tasksDir, { recursive: true });
    await mkdir(blobsDir, { recursive: true });
    const saved = [];
    const failed = [];
    const taskIds = [];
    for (const task of tasks) {
      const taskId = String(task?.id || "");
      if (!TASK_ID_PATTERN.test(taskId)) {
        failed.push({
          id: taskId || "(missing)",
          error: "Invalid task id.",
        });
        continue;
      }
      taskIds.push(taskId);
      try {
        const persisted = await persistTask(task);
        const serialized = JSON.stringify(persisted);
        const bytes = Buffer.byteLength(serialized, "utf8");
        if (bytes > taskJsonLimit) {
          const error = new Error(
            `Task JSON exceeds the ${Math.floor(taskJsonLimit / (1024 * 1024))} MB limit.`,
          );
          error.code = TASK_JSON_TOO_LARGE;
          throw error;
        }
        const destination = taskPath(taskId);
        try {
          const previous = await readFile(destination, "utf8");
          if (previous === serialized) {
            saved.push(taskId);
            continue;
          }
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        await atomicWrite(destination, serialized);
        saved.push(taskId);
      } catch (error) {
        failed.push({
          id: taskId,
          error: error?.message || "Failed to save this task.",
          code: error?.code || "",
        });
      }
    }
    if (shouldWriteIndex) {
      await writeIndex(taskIds);
    }
    if (pruneStale) {
      try {
        const kept = new Set(taskIds);
        for (const name of await readdir(tasksDir)) {
          if (!name.endsWith(".json")) continue;
          const id = name.slice(0, -5);
          if (kept.has(id)) continue;
          await rm(taskPath(id), { force: true });
        }
      } catch {
        // Removing stale task files is best-effort.
      }
    }
    return {
      ok: failed.length === 0,
      saved,
      failed,
    };
  }

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
    saveTasks,
  };
}
