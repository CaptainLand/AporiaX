import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";

export const SANDBOX_IMAGE = "aporiax-sandbox:0.1";
export const SANDBOX_TIMEOUT_MS = 120_000;
export const SANDBOX_MEMORY = "1536m";
export const SANDBOX_CPUS = "2";
export const SANDBOX_PIDS_LIMIT = 256;
const MAX_SANDBOX_OUTPUT_CHARS = 80_000;
const STATUS_TIMEOUT_MS = 8_000;
const PREPARE_TIMEOUT_MS = 15 * 60_000;

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

function runProcess({
  program,
  args,
  cwd,
  signal,
  timeoutMs,
  onOutput,
}) {
  if (signal?.aborted) return Promise.reject(createAbortError());

  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(program, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", handleAbort);
      callback(value);
    };
    const handleAbort = () => {
      child.kill();
      finish(rejectPromise, createAbortError());
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    signal?.addEventListener("abort", handleAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout = trimOutput(stdout + text);
      onOutput?.({ stream: "stdout", text });
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
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
    backend: "docker",
    state,
    available: state === "ready",
    detail,
    engineVersion,
    image: SANDBOX_IMAGE,
    imageReady,
    imageId,
    network: "none",
    filesystem: "workspace-write",
    rootFilesystem: "read-only",
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
        detail: "未找到 Docker CLI。请安装并启动 Docker Desktop。",
      });
    }
    return sandboxState({
      state: "engine-stopped",
      detail: `无法连接 Docker：${error?.message || "未知错误"}`,
    });
  }

  if (versionResult.exitCode !== 0 || !versionResult.stdout.trim()) {
    return sandboxState({
      state: "engine-stopped",
      detail:
        versionResult.stderr.trim() ||
        "Docker Desktop 尚未启动，命令执行已安全关闭。",
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
      detail: "Docker 已连接，但 AporiaX 沙箱镜像尚未准备。",
      engineVersion,
    });
  }
  return sandboxState({
    state: "ready",
    detail: "OS 级容器沙箱已就绪。",
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
}) {
  const status = await getSandboxStatus();
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
      timeoutMs: SANDBOX_TIMEOUT_MS,
      onOutput,
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
