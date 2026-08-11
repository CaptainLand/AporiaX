import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

export const SANDBOX_IMAGE = "aporiax-sandbox:0.1";
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

export const SANDBOX_DOCKERFILE = `FROM node:20-bookworm-slim

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

  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forcedFinish = null;
    let lastOutputAt = Date.now();
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
      clearTimeout(timeout);
      clearTimeout(slowTimer);
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
        elapsedMs: Date.now() - startedAt,
        idleMs: Date.now() - lastOutputAt,
        ...detail,
      };
      watchdogEvents.push(notice);
      onWatchdog?.(notice);
    };
    const startedAt = Date.now();
    const slowTimer = setTimeout(() => {
      if (!settled) notifyWatchdog("slow");
    }, Math.min(watchdogSlowMs, Math.max(10, timeoutMs - 1)));
    const timeout = setTimeout(() => {
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
    }, timeoutMs);

    signal?.addEventListener("abort", handleAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      lastOutputAt = Date.now();
      stdout = trimOutput(stdout + text);
      onOutput?.({ stream: "stdout", text });
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      lastOutputAt = Date.now();
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

export async function getSandboxStatus() {
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

export async function prepareSandbox({
  dataDirectory,
  signal,
  onOutput,
}) {
  if (!dataDirectory) {
    throw new Error("Sandbox data directory is required.");
  }
  const status = await getSandboxStatus();
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
  environment.APORIAX_EXECUTION_MODE = "local-workspace-sandbox";
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

async function hashFile(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function scanLocalSandboxFiles(rootPath) {
  const files = new Map();
  const pending = [{ absolutePath: rootPath, relativePath: "" }];
  while (pending.length) {
    const current = pending.pop();
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
      files.set(entryRelativePath, await hashFile(entryAbsolutePath));
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
  { shareDependencies = true } = {},
) {
  await cp(workspaceRoot, sandboxWorkspace, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: async (sourcePath) => {
      const sourceRelativePath = relative(workspaceRoot, sourcePath);
      if (shouldIgnoreLocalSandboxPath(sourceRelativePath)) return false;
      if (!sourceRelativePath) return true;
      return !(await lstat(sourcePath)).isSymbolicLink();
    },
  });

  if (!shareDependencies) return;
  const sourceDependencies = join(workspaceRoot, "node_modules");
  try {
    if ((await lstat(sourceDependencies)).isDirectory()) {
      await symlink(
        sourceDependencies,
        join(sandboxWorkspace, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
  } catch {
    // A project without installed dependencies can still run commands.
  }
}

function commandMayMutateDependencies(command) {
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add|remove|uninstall|update|upgrade)\b/i.test(
    command,
  );
}

async function synchronizeLocalSandbox({
  workspaceRoot,
  sandboxWorkspace,
  baselineFiles,
}) {
  const sandboxFiles = await scanLocalSandboxFiles(sandboxWorkspace);
  const currentFiles = await scanLocalSandboxFiles(workspaceRoot);
  const changedPaths = new Set();
  for (const [path, hash] of sandboxFiles) {
    if (baselineFiles.get(path) !== hash) changedPaths.add(path);
  }
  for (const path of baselineFiles.keys()) {
    if (!sandboxFiles.has(path)) changedPaths.add(path);
  }

  const conflicts = [];
  for (const path of changedPaths) {
    if (currentFiles.get(path) !== baselineFiles.get(path)) {
      conflicts.push(path);
    }
  }
  if (conflicts.length) {
    throw new Error(
      `Local sandbox did not apply changes because the original workspace changed during execution: ${conflicts
        .slice(0, 5)
        .join(", ")}`,
    );
  }

  let written = 0;
  let deleted = 0;
  for (const path of changedPaths) {
    const targetPath = resolve(workspaceRoot, path);
    if (!isPathInside(workspaceRoot, targetPath)) {
      throw new Error(`Local sandbox rejected an unsafe path: ${path}`);
    }
    if (!sandboxFiles.has(path)) {
      await rm(targetPath, { force: true });
      deleted += 1;
      continue;
    }
    const sourcePath = resolve(sandboxWorkspace, path);
    if (!isPathInside(sandboxWorkspace, sourcePath)) {
      throw new Error(`Local sandbox rejected an unsafe source path: ${path}`);
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, await readFile(sourcePath));
    written += 1;
  }
  return {
    written,
    deleted,
    changed: changedPaths.size,
  };
}

function localSandboxRootPath(baseDirectory) {
  return resolve(
    baseDirectory || tmpdir(),
    LOCAL_SANDBOX_DIRECTORY,
  );
}

async function createLocalSandboxDirectory(baseDirectory) {
  const localSandboxRoot = localSandboxRootPath(baseDirectory);
  await mkdir(localSandboxRoot, { recursive: true });
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
}) {
  const sandboxDirectory = await createLocalSandboxDirectory(
    localSandboxBaseDirectory,
  );
  const sandboxWorkspace = join(sandboxDirectory, "workspace");
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

  try {
    const baselineFiles = await scanLocalSandboxFiles(workspaceRoot);
    const shareDependencies = !commandMayMutateDependencies(command);
    await copyWorkspaceToLocalSandbox(
      workspaceRoot,
      sandboxWorkspace,
      { shareDependencies },
    );
    const localCwd = resolve(sandboxWorkspace, relativeCwd);
    if (!isPathInside(sandboxWorkspace, localCwd)) {
      throw new Error("Local sandbox rejected the command working directory.");
    }
    const shell = hostShell(command);
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
      result.timedOut || signal?.aborted
        ? { written: 0, deleted: 0, changed: 0, discarded: true }
        : await synchronizeLocalSandbox({
            workspaceRoot,
            sandboxWorkspace,
            baselineFiles,
          });
    return {
      ...result,
      sandbox: {
        backend: "local-workspace",
        fallback: true,
        isolation: "workspace-copy",
        network: "host",
        rootFilesystem: "host",
        workspace: "temporary-copy-with-conflict-checked-sync",
        sharedDependencies: shareDependencies
          ? "root-node-modules"
          : "disabled-for-package-mutation",
        sensitiveEnvironment: "removed",
        timeoutMs,
        sync,
        reason:
          sandboxStatus?.detail ||
          "Docker strong isolation is unavailable or not enabled.",
      },
    };
  } finally {
    await removeLocalSandboxDirectory(
      sandboxDirectory,
      localSandboxBaseDirectory,
    );
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
    env: createHostFallbackEnvironment(),
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
  const status =
    options.sandboxStatus || (await getSandboxStatus());
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
