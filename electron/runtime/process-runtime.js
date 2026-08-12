import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createHostFallbackEnvironment } from "../sandbox-runtime.js";
import { currentExecutionMode } from "../harness/agent-budget.js";

const MAX_LOG_CHARS = 400_000;
const MAX_INPUT_CHARS = 64_000;
const MAX_PROCESSES = 8;

function shellCommand(command) {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    return {
      program: join(systemRoot, "System32", "cmd.exe"),
      args: ["/d", "/s", "/c", command],
    };
  }
  return { program: "/bin/sh", args: ["-lc", command] };
}

function disposeChildStreams(child) {
  for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
    try {
      stream?.destroy();
    } catch {
      // Stream may already be closed by the child.
    }
  }
}

function terminateTree(child) {
  if (!child?.pid) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may already be gone.
    }
  }
  return Promise.resolve();
}

function publicState(record) {
  return {
    processId: record.id,
    pid: record.child.pid || null,
    command: record.command,
    cwd: record.cwd,
    status: record.status,
    exitCode: record.exitCode,
    signal: record.signal,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    requestedExecutionMode: record.requestedExecutionMode,
    executionBackend: "host",
    cursor: record.baseOffset + record.output.length,
  };
}

export function createPersistentProcessManager({ emit = () => {} } = {}) {
  const processes = new Map();

  function recordFor(id) {
    const record = processes.get(String(id || ""));
    if (!record) throw new Error("Unknown or expired managed process.");
    return record;
  }

  function append(record, stream, chunk) {
    const text = chunk.toString("utf8");
    if (!text) return;
    record.output += `[${stream}] ${text}`;
    if (record.output.length > MAX_LOG_CHARS) {
      const removed = record.output.length - MAX_LOG_CHARS;
      record.output = record.output.slice(removed);
      record.baseOffset += removed;
    }
    emit({
      type: "process.output",
      processId: record.id,
      stream,
      text: text.slice(0, 8_000),
    });
  }

  return {
    start({ command, cwd }) {
      const normalized = String(command || "").trim();
      if (!normalized || normalized.length > 2_000) {
        throw new Error("Persistent command must be between 1 and 2000 characters.");
      }
      const activeCount = [...processes.values()].filter((record) => record.status === "running").length;
      if (activeCount >= MAX_PROCESSES) {
        throw new Error(`At most ${MAX_PROCESSES} persistent processes may run in one task.`);
      }
      const requestedExecutionMode = currentExecutionMode() || "safe";
      if (requestedExecutionMode === "isolated") {
        throw new Error(
          "Persistent terminal processes do not silently fall back to Host in Isolated mode. Use a bounded run_command or switch this task to Direct/Safe mode.",
        );
      }
      const shell = shellCommand(normalized);
      const child = spawn(shell.program, shell.args, {
        cwd,
        env: createHostFallbackEnvironment(process.env, "persistent-host"),
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const record = {
        id: `proc_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        child,
        command: normalized,
        cwd,
        status: "running",
        exitCode: null,
        signal: null,
        output: "",
        baseOffset: 0,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        requestedExecutionMode,
      };
      processes.set(record.id, record);
      child.stdout.on("data", (chunk) => append(record, "stdout", chunk));
      child.stderr.on("data", (chunk) => append(record, "stderr", chunk));
      child.stdin.on("error", (error) => append(record, "stdin-error", `${error.message}\n`));
      child.on("error", (error) => append(record, "error", `${error.message}\n`));
      child.on("close", (code, signal) => {
        record.status = "exited";
        record.exitCode = typeof code === "number" ? code : null;
        record.signal = signal || null;
        record.finishedAt = new Date().toISOString();
        disposeChildStreams(child);
        emit({ type: "process.exited", ...publicState(record) });
      });
      emit({ type: "process.started", ...publicState(record) });
      return publicState(record);
    },

    read({ processId, cursor = 0, maxChars = 40_000 }) {
      const record = recordFor(processId);
      const requestedCursor = Math.max(0, Number(cursor) || 0);
      const start = Math.max(0, requestedCursor - record.baseOffset);
      const limit = Math.max(1, Math.min(80_000, Number(maxChars) || 40_000));
      const output = record.output.slice(start, start + limit);
      const nextCursor = record.baseOffset + start + output.length;
      return {
        ...publicState(record),
        output,
        cursor: nextCursor,
        cursorExpired: requestedCursor < record.baseOffset,
        hasMore: nextCursor < record.baseOffset + record.output.length,
      };
    },

    write({ processId, data, close = false }) {
      const record = recordFor(processId);
      if (record.status !== "running" || !record.child.stdin?.writable) {
        throw new Error("Managed process stdin is no longer writable.");
      }
      const text = String(data ?? "");
      if (text.length > MAX_INPUT_CHARS) {
        throw new Error(`stdin payload must be at most ${MAX_INPUT_CHARS} characters.`);
      }
      record.child.stdin.write(text);
      if (close) record.child.stdin.end();
      return { ...publicState(record), bytesWritten: Buffer.byteLength(text), stdinClosed: Boolean(close) };
    },

    async kill(processId) {
      const record = recordFor(processId);
      if (record.status === "running") {
        record.status = "stopping";
        await terminateTree(record.child);
        disposeChildStreams(record.child);
      }
      return publicState(record);
    },

    async closeAll() {
      await Promise.all([...processes.values()].map(async (record) => {
        if (record.status === "running" || record.status === "stopping") {
          await terminateTree(record.child);
        }
        disposeChildStreams(record.child);
      }));
      processes.clear();
    },
  };
}
