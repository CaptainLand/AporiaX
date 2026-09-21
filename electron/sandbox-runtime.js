import { randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
// Workspaces may contain other Electron releases. Treat their ASAR archives
// as ordinary files, not Electron's virtual directories, during copy/sync.
const { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, statfs, writeFile } =
  process.versions.electron ? createRequire(import.meta.url)("original-fs").promises : fsPromises;
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { runtimeRunControl } from "./runtime/durable-run.js";
import { activeTimeout } from "./runtime/run-control.js";
import { currentExecutionMode } from "./harness/agent-budget.js";
import { applySandboxChanges, atomicJson, checkAbort, copyPrivateDependencies, hashSandboxFile, SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_FILES } from "./sandbox-files.js";

export const SANDBOX_IMAGE = "aporiax-sandbox:0.2";
export const SANDBOX_TIMEOUT_MS = 120_000;
export const COMMAND_WATCHDOG_SLOW_MS = 45_000;
export const COMMAND_WATCHDOG_INTERVENTION_MS = SANDBOX_TIMEOUT_MS;
export const SANDBOX_MEMORY = "1536m";
export const SANDBOX_CPUS = "2";
export const SANDBOX_PIDS_LIMIT = 256;
const MAX_SANDBOX_OUTPUT_CHARS = 80_000;
const STATUS_TIMEOUT_MS = 8_000;
const PREPARE_TIMEOUT_MS = 15 * 60_000;
const LOCAL_SANDBOX_DIRECTORY = "aporiax-local-sandbox";
const LOCAL_SANDBOX_MAX_FILES = 25_000;
const LOCAL_SANDBOX_IGNORED_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".pnpm-store",
  ".yarn",
  "node_modules",
]);

export const SANDBOX_DOCKERFILE = `FROM node:22.16.0-bookworm-slim

RUN apt-get update \\
    && apt-get install -y --no-install-recommends \\
      build-essential \\
      ca-certificates \\
      git \\
      python3 \\
      python3-pip \\
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /home/aporiax /workspace \\
    && chown -R node:node /home/aporiax /workspace

USER node
WORKDIR /workspace
ENV HOME=/home/aporiax
ENV CI=1
ENV NO_COLOR=1

CMD ["sh"]
`;

function trimOutput(value, maximum = MAX_SANDBOX_OUTPUT_CHARS) {
  if (value.length <= maximum) return value;
  const half = Math.floor(maximum / 2);
  return `${value.slice(0, half)}\n\n… output truncated …\n\n${value.slice(-half)}`;
}

function createAbortError(message = "Sandbox execution was interrupted.") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      const systemRoot = process.env.SystemRoot || "C:\\Windows";
      const killed = spawnSync(
        join(systemRoot, "System32", "taskkill.exe"),
        ["/pid", String(child.pid), "/t", "/f"],
        { windowsHide: true, stdio: "ignore", timeout: 5_000 },
      );
      if (!killed.error && killed.status === 0) return;
    } catch {
      // Fall through to the direct child kill below.
    }
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // The process may not own a detached group.
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // The child may already have exited.
  }
}

function runProcess({
  program,
  args,
  cwd,
  env,
  signal,
  timeoutMs,
  onOutput,
  onWatchdog,
  watchdogSlowMs = COMMAND_WATCHDOG_SLOW_MS,
}) {
  if (signal?.aborted) return Promise.reject(createAbortError());
  const control = runtimeRunControl();
  const activeNow = control?.activeNow || Date.now;

  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forcedFinish = null;
    let lastOutputAt = activeNow();
    const watchdogEvents = [];
    const child = spawn(program, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      timeout();
      slowTimer();
      if (forcedFinish) clearTimeout(forcedFinish);
      signal?.removeEventListener("abort", handleAbort);
      callback(value);
    };
    const handleAbort = () => {
      terminateProcessTree(child);
      finish(rejectPromise, createAbortError());
    };
    const notifyWatchdog = (stage, detail = {}) => {
      const notice = {
        stage,
        elapsedMs: activeNow() - startedAt,
        idleMs: activeNow() - lastOutputAt,
        ...detail,
      };
      watchdogEvents.push(notice);
      onWatchdog?.(notice);
    };
    const startedAt = activeNow();
    const slowTimer = activeTimeout(() => {
      if (!settled) notifyWatchdog("slow");
    }, Math.min(watchdogSlowMs, Math.max(10, timeoutMs - 1)), control);
    const timeout = activeTimeout(() => {
      timedOut = true;
      notifyWatchdog("intervention", { reason: "timeout" });
      terminateProcessTree(child);
      forcedFinish = setTimeout(() => {
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        child.unref?.();
        finish(resolvePromise, {
          exitCode: null,
          signal: "WATCHDOG_TIMEOUT",
          timedOut: true,
          stdout,
          stderr,
          watchdogEvents,
        });
      }, 4_000);
      forcedFinish.unref?.();
    }, timeoutMs, control);

    signal?.addEventListener("abort", handleAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      lastOutputAt = activeNow();
      stdout = trimOutput(stdout + text);
      onOutput?.({ stream: "stdout", text });
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      lastOutputAt = activeNow();
      stderr = trimOutput(stderr + text);
      onOutput?.({ stream: "stderr", text });
    });
    child.on("error", (error) => finish(rejectPromise, error));
    child.on("close", (code, signalName) => {
      finish(resolvePromise, {
        exitCode: typeof code === "number" ? code : null,
        signal: signalName || null,
        timedOut,
        stdout,
        stderr,
        watchdogEvents,
      });
    });
  });
}

