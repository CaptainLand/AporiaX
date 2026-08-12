import { spawn } from "node:child_process";

const MAX_OUTPUT_CHARS = 80_000;
const DEFAULT_TIMEOUT_MS = 60_000;

function createAbortError() {
  const error = new Error("The GitHub operation was interrupted.");
  error.name = "AbortError";
  return error;
}

function trimOutput(value, maximum = MAX_OUTPUT_CHARS) {
  if (value.length <= maximum) return value;
  const half = Math.floor(maximum / 2);
  return `${value.slice(0, half)}\n\n… output truncated …\n\n${value.slice(-half)}`;
}

export async function runGitHubCli({
  args,
  cwd,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputChars = MAX_OUTPUT_CHARS,
} = {}) {
  if (!Array.isArray(args) || !args.length) {
    throw new Error("GitHub CLI arguments are required.");
  }
  if (signal?.aborted) throw createAbortError();

  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn("gh", args.map(String), {
      cwd,
      env: process.env,
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
    }, Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

    signal?.addEventListener("abort", handleAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout = trimOutput(stdout + chunk.toString("utf8"), maxOutputChars);
    });
    child.stderr.on("data", (chunk) => {
      stderr = trimOutput(stderr + chunk.toString("utf8"), maxOutputChars);
    });
    child.on("error", (error) => {
      if (error?.code === "ENOENT") {
        finish(
          rejectPromise,
          new Error(
            "GitHub CLI (gh) is not installed or is not available on PATH. Install GitHub CLI and authenticate it before using GitHub PR tools.",
          ),
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

export function parseGitHubJson(value, label = "GitHub CLI") {
  try {
    return JSON.parse(String(value || "").trim() || "null");
  } catch (error) {
    throw new Error(`${label} returned invalid JSON.`, { cause: error });
  }
}
