import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const RUN_STORE_VERSION = 1;
const RUN_ID_PATTERN = /^[a-zA-Z0-9._-]{1,100}$/;

function assertRunId(runId) {
  if (!RUN_ID_PATTERN.test(String(runId || ""))) {
    throw new Error("Invalid run id for the persistent run store.");
  }
  return String(runId);
}

function getRunStoreDirectory(dataDirectory) {
  return join(dataDirectory, "aporiax-runs");
}

function getRunPaths(dataDirectory, runId) {
  const safeRunId = assertRunId(runId);
  const directory = getRunStoreDirectory(dataDirectory);
  return {
    directory,
    metadata: join(directory, `${safeRunId}.json`),
    events: join(directory, `${safeRunId}.jsonl`),
  };
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
    await rm(path, { force: true });
    await rename(temporaryPath, path);
  }
}

export async function beginRunJournal(dataDirectory, input) {
  const runId = assertRunId(input?.runId);
  const paths = getRunPaths(dataDirectory, runId);
  const now = new Date().toISOString();
  const metadata = {
    version: RUN_STORE_VERSION,
    runId,
    taskId: String(input?.taskId || ""),
    assistantId: String(input?.assistantId || ""),
    sourceUserId: String(input?.sourceUserId || ""),
    prompt: String(input?.prompt || "").slice(0, 40_000),
    workspacePath: String(input?.workspacePath || ""),
    providerId: String(input?.providerId || ""),
    modelId: String(input?.modelId || ""),
    recoveryOfRunId: String(input?.recoveryOfRunId || ""),
    status: "running",
    startedAt: now,
    updatedAt: now,
    lastEventType: "run.created",
  };
  await mkdir(paths.directory, { recursive: true });
  await writeJsonAtomic(paths.metadata, metadata);
  await appendFile(
    paths.events,
    `${JSON.stringify({
      type: "run.created",
      at: now,
      runId,
      taskId: metadata.taskId,
      assistantId: metadata.assistantId,
      sourceUserId: metadata.sourceUserId,
    })}\n`,
    "utf8",
  );
  return metadata;
}

export async function appendRunJournalEvent(
  dataDirectory,
  runId,
  event,
) {
  const paths = getRunPaths(dataDirectory, runId);
  await mkdir(paths.directory, { recursive: true });
  const record = {
    at: new Date().toISOString(),
    runId,
    ...event,
  };
  await appendFile(paths.events, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function updateRunJournalMetadata(
  dataDirectory,
  runId,
  patch,
) {
  const paths = getRunPaths(dataDirectory, runId);
  let current = {};
  try {
    current = JSON.parse(await readFile(paths.metadata, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const next = {
    version: RUN_STORE_VERSION,
    runId,
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(paths.metadata, next);
  return next;
}

export async function finishRunJournal(
  dataDirectory,
  runId,
  result,
) {
  const now = new Date().toISOString();
  await appendRunJournalEvent(dataDirectory, runId, {
    type: "run.finished",
    status: result?.status || "failed",
    changedFiles: result?.changes?.length || 0,
    at: now,
  });
  return updateRunJournalMetadata(dataDirectory, runId, {
    status: result?.status || "failed",
    completedAt: now,
    lastEventType: "run.finished",
  });
}

export async function listRecoverableRuns(dataDirectory) {
  const directory = getRunStoreDirectory(dataDirectory);
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(
    entries
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(".json"),
      )
      .map(async (entry) => {
        try {
          return JSON.parse(
            await readFile(join(directory, entry.name), "utf8"),
          );
        } catch {
          return null;
        }
      }),
  );
  return records
    .filter(
      (record) =>
        record && ["running", "paused"].includes(record.status),
    )
    .sort((left, right) =>
      String(left.startedAt || "").localeCompare(
        String(right.startedAt || ""),
      ),
    );
}

export async function getRunRecoveryContext(dataDirectory, runId) {
  const paths = getRunPaths(dataDirectory, runId);
  const metadata = JSON.parse(await readFile(paths.metadata, "utf8"));
  let events = [];
  try {
    events = (await readFile(paths.events, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-120)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .map((event) => ({
        at: event.at || event.timestamp || null,
        type: event.type || "unknown",
        tool: event.tool || null,
        path: event.path || null,
        command: event.command || null,
        status: event.status || null,
        title: event.title || null,
        detail: event.detail || null,
        error: event.error ? String(event.error).slice(0, 500) : null,
      }));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    runId: metadata.runId,
    taskId: metadata.taskId,
    sourceUserId: metadata.sourceUserId,
    prompt: metadata.prompt,
    workspacePath: metadata.workspacePath,
    startedAt: metadata.startedAt,
    lastEventType: metadata.lastEventType,
    events,
  };
}

export async function markRunRecoveryStarted(
  dataDirectory,
  runId,
  resumedByRunId,
) {
  await appendRunJournalEvent(dataDirectory, runId, {
    type: "run.recovery_started",
    resumedByRunId,
  });
  return updateRunJournalMetadata(dataDirectory, runId, {
    status: "interrupted",
    resumedByRunId: String(resumedByRunId || ""),
    resumedAt: new Date().toISOString(),
    lastEventType: "run.recovery_started",
  });
}

export async function acknowledgeRecoverableRun(dataDirectory, runId) {
  await appendRunJournalEvent(dataDirectory, runId, {
    type: "run.recovery_acknowledged",
  });
  return updateRunJournalMetadata(dataDirectory, runId, {
    status: "interrupted",
    recoveredAt: new Date().toISOString(),
    lastEventType: "run.recovery_acknowledged",
  });
}