async function dockerResult(args, options = {}) {
  return runProcess({
    program: "docker",
    args,
    timeoutMs: options.timeoutMs || STATUS_TIMEOUT_MS,
    ...options,
  });
}

function sandboxState({
  state,
  detail,
  engineVersion = "",
  imageReady = false,
  imageId = "",
}) {
  return {
    backend: state === "ready" ? "docker" : "local-workspace",
    state,
    available: state === "ready",
    localAvailable: true,
    autoApprovalSafe: true,
    fallbackAvailable: true,
    executionMode: state === "ready" ? "container" : "local-workspace",
    detail,
    engineVersion,
    image: SANDBOX_IMAGE,
    imageReady,
    imageId,
    network: state === "ready" ? "none" : "host",
    filesystem:
      state === "ready" ? "workspace-write" : "temporary-workspace-copy",
    rootFilesystem: state === "ready" ? "read-only" : "host",
    isolation: state === "ready" ? "os-container" : "workspace-copy",
    memory: SANDBOX_MEMORY,
    cpus: Number(SANDBOX_CPUS),
    pidsLimit: SANDBOX_PIDS_LIMIT,
  };
}

async function getSandboxEngineStatus() {
  let versionResult;
  try {
    versionResult = await dockerResult([
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return sandboxState({
        state: "cli-missing",
        detail:
          "本地工作区沙箱已就绪。Docker 未安装；如需断网、只读系统等更强隔离，可选装 Docker Desktop。",
      });
    }
    return sandboxState({
      state: "engine-stopped",
      detail: `本地工作区沙箱已就绪。Docker 暂不可用（${error?.message || "未知错误"}），不会影响本地沙箱自动执行。`,
    });
  }

  if (versionResult.exitCode !== 0 || !versionResult.stdout.trim()) {
    return sandboxState({
      state: "engine-stopped",
      detail:
        "本地工作区沙箱已就绪。Docker Desktop 未启动；启动后可自动升级为更强的容器隔离。",
    });
  }
  const engineVersion = versionResult.stdout.trim();
  const imageResult = await dockerResult([
    "image",
    "inspect",
    SANDBOX_IMAGE,
    "--format",
    "{{.Id}}",
  ]);
  if (imageResult.exitCode !== 0) {
    return sandboxState({
      state: "image-missing",
      detail:
        "本地工作区沙箱已就绪。Docker 已连接，可选准备 AporiaX 镜像以启用更强隔离。",
      engineVersion,
    });
  }
  return sandboxState({
    state: "ready",
    detail: "Docker 强隔离沙箱已就绪：默认断网、只读系统，仅工作区可写。",
    engineVersion,
    imageReady: true,
    imageId: imageResult.stdout.trim(),
  });
}

export function projectSandboxStatusForExecutionMode(status, executionMode = null) {
  const mode = ["direct", "safe", "isolated"].includes(executionMode)
    ? executionMode
    : null;
  if (!mode) return status;
  const dockerAvailable = Boolean(status?.available);
  if (mode === "direct") {
    return {
      ...status,
      executionProfile: "direct",
      dockerAvailable,
      backend: "host",
      available: false,
      localAvailable: false,
      autoApprovalSafe: false,
      fallbackAvailable: true,
      executionMode: "host",
      network: "host",
      filesystem: "workspace-write",
      rootFilesystem: "host",
      isolation: "none",
      detail: "Direct execution selected: commands use the real workspace and host authority. Smart Permission remains active.",
    };
  }
  if (mode === "safe") {
    return {
      ...status,
      executionProfile: "safe",
      dockerAvailable,
      backend: "local-workspace",
      available: false,
      localAvailable: true,
      autoApprovalSafe: true,
      fallbackAvailable: true,
      executionMode: "local-workspace",
      network: "host",
      filesystem: "temporary-workspace-copy",
      rootFilesystem: "host",
      isolation: "workspace-copy",
      detail: "Safe execution selected: commands use a temporary workspace copy with conflict-checked synchronization and host process/network authority.",
    };
  }
  return {
    ...status,
    executionProfile: "isolated",
    dockerAvailable,
    backend: "docker",
    localAvailable: false,
    autoApprovalSafe: dockerAvailable,
    fallbackAvailable: false,
    executionMode: "container",
    detail: dockerAvailable
      ? status.detail
      : `Isolated execution selected, but Docker is not ready. ${status?.detail || ""}`.trim(),
  };
}

export async function getSandboxStatus() {
  const status = await getSandboxEngineStatus();
  return projectSandboxStatusForExecutionMode(status, currentExecutionMode());
}

export async function prepareSandbox({
  dataDirectory,
  signal,
  onOutput,
}) {
  if (!dataDirectory) {
    throw new Error("Sandbox data directory is required.");
  }
  const status = await getSandboxEngineStatus();
  if (status.state === "cli-missing") {
    throw new Error("未找到 Docker CLI。请先安装 Docker Desktop。");
  }
  if (status.state === "engine-stopped") {
    throw new Error("Docker Desktop 尚未启动，请启动后重试。");
  }
  if (status.available) return status;

  const contextDirectory = join(dataDirectory, "sandbox-image");
  await mkdir(contextDirectory, { recursive: true });
  await writeFile(
    join(contextDirectory, "Dockerfile"),
    SANDBOX_DOCKERFILE,
    "utf8",
  );
  const result = await dockerResult(
    [
      "build",
      "--pull",
      "--tag",
      SANDBOX_IMAGE,
      "--file",
      join(contextDirectory, "Dockerfile"),
      contextDirectory,
    ],
    {
      signal,
      timeoutMs: PREPARE_TIMEOUT_MS,
      onOutput,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `Sandbox image build failed with exit code ${result.exitCode}.`,
    );
  }
  const nextStatus = await getSandboxStatus();
  if (!nextStatus.available) {
    throw new Error(nextStatus.detail || "Sandbox image is unavailable.");
  }
  return nextStatus;
}

function containerPath(relativePath) {
  const normalized = String(relativePath || ".")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  return normalized && normalized !== "."
    ? `/workspace/${normalized}`
    : "/workspace";
}

export function buildDockerSandboxArgs({
  command,
  workspaceRoot,
  cwd = ".",
  containerName,
  protectGit = false,
}) {
  const args = [
    "run",
    "--rm",
    "--pull",
    "never",
    "--name",
    containerName,
    "--label",
    "com.aporiax.sandbox=true",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--pids-limit",
    String(SANDBOX_PIDS_LIMIT),
    "--memory",
    SANDBOX_MEMORY,
    "--memory-swap",
    SANDBOX_MEMORY,
    "--cpus",
    SANDBOX_CPUS,
    "--ulimit",
    "nofile=1024:1024",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=256m",
    "--tmpfs",
    "/home/aporiax:rw,nosuid,size=128m",
    "--env",
    "HOME=/home/aporiax",
    "--env",
    "CI=1",
    "--env",
    "NO_COLOR=1",
    "--user",
    "1000:1000",
    "--volume",
    `${workspaceRoot}:/workspace:rw`,
    "--workdir",
    containerPath(cwd),
  ];
  if (protectGit) {
    args.push(
      "--volume",
      `${join(workspaceRoot, ".git")}:/workspace/.git:ro`,
    );
  }
  args.push(SANDBOX_IMAGE, "sh", "-lc", command);
  return args;
}

async function stopSandboxContainer(containerName) {
  try {
    await dockerResult(["rm", "--force", containerName], {
      timeoutMs: 10_000,
    });
  } catch {
    // Cleanup is best-effort after the client was interrupted.
  }
}

export async function runSandboxedCommand({
  command,
  workspaceRoot,
  cwd,
  signal,
  onOutput,
  onWatchdog,
  timeoutMs = COMMAND_WATCHDOG_INTERVENTION_MS,
  watchdogSlowMs = COMMAND_WATCHDOG_SLOW_MS,
  sandboxStatus,
}) {
  const status = sandboxStatus?.available
    ? sandboxStatus
    : await getSandboxStatus();
  if (!status.available) {
    throw new Error(
      `Sandbox unavailable: ${status.detail} Host execution is disabled.`,
    );
  }
  let protectGit = false;
  try {
    protectGit = (await lstat(join(workspaceRoot, ".git"))).isDirectory();
  } catch {
    protectGit = false;
  }
  const containerName = `aporiax-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const relativeCwd =
    relative(workspaceRoot, cwd).replace(/\\/g, "/") || ".";
  const args = buildDockerSandboxArgs({
    command,
    workspaceRoot,
    cwd: relativeCwd,
    containerName,
    protectGit,
  });

  const cleanup = () => void stopSandboxContainer(containerName);
  signal?.addEventListener("abort", cleanup, { once: true });
  try {
    const result = await dockerResult(args, {
      signal,
      timeoutMs,
      onOutput,
      onWatchdog,
      watchdogSlowMs,
    });
    if (result.timedOut) cleanup();
    if (result.exitCode === 125) {
      throw new Error(
        result.stderr.trim() ||
          "Docker refused to start the sandbox container.",
      );
    }
    return {
      ...result,
      sandbox: {
        backend: "docker",
        executionProfile: "isolated",
        container: containerName,
        image: SANDBOX_IMAGE,
        imageId: status.imageId,
        network: "none",
        rootFilesystem: "read-only",
        workspace: "read-write",
        gitMetadata: protectGit ? "read-only" : "not-mounted",
        memory: SANDBOX_MEMORY,
        cpus: Number(SANDBOX_CPUS),
        pidsLimit: SANDBOX_PIDS_LIMIT,
      },
    };
  } finally {
    signal?.removeEventListener("abort", cleanup);
  }
}

const SENSITIVE_ENVIRONMENT_NAME =
  /(api[_-]?key|token|secret|password|passwd|credential|cookie|authorization|private[_-]?key|session)/i;
const UNSAFE_RUNTIME_ENVIRONMENT_NAME =
  /^(NODE_OPTIONS|ELECTRON_RUN_AS_NODE|NODE_REPL_HISTORY)$/i;

export function createHostFallbackEnvironment(
  sourceEnvironment = process.env,
  executionMarker = "local-workspace-sandbox",
) {
  const environment = {};
  const normalizedNames = new Set();
  for (const [name, value] of Object.entries(sourceEnvironment || {})) {
    if (
      typeof value !== "string" ||
      SENSITIVE_ENVIRONMENT_NAME.test(name) ||
      UNSAFE_RUNTIME_ENVIRONMENT_NAME.test(name)
    ) {
      continue;
    }
    const normalizedName = name.toUpperCase();
    if (normalizedNames.has(normalizedName)) continue;
    normalizedNames.add(normalizedName);
    environment[name] = value;
  }
  environment.APORIAX_EXECUTION_MODE = executionMarker;
  environment.CI = environment.CI || "1";
  environment.NO_COLOR = environment.NO_COLOR || "1";
  return environment;
}

function isPathInside(rootPath, targetPath) {
  const pathFromRoot = relative(resolve(rootPath), resolve(targetPath));
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

function shouldIgnoreLocalSandboxPath(relativePath) {
  if (!relativePath) return false;
  return relativePath
    .split(/[\\/]+/)
    .some((part) => LOCAL_SANDBOX_IGNORED_NAMES.has(part));
}

async function scanLocalSandboxFiles(rootPath, signal) {
  const files = new Map();
  files.bytes = 0;
  const pending = [{ absolutePath: rootPath, relativePath: "" }];
  while (pending.length) {
    const current = pending.pop();
    checkAbort(signal);
    const entries = await readdir(current.absolutePath, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const entryRelativePath = current.relativePath
        ? join(current.relativePath, entry.name)
        : entry.name;
      if (shouldIgnoreLocalSandboxPath(entryRelativePath)) continue;
      const entryAbsolutePath = join(current.absolutePath, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Local sandbox does not sync symbolic links: ${entryRelativePath}`,
        );
      }
      if (entry.isDirectory()) {
        pending.push({
          absolutePath: entryAbsolutePath,
          relativePath: entryRelativePath,
        });
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `Local sandbox found an unsupported file type: ${entryRelativePath}`,
        );
      }
      files.bytes += (await lstat(entryAbsolutePath)).size;
      if (files.bytes > SNAPSHOT_MAX_BYTES) throw new Error("Local sandbox project exceeds the 2 GB snapshot budget.");
      files.set(entryRelativePath, await hashSandboxFile(entryAbsolutePath, signal));
      if (files.size > LOCAL_SANDBOX_MAX_FILES) {
        throw new Error(
          `Local sandbox supports at most ${LOCAL_SANDBOX_MAX_FILES} project files.`,
        );
      }
    }
  }
  return files;
}

