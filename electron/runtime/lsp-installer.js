import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const MAX_INSTALL_OUTPUT_CHARS = 80_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const INSTALLABLE_LANGUAGE_IDS = new Set(["python", "rust", "go", "clangd"]);

function createAbortError() {
  const error = new Error("The language-server installation was interrupted.");
  error.name = "AbortError";
  return error;
}

function trimOutput(value, maximum = MAX_INSTALL_OUTPUT_CHARS) {
  if (value.length <= maximum) return value;
  const half = Math.floor(maximum / 2);
  return `${value.slice(0, half)}\n\n… output truncated …\n\n${value.slice(-half)}`;
}

export function getLanguageServerHome() {
  const configured = String(process.env.APORIAX_LSP_HOME || "").trim();
  return configured
    ? resolve(configured)
    : join(homedir(), ".aporiax", "language-servers");
}

function executableCandidates(name) {
  if (process.platform !== "win32") return [name];
  if (/\.(?:exe|cmd|bat)$/i.test(name)) return [name];
  return [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`];
}

export function findExecutableOnPath(name, env = process.env) {
  const pathValue = String(env.PATH || env.Path || env.path || "");
  if (!pathValue) return null;
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const candidate of executableCandidates(name)) {
      const absolute = join(directory, candidate);
      if (existsSync(absolute)) return absolute;
    }
  }
  return null;
}

function managedPyrightCommand() {
  const packageRoot = join(getLanguageServerHome(), "python", "node_modules", "pyright");
  const packageJsonPath = join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const relativeBin = packageJson?.bin?.["pyright-langserver"];
    if (!relativeBin) return null;
    const entry = join(packageRoot, relativeBin);
    if (!existsSync(entry)) return null;
    return {
      program: process.execPath,
      argsPrefix: [entry],
      source: "managed",
      electronRunAsNode: true,
    };
  } catch {
    return null;
  }
}

function managedGoCommand() {
  const program = join(
    getLanguageServerHome(),
    "go",
    "bin",
    process.platform === "win32" ? "gopls.exe" : "gopls",
  );
  return existsSync(program) ? { program, argsPrefix: [], source: "managed" } : null;
}

function rustupAnalyzerCommand() {
  const rustup = findExecutableOnPath("rustup");
  if (!rustup) return null;
  const result = spawnSync(rustup, ["which", "rust-analyzer"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  const program = String(result.stdout || "").trim();
  return result.status === 0 && program && existsSync(program)
    ? { program, argsPrefix: [], source: "toolchain" }
    : null;
}

function knownClangdCommand() {
  const candidates = [];
  if (process.platform === "win32") {
    for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (root) candidates.push(join(root, "LLVM", "bin", "clangd.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/opt/homebrew/opt/llvm/bin/clangd",
      "/usr/local/opt/llvm/bin/clangd",
      "/usr/bin/clangd",
    );
  } else {
    candidates.push("/usr/bin/clangd", "/usr/local/bin/clangd");
  }
  const program = candidates.find((candidate) => existsSync(candidate));
  return program ? { program, argsPrefix: [], source: "toolchain" } : null;
}

function pathCommand(name) {
  const program = findExecutableOnPath(name);
  return program ? { program, argsPrefix: [], source: "path" } : null;
}

export function resolveLanguageServerCommand(language, args = []) {
  const id = String(language || "").trim().toLowerCase();
  let resolved = null;
  if (id === "python") {
    resolved = managedPyrightCommand() || pathCommand("pyright-langserver");
  } else if (id === "rust") {
    resolved = pathCommand("rust-analyzer") || rustupAnalyzerCommand();
  } else if (id === "go") {
    resolved = managedGoCommand() || pathCommand("gopls");
  } else if (id === "clangd") {
    resolved = pathCommand("clangd") || knownClangdCommand();
  }
  if (!resolved) return null;
  return {
    program: resolved.program,
    args: [...(resolved.argsPrefix || []), ...args],
    source: resolved.source,
    electronRunAsNode: Boolean(resolved.electronRunAsNode),
  };
}

export function getLanguageServerInstallPlan(language) {
  const id = String(language || "").trim().toLowerCase();
  if (!INSTALLABLE_LANGUAGE_IDS.has(id)) {
    throw new Error(`Unsupported installable language server: ${id || "unknown"}.`);
  }
  const home = getLanguageServerHome();
  if (id === "python") {
    return {
      language: id,
      installer: "npm",
      program: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["install", "--prefix", join(home, "python"), "--no-audit", "--no-fund", "pyright@latest"],
      env: process.env,
      managed: true,
    };
  }
  if (id === "go") {
    const binDirectory = join(home, "go", "bin");
    return {
      language: id,
      installer: "go",
      program: process.platform === "win32" ? "go.exe" : "go",
      args: ["install", "golang.org/x/tools/gopls@latest"],
      env: { ...process.env, GOBIN: binDirectory },
      prepareDirectory: binDirectory,
      managed: true,
    };
  }
  if (id === "rust") {
    return {
      language: id,
      installer: "rustup",
      program: process.platform === "win32" ? "rustup.exe" : "rustup",
      args: ["component", "add", "rust-analyzer"],
      env: process.env,
      managed: false,
    };
  }
  if (process.platform === "win32") {
    return {
      language: id,
      installer: "winget",
      program: "winget.exe",
      args: [
        "install",
        "--id",
        "LLVM.LLVM",
        "-e",
        "--accept-package-agreements",
        "--accept-source-agreements",
      ],
      env: process.env,
      managed: false,
    };
  }
  if (process.platform === "darwin") {
    return {
      language: id,
      installer: "brew",
      program: "brew",
      args: ["install", "llvm"],
      env: process.env,
      managed: false,
    };
  }
  return {
    language: id,
    installer: "apt-get",
    program: "apt-get",
    args: ["install", "-y", "clangd"],
    env: process.env,
    managed: false,
    note: "Linux system package installation may require elevated privileges.",
  };
}

function runInstaller({ program, args, env, signal, timeoutMs = INSTALL_TIMEOUT_MS }) {
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(program, args, {
      env,
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
      stdout = trimOutput(stdout + chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      stderr = trimOutput(stderr + chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      if (error?.code === "ENOENT") {
        finish(
          rejectPromise,
          new Error(`Installer executable not found: ${program}. Install the required toolchain/package manager first.`),
        );
        return;
      }
      finish(rejectPromise, error);
    });
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

export function describeLanguageServers() {
  return ["python", "rust", "go", "clangd"].map((language) => {
    const command = resolveLanguageServerCommand(language);
    const plan = getLanguageServerInstallPlan(language);
    return {
      id: language,
      available: Boolean(command),
      source: command?.source || null,
      program: command?.program || null,
      installable: true,
      installer: plan.installer,
      managedInstall: Boolean(plan.managed),
    };
  });
}

export async function installLanguageServer({ language, signal } = {}) {
  const id = String(language || "").trim().toLowerCase();
  const existing = resolveLanguageServerCommand(id);
  if (existing) {
    return {
      language: id,
      installed: false,
      alreadyAvailable: true,
      source: existing.source,
      program: existing.program,
    };
  }
  const plan = getLanguageServerInstallPlan(id);
  if (plan.prepareDirectory) {
    await mkdir(plan.prepareDirectory, { recursive: true });
  } else if (plan.managed) {
    await mkdir(getLanguageServerHome(), { recursive: true });
  }
  const result = await runInstaller({
    program: plan.program,
    args: plan.args,
    env: plan.env,
    signal,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `${plan.installer} failed to install ${id}.`,
    );
  }
  const resolved = resolveLanguageServerCommand(id);
  return {
    language: id,
    installed: true,
    alreadyAvailable: false,
    installer: plan.installer,
    managed: Boolean(plan.managed),
    source: resolved?.source || null,
    program: resolved?.program || null,
    restartMayBeRequired: !resolved,
    note: plan.note || null,
    output: result.stdout.trim() || result.stderr.trim(),
  };
}