async function copyWorkspaceToLocalSandbox(
  workspaceRoot,
  sandboxWorkspace,
  { budget, signal, dependencySource = null } = {},
) {
  const dependencies = [];
  await cp(workspaceRoot, sandboxWorkspace, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: async (sourcePath) => {
      checkAbort(signal);
      const sourceRelativePath = relative(workspaceRoot, sourcePath);
      if (sourceRelativePath.split(/[\\/]/).at(-1) === "node_modules") dependencies.push(sourceRelativePath);
      if (shouldIgnoreLocalSandboxPath(sourceRelativePath)) return false;
      if (!sourceRelativePath) return true;
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) return false;
      if (info.isFile()) {
        budget.files++; budget.bytes += info.size;
        if (budget.files > budget.maxFiles || budget.bytes > budget.maxBytes) throw new Error("Safe workspace copy exceeds the file/byte budget.");
      }
      return true;
    },
  });

  if (dependencySource) {
    // Discover dependencies installed by an earlier command, including package
    // subdirectories absent from the host's original node_modules tree.
    const pending = [""];
    while (pending.length) {
      const path = pending.pop();
      for (const entry of await readdir(join(dependencySource, path), { withFileTypes: true })) {
        if (entry.name === "node_modules") dependencies.push(join(path, entry.name));
        else if (entry.isDirectory() && !LOCAL_SANDBOX_IGNORED_NAMES.has(entry.name)) pending.push(join(path, entry.name));
      }
    }
  }
  for (const path of new Set(dependencies)) {
    let source = workspaceRoot;
    if (dependencySource) {
      try { await lstat(join(dependencySource, path)); source = dependencySource; }
      catch (error) { if (error.code !== "ENOENT") throw error; continue; }
    }
    await copyPrivateDependencies(join(source, path), join(sandboxWorkspace, path), source, budget, signal);
  }
}

async function synchronizeLocalSandbox({
  workspaceRoot,
  sandboxWorkspace,
  sandboxDirectory,
  baselineFiles,
  manifest,
  signal,
  beforeApply,
}) {
  const sandboxFiles = await scanLocalSandboxFiles(sandboxWorkspace, signal);
  return applySandboxChanges({ workspaceRoot, sandboxWorkspace, sandboxDirectory, baselineFiles, sandboxFiles, manifest, signal, beforeApply });
}

export function localSandboxRootPath(baseDirectory) {
  return resolve(
    baseDirectory || tmpdir(),
    LOCAL_SANDBOX_DIRECTORY,
  );
}

async function createLocalSandboxDirectory(baseDirectory) {
  const localSandboxRoot = localSandboxRootPath(baseDirectory);
  await mkdir(localSandboxRoot, { recursive: true });
  const retained = (await readdir(localSandboxRoot, { withFileTypes: true })).filter((item) => item.isDirectory() && !item.name.startsWith("."));
  if (retained.length >= 20) throw new Error(`Safe sandbox has 20 retained/active snapshots. Review and clean recovery folders before continuing: ${localSandboxRoot}`);
  return mkdtemp(join(localSandboxRoot, `${process.pid}-`));
}

async function removeLocalSandboxDirectory(
  sandboxDirectory,
  baseDirectory,
) {
  const localSandboxRoot = localSandboxRootPath(baseDirectory);
  if (
    sandboxDirectory === localSandboxRoot ||
    !isPathInside(localSandboxRoot, sandboxDirectory)
  ) {
    throw new Error("Refused to remove an unsafe local sandbox path.");
  }
  await rm(sandboxDirectory, { recursive: true, force: true });
}

function hostShell(command) {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    return {
      program: join(systemRoot, "System32", "cmd.exe"),
      args: ["/d", "/s", "/c", command],
    };
  }
  return {
    program: "/bin/sh",
    args: ["-lc", command],
  };
}

export async function runLocalSandboxedCommand({
  command,
  workspaceRoot,
  cwd,
  signal,
  onOutput,
  onWatchdog,
  timeoutMs = COMMAND_WATCHDOG_INTERVENTION_MS,
  watchdogSlowMs = COMMAND_WATCHDOG_SLOW_MS,
  sandboxStatus,
  localSandboxBaseDirectory,
  runId = "",
  taskId = "",
  onRecovery,
  beforeApply,
  dependencySession = null,
}) {
  workspaceRoot = await realpath(workspaceRoot);
  cwd = await realpath(cwd);
  const sandboxDirectory = await createLocalSandboxDirectory(
    localSandboxBaseDirectory,
  );
  const sandboxWorkspace = join(sandboxDirectory, "workspace");
  if (isPathInside(workspaceRoot, sandboxDirectory)) {
    await removeLocalSandboxDirectory(sandboxDirectory, localSandboxBaseDirectory);
    throw new Error("Sandbox recovery storage must be outside the workspace being copied.");
  }
  const relativeCwd = relative(workspaceRoot, cwd) || ".";
  if (
    relativeCwd === ".." ||
    relativeCwd.startsWith(`..${sep}`) ||
    isAbsolute(relativeCwd)
  ) {
    await removeLocalSandboxDirectory(
      sandboxDirectory,
      localSandboxBaseDirectory,
    );
    throw new Error("Command working directory must stay inside the workspace.");
  }

  let started = false;
  let retained = false;
  let sessionOwned = false;
  const manifest = { version: 1, state: "preparing", runId: String(runId), taskId: String(taskId), workspaceRoot, createdAt: new Date().toISOString(), command: String(command).slice(0, 2000), dependencies: "private-copy-not-synchronized" };
  const manifestPath = join(sandboxDirectory, "recovery.json");
  const preserve = async (reason, result) => {
    if (retained) return manifest.recovery;
    retained = true; // Never erase output if writing the final manifest fails (e.g. disk full).
    const recovery = { directory: sandboxDirectory, workspace: sandboxWorkspace, manifest: manifestPath, reason, runId, taskId };
    manifest.state = "recovery-required"; manifest.reason = reason; manifest.recovery = recovery;
    if (result) manifest.result = { exitCode: result.exitCode, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr };
    await atomicJson(manifestPath, manifest).catch(() => {});
    try { onRecovery?.(recovery); } catch { /* notification cannot discard output */ }
    return recovery;
  };
  try {
    await atomicJson(manifestPath, manifest);
    const baselineFiles = await scanLocalSandboxFiles(workspaceRoot, signal);
    const space = await statfs(sandboxDirectory);
    const maxBytes = Math.min(SNAPSHOT_MAX_BYTES, Math.floor((space.bavail * space.bsize - 512 * 1024 ** 2) / 3));
    if (baselineFiles.bytes > maxBytes || maxBytes <= 0) throw new Error("Insufficient disk space for a recoverable Safe snapshot; free disk space or narrow the workspace.");
    const budget = { files: 0, bytes: 0, maxBytes, maxFiles: SNAPSHOT_MAX_FILES };
    await copyWorkspaceToLocalSandbox(
      workspaceRoot,
      sandboxWorkspace,
      { budget, signal, dependencySource: dependencySession?.source(workspaceRoot, baselineFiles) || null },
    );
    const copied = await scanLocalSandboxFiles(sandboxWorkspace, signal);
    if (copied.size !== baselineFiles.size || [...copied].some(([path, hash]) => baselineFiles.get(path) !== hash)) throw new Error("Workspace changed while creating the sandbox snapshot; no command was started.");
    const localCwd = resolve(sandboxWorkspace, relativeCwd);
    if (!isPathInside(sandboxWorkspace, localCwd)) {
      throw new Error("Local sandbox rejected the command working directory.");
    }
    const shell = hostShell(command);
    manifest.state = "executing";
    manifest.baseline = Object.fromEntries(baselineFiles);
    await atomicJson(manifestPath, manifest);
    checkAbort(signal);
    started = true;
    const result = await runProcess({
      ...shell,
      cwd: localCwd,
      env: createHostFallbackEnvironment(),
      signal,
      timeoutMs,
      onOutput,
      onWatchdog,
      watchdogSlowMs,
    });
    const sync =
      result.timedOut || signal?.aborted || result.exitCode !== 0
        ? { written: 0, deleted: 0, changed: 0, applied: false, recovery: await preserve(result.timedOut ? "timeout" : signal?.aborted ? "interrupted" : "command-failed", result) }
        : await synchronizeLocalSandbox({
            workspaceRoot,
            sandboxWorkspace,
            sandboxDirectory,
            baselineFiles,
            manifest,
            signal,
            beforeApply,
          });
    if (!retained) {
      manifest.state = "completed"; await atomicJson(manifestPath, manifest);
      if (dependencySession) {
        await dependencySession.accept(workspaceRoot, { directory: sandboxDirectory, workspace: sandboxWorkspace }, await scanLocalSandboxFiles(sandboxWorkspace, signal));
        sessionOwned = true;
      }
    }
    return {
      ...result,
      sandbox: {
        backend: "local-workspace",
        executionProfile: "safe",
        fallback: true,
        isolation: "workspace-copy",
        network: "host",
        rootFilesystem: "host",
        workspace: "temporary-copy-with-conflict-checked-sync",
        sharedDependencies: "none",
        dependencies: "private-copy-not-synchronized",
        sensitiveEnvironment: "removed",
        timeoutMs,
        sync,
        reason:
          sandboxStatus?.detail ||
          "Docker strong isolation is unavailable or not enabled.",
      },
    };
  } catch (error) {
    if (started) {
      error.recovery = await preserve(error.name === "AbortError" ? "interrupted" : "sync-failed");
      error.message += `\n产物已保留（未保证同步到原工作区）：${sandboxDirectory}`;
    }
    throw error;
  } finally {
    if (!retained && !sessionOwned) await removeLocalSandboxDirectory(
      sandboxDirectory,
      localSandboxBaseDirectory,
    ).catch(() => {});
  }
}

export async function runHostFallbackCommand({
  command,
  workspaceRoot,
  cwd,
  signal,
  onOutput,
  onWatchdog,
  timeoutMs = COMMAND_WATCHDOG_INTERVENTION_MS,
  watchdogSlowMs = COMMAND_WATCHDOG_SLOW_MS,
  sandboxStatus,
}) {
  const shell = hostShell(command);
  const result = await runProcess({
    ...shell,
    cwd,
    env: createHostFallbackEnvironment(process.env, "host-direct"),
    signal,
    timeoutMs,
    onOutput,
    onWatchdog,
    watchdogSlowMs,
  });
  return {
    ...result,
    sandbox: {
      backend: "host",
      executionProfile: "direct",
      fallback: true,
      isolation: "none",
      network: "host",
      rootFilesystem: "host",
      workspace: "approved-working-directory",
      workspaceRoot,
      sensitiveEnvironment: "removed",
      timeoutMs,
      reason:
        sandboxStatus?.detail ||
        "Docker container sandbox is unavailable.",
    },
  };
}

export async function runCommandWithFallback(options) {
  const status = options.sandboxStatus || (await getSandboxStatus());
  const mode = currentExecutionMode() || status?.executionProfile || null;
  if (mode === "direct") {
    return runHostFallbackCommand({
      ...options,
      sandboxStatus: status,
    });
  }
  if (mode === "safe") {
    return runLocalSandboxedCommand({
      ...options,
      sandboxStatus: status,
    });
  }
  if (mode === "isolated") {
    if (!status.available) {
      throw new Error(
        `Isolated execution requires a ready Docker sandbox. ${status?.detail || ""}`.trim(),
      );
    }
    return runSandboxedCommand({
      ...options,
      sandboxStatus: status,
    });
  }
  // Compatibility path for callers outside a task-scoped execution context.
  if (status.available) {
    return runSandboxedCommand({
      ...options,
      sandboxStatus: status,
    });
  }
  return runLocalSandboxedCommand({
    ...options,
    sandboxStatus: status,
  });
}
