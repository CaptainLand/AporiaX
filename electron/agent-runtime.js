import { spawn } from "node:child_process";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import {
  ToolRegistry,
  createEventEmitter,
  createPermissionPolicy,
  getToolPermission,
} from "./agent-core.js";
import {
  MAX_OFFICE_FILE_BYTES,
  OFFICE_CREATE_TOOL_NAMES,
  OFFICE_TOOL_DEFINITIONS,
  createOfficeArtifact,
  inspectOfficeArtifact,
  isOfficePath,
} from "./office-tools.js";
import {
  MAX_ATTACHMENT_BYTES,
  extractPdfText,
} from "./attachment-parser.js";
import { providerChatEndpoint } from "./provider-config.js";
import {
  getSandboxStatus,
  runSandboxedCommand,
} from "./sandbox-runtime.js";

const MAX_HISTORY_MESSAGES = 30;
const MAX_FILE_READ_CHARS = 120_000;
const MAX_FILE_WRITE_CHARS = 200_000;
const MAX_DIRECTORY_ENTRIES = 200;
const MAX_COMMAND_CHARS = 2_000;
const MAX_COMMAND_OUTPUT_CHARS = 80_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_FILE_BYTES = 2_000_000;
const MAX_PATCH_TEXT_CHARS = 120_000;
const MAX_TREE_ENTRIES = 700;
const MAX_TREE_DEPTH = 6;
const MAX_GIT_DIFF_CHARS = 120_000;
const PROVIDER_IDLE_TIMEOUT_MS = 180_000;
const PROVIDER_MAX_ATTEMPTS = 3;
const CONTEXT_COMPACT_THRESHOLD_CHARS = 900_000;
const COMPACTED_TOOL_CONTENT_CHARS = 2_000;
const PROJECT_INSTRUCTION_FILES = [
  "AGENTS.md",
  "APORIAX.md",
  "DEEPAGENT.md",
];
const PROJECT_CONFIG_FILES = [
  ".aporiax.json",
  "aporiax.json",
  ".deepagent.json",
  "deepagent.json",
];
const TREE_IGNORES = new Set([
  ".git",
  ".idea",
  ".next",
  ".turbo",
  ".vscode",
  "coverage",
  "dist",
  "node_modules",
]);

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "List direct children of a directory inside the authorized workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Workspace-relative directory path. Use '.' for the workspace root.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 text file or extract text from a PDF inside the authorized workspace. Scanned PDFs may require OCR.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_text",
      description:
        "Search UTF-8 text files recursively inside the authorized workspace before deciding which files to read or edit.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Literal text to search for.",
          },
          path: {
            type: "string",
            description:
              "Workspace-relative directory path. Use '.' for the workspace root.",
          },
          case_sensitive: {
            type: "boolean",
            description: "Whether the literal match is case-sensitive.",
          },
          max_results: {
            type: "integer",
            minimum: 1,
            maximum: MAX_SEARCH_RESULTS,
            description: "Maximum number of matching lines to return.",
          },
        },
        required: ["query", "path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or replace a UTF-8 text file inside the authorized workspace. Only available when workspace write permission is enabled.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path.",
          },
          content: {
            type: "string",
            description: "Complete UTF-8 file content to write.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description:
        "Precisely edit an existing UTF-8 file by replacing exact text. Prefer this over rewriting an entire file when making a localized change.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path.",
          },
          old_text: {
            type: "string",
            description:
              "Exact existing text to replace. It must occur exactly once unless replace_all is true.",
          },
          new_text: {
            type: "string",
            description: "Replacement text.",
          },
          replace_all: {
            type: "boolean",
            description:
              "Replace every exact occurrence. Defaults to false.",
          },
        },
        required: ["path", "old_text", "new_text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run one foreground shell command in a network-disabled OS-level container sandbox. Only the authorized workspace is mounted writable, and the user must approve every command.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "A single foreground command, for example npm test or npm run build.",
          },
          cwd: {
            type: "string",
            description:
              "Workspace-relative working directory. Use '.' for the workspace root.",
          },
          reason: {
            type: "string",
            description:
              "A short user-facing explanation of why the command is needed.",
          },
        },
        required: ["command", "cwd", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description:
        "Inspect the workspace Git status without modifying the repository. Use this to understand tracked, modified, and untracked files.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description:
        "Read the current Git diff without modifying the repository. Optionally limit the diff to one workspace-relative file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Optional workspace-relative file path. Omit it to inspect all changes.",
          },
          staged: {
            type: "boolean",
            description: "Read staged changes instead of unstaged changes.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  ...OFFICE_TOOL_DEFINITIONS,
  {
    type: "function",
    function: {
      name: "complete_self_check",
      description:
        "Finish the mandatory self-check phase. This succeeds only after every changed text file has been re-read and every changed Office file has been structurally inspected after its latest write.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description:
              "A concise summary of what was reviewed and why the result is ready.",
          },
          checks: {
            type: "array",
            items: { type: "string" },
            description:
              "Concrete correctness, security, performance, and completeness checks performed.",
          },
          improvements: {
            type: "array",
            items: { type: "string" },
            description:
              "Improvements made during self-check. Use an empty array if no further change was needed.",
          },
          remaining_risks: {
            type: "array",
            items: { type: "string" },
            description:
              "Known limitations that still require user or environment validation.",
          },
        },
        required: [
          "summary",
          "checks",
          "improvements",
          "remaining_risks",
        ],
        additionalProperties: false,
      },
    },
  },
];

const TOOL_RISKS = {
  list_directory: "read",
  read_file: "read",
  search_text: "read",
  git_status: "read",
  git_diff: "read",
  inspect_office_file: "read",
  write_file: "write",
  apply_patch: "write",
  create_word_document: "write",
  create_presentation: "write",
  create_spreadsheet: "write",
  run_command: "execute",
  complete_self_check: "control",
};

const TOOL_REGISTRY = new ToolRegistry(
  TOOL_DEFINITIONS.map((definition) => ({
    definition,
    risk: TOOL_RISKS[definition.function.name],
  })),
);

function createAbortError(message = "The run was interrupted.") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function isPathInside(rootPath, candidatePath) {
  const pathFromRoot = relative(rootPath, candidatePath);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

function resolveWorkspacePath(workspaceRoot, requestedPath) {
  if (typeof requestedPath !== "string" || requestedPath.includes("\0")) {
    throw new Error("Invalid workspace path.");
  }

  const targetPath = resolve(workspaceRoot, requestedPath || ".");
  if (!isPathInside(workspaceRoot, targetPath)) {
    throw new Error("Path escapes the authorized workspace.");
  }

  return targetPath;
}

async function getVerifiedWorkspaceRoot(workspacePath) {
  if (typeof workspacePath !== "string" || !workspacePath.trim()) {
    throw new Error("A workspace directory is required.");
  }

  const workspaceRoot = await realpath(resolve(workspacePath));
  const workspaceStats = await lstat(workspaceRoot);
  if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink()) {
    throw new Error("The workspace must be a real directory.");
  }

  return workspaceRoot;
}

async function verifyExistingTarget(workspaceRoot, requestedPath) {
  const lexicalTarget = resolveWorkspacePath(workspaceRoot, requestedPath);
  const verifiedTarget = await realpath(lexicalTarget);
  if (!isPathInside(workspaceRoot, verifiedTarget)) {
    throw new Error("Resolved path escapes the authorized workspace.");
  }
  return verifiedTarget;
}

async function verifyWritableTarget(workspaceRoot, requestedPath) {
  const targetPath = resolveWorkspacePath(workspaceRoot, requestedPath);
  const verifiedParent = await realpath(dirname(targetPath));
  if (!isPathInside(workspaceRoot, verifiedParent)) {
    throw new Error("Resolved parent path escapes the authorized workspace.");
  }

  try {
    const targetStats = await lstat(targetPath);
    if (targetStats.isSymbolicLink() || targetStats.isDirectory()) {
      throw new Error("Refusing to overwrite a symbolic link or directory.");
    }
    const verifiedTarget = await realpath(targetPath);
    if (!isPathInside(workspaceRoot, verifiedTarget)) {
      throw new Error("Resolved file escapes the authorized workspace.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  return targetPath;
}

function parseToolArguments(toolCall) {
  try {
    const parsed = JSON.parse(toolCall.function.arguments || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tool arguments must be an object.");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid arguments for ${toolCall.function.name}.`, {
      cause: error,
    });
  }
}

function calculateLineChanges(previousContent, nextContent) {
  const toLines = (content) =>
    content === ""
      ? []
      : content.replace(/\r\n/g, "\n").split("\n");
  const before = toLines(previousContent);
  const after = toLines(nextContent);

  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] ===
      after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    additions: Math.max(0, after.length - prefix - suffix),
    deletions: Math.max(0, before.length - prefix - suffix),
  };
}

function mergeFileChange(changeMap, change) {
  const current = changeMap.get(change.path);
  if (!current) {
    changeMap.set(change.path, change);
    return;
  }

  current.afterContent = change.afterContent;
  current.binary = Boolean(current.binary || change.binary);
  current.artifact = change.artifact || current.artifact || null;
  if (current.binary) {
    current.additions = 0;
    current.deletions = 0;
  } else {
    const lineChanges = calculateLineChanges(
      current.beforeContent,
      current.afterContent,
    );
    current.additions = lineChanges.additions;
    current.deletions = lineChanges.deletions;
  }
  changeMap.set(change.path, current);
}

export function getPendingSelfCheckPaths(
  changes,
  reviewedVersions = new Map(),
) {
  const changeList = changes instanceof Map
    ? [...changes.values()]
    : Array.isArray(changes)
      ? changes
      : [];
  return changeList
    .filter(
      (change) =>
        change?.beforeContent !== change?.afterContent &&
        reviewedVersions.get(change.path) !== change.afterContent,
    )
    .map((change) => change.path);
}

function normalizeSelfCheckList(value, fieldName) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error(`${fieldName} must be an array with at most 20 items.`);
  }
  return value.map((item) => {
    if (
      typeof item !== "string" ||
      !item.trim() ||
      item.trim().length > 1_000
    ) {
      throw new Error(
        `${fieldName} items must be non-empty strings under 1000 characters.`,
      );
    }
    return item.trim();
  });
}

function normalizeSelfCheckReport(input) {
  if (
    typeof input?.summary !== "string" ||
    !input.summary.trim() ||
    input.summary.trim().length > 4_000
  ) {
    throw new Error(
      "Self-check summary must be between 1 and 4000 characters.",
    );
  }
  const checks = normalizeSelfCheckList(input.checks, "checks");
  if (checks.length === 0) {
    throw new Error("Self-check must include at least one concrete check.");
  }
  return {
    summary: input.summary.trim(),
    checks,
    improvements: normalizeSelfCheckList(
      input.improvements,
      "improvements",
    ),
    remainingRisks: normalizeSelfCheckList(
      input.remaining_risks,
      "remaining_risks",
    ),
  };
}

function trimCommandOutput(value) {
  if (value.length <= MAX_COMMAND_OUTPUT_CHARS) return value;
  const half = Math.floor(MAX_COMMAND_OUTPUT_CHARS / 2);
  return `${value.slice(0, half)}\n\n… output truncated …\n\n${value.slice(-half)}`;
}

async function runGitCommand({ args, cwd, signal }) {
  throwIfAborted(signal);

  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn("git", args, {
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
    }, 30_000);

    signal?.addEventListener("abort", handleAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout = trimCommandOutput(stdout + chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      stderr = trimCommandOutput(stderr + chunk.toString("utf8"));
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

async function searchWorkspaceText({
  workspaceRoot,
  requestedPath,
  query,
  caseSensitive,
  maxResults,
  signal,
}) {
  if (
    typeof query !== "string" ||
    !query ||
    query.length > 500 ||
    query.includes("\0")
  ) {
    throw new Error("Search query must be between 1 and 500 characters.");
  }
  const searchRoot = await verifyExistingTarget(
    workspaceRoot,
    requestedPath || ".",
  );
  const searchStats = await lstat(searchRoot);
  if (!searchStats.isDirectory()) {
    throw new Error("The search path must be a directory.");
  }
  const normalizedQuery = caseSensitive ? query : query.toLowerCase();
  const results = [];
  let filesScanned = 0;
  let truncated = false;

  async function visit(directoryPath) {
    throwIfAborted(signal);
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      throwIfAborted(signal);
      if (results.length >= maxResults) {
        truncated = true;
        return;
      }
      if (TREE_IGNORES.has(entry.name) || entry.isSymbolicLink()) continue;
      const entryPath = resolve(directoryPath, entry.name);
      if (!isPathInside(workspaceRoot, entryPath)) continue;
      if (entry.isDirectory()) {
        await visit(entryPath);
        if (truncated) return;
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const stats = await lstat(entryPath);
        if (stats.size > MAX_SEARCH_FILE_BYTES) continue;
        const content = await readFile(entryPath, "utf8");
        filesScanned += 1;
        if (content.includes("\0")) continue;
        const lines = content.replace(/\r\n/g, "\n").split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          const searchable = caseSensitive ? line : line.toLowerCase();
          const column = searchable.indexOf(normalizedQuery);
          if (column === -1) continue;
          results.push({
            path: relative(workspaceRoot, entryPath).replace(/\\/g, "/"),
            line: index + 1,
            column: column + 1,
            preview:
              line.length > 320
                ? `${line.slice(0, 317)}...`
                : line,
          });
          if (results.length >= maxResults) {
            truncated = true;
            return;
          }
        }
      } catch (error) {
        if (error?.name === "AbortError") throw error;
      }
    }
  }

  await visit(searchRoot);
  return {
    query,
    path: requestedPath || ".",
    caseSensitive,
    results,
    filesScanned,
    truncated,
  };
}

function countExactOccurrences(content, searchText) {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - searchText.length) {
    const index = content.indexOf(searchText, offset);
    if (index === -1) break;
    count += 1;
    offset = index + searchText.length;
  }
  return count;
}

async function executeTool({
  toolCall,
  workspaceRoot,
  permissionPolicy,
  requestApproval,
  signal,
  sandboxExecutor = runSandboxedCommand,
  sandboxStatus = null,
}) {
  throwIfAborted(signal);
  const toolName = toolCall.function.name;
  const descriptor = TOOL_REGISTRY.get(toolName);
  if (!descriptor) {
    throw new Error(`Unsupported tool: ${toolName}`);
  }
  const input = parseToolArguments(toolCall);
  const permissionAction = getToolPermission(
    permissionPolicy,
    toolName,
  );
  if (permissionAction === "deny") {
    throw new Error(`Permission denied for tool: ${toolName}`);
  }
  if (toolName === "run_command" && !sandboxStatus?.available) {
    throw new Error(
      `Sandbox unavailable: ${sandboxStatus?.detail || "OS-level isolation is not ready"}. Host execution is disabled.`,
    );
  }
  if (permissionAction === "ask") {
    const approval = await requestApproval({
      kind: descriptor.risk,
      title:
        toolName === "run_command"
          ? "运行工作区命令"
          : `允许工具：${toolName}`,
      command:
        toolName === "run_command"
          ? String(input.command || "").trim()
          : `${toolName}${input.path ? ` ${input.path}` : ""}`,
      cwd: input.cwd || ".",
      reason:
        typeof input.reason === "string" && input.reason.trim()
          ? input.reason.trim()
          : descriptor.risk === "read"
            ? "Agent 请求读取工作区信息。"
            : "Agent 请求执行可能改变工作区或运行进程的操作。",
      ...(toolName === "run_command"
        ? {
            sandbox: sandboxStatus,
          }
        : {}),
    });
    throwIfAborted(signal);
    if (!approval?.approved) {
      throw new Error(`The user rejected tool: ${toolName}`);
    }
  }

  if (toolName === "list_directory") {
    const directoryPath = await verifyExistingTarget(
      workspaceRoot,
      input.path,
    );
    const directoryStats = await lstat(directoryPath);
    if (!directoryStats.isDirectory()) {
      throw new Error("The requested path is not a directory.");
    }

    const entries = await readdir(directoryPath, { withFileTypes: true });
    return {
      modelResult: {
        path: input.path,
        entries: entries
          .slice(0, MAX_DIRECTORY_ENTRIES)
          .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory()
              ? "directory"
              : entry.isFile()
                ? "file"
                : "other",
          })),
        truncated: entries.length > MAX_DIRECTORY_ENTRIES,
      },
    };
  }

  if (OFFICE_CREATE_TOOL_NAMES.has(toolName)) {
    const filePath = await verifyWritableTarget(
      workspaceRoot,
      input.path,
    );
    let previousBuffer = Buffer.alloc(0);
    let created = true;
    try {
      previousBuffer = await readFile(filePath);
      created = false;
      if (previousBuffer.length > MAX_OFFICE_FILE_BYTES) {
        throw new Error(
          `Existing Office file exceeds the ${Math.floor(MAX_OFFICE_FILE_BYTES / 1_000_000)} MB checkpoint limit.`,
        );
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const generated = await createOfficeArtifact(toolName, input);
    throwIfAborted(signal);
    await writeFile(filePath, generated.buffer);
    return {
      modelResult: {
        path: generated.path,
        bytesWritten: generated.buffer.length,
        created,
        artifact: generated.artifact,
        additions: 0,
        deletions: 0,
      },
      change: {
        path: generated.path,
        beforeContent: previousBuffer.toString("base64"),
        afterContent: generated.buffer.toString("base64"),
        binary: true,
        artifact: generated.artifact,
        created,
        reverted: false,
        additions: 0,
        deletions: 0,
      },
    };
  }

  if (toolName === "inspect_office_file") {
    if (!isOfficePath(input.path)) {
      throw new Error(
        "Only .docx, .pptx, and .xlsx files can be inspected.",
      );
    }
    const filePath = await verifyExistingTarget(
      workspaceRoot,
      input.path,
    );
    const fileStats = await lstat(filePath);
    if (!fileStats.isFile()) {
      throw new Error("The requested path is not a file.");
    }
    if (fileStats.size > MAX_OFFICE_FILE_BYTES) {
      throw new Error(
        `Office inspection is limited to ${Math.floor(MAX_OFFICE_FILE_BYTES / 1_000_000)} MB.`,
      );
    }
    const inspection = await inspectOfficeArtifact(
      input.path,
      await readFile(filePath),
    );
    return {
      modelResult: {
        path: input.path,
        inspection,
      },
    };
  }

  if (toolName === "read_file") {
    if (isOfficePath(input.path)) {
      throw new Error(
        "Office files are binary. Use inspect_office_file instead of read_file.",
      );
    }
    const filePath = await verifyExistingTarget(workspaceRoot, input.path);
    const fileStats = await lstat(filePath);
    if (!fileStats.isFile()) {
      throw new Error("The requested path is not a file.");
    }
    if (extname(input.path).toLowerCase() === ".pdf") {
      if (fileStats.size > MAX_ATTACHMENT_BYTES) {
        throw new Error("PDF reading is limited to 8 MB.");
      }
      const pdf = await extractPdfText(await readFile(filePath), {
        maxChars: MAX_FILE_READ_CHARS,
      });
      return {
        modelResult: {
          path: input.path,
          ...pdf,
          content: pdf.requiresOcr
            ? `${pdf.content}\n\n[系统提示：该 PDF 没有可提取文本，可能是扫描件，需要 OCR。]`
            : pdf.content,
        },
      };
    }
    const content = await readFile(filePath, "utf8");
    return {
      modelResult: {
        path: input.path,
        content: content.slice(0, MAX_FILE_READ_CHARS),
        truncated: content.length > MAX_FILE_READ_CHARS,
      },
    };
  }

  if (toolName === "search_text") {
    const maxResults = Number.isInteger(input.max_results)
      ? Math.min(MAX_SEARCH_RESULTS, Math.max(1, input.max_results))
      : 80;
    const searchResult = await searchWorkspaceText({
      workspaceRoot,
      requestedPath: input.path || ".",
      query: input.query,
      caseSensitive: Boolean(input.case_sensitive),
      maxResults,
      signal,
    });
    return { modelResult: searchResult };
  }

  if (toolName === "write_file") {
    if (
      typeof input.content !== "string" ||
      input.content.length > MAX_FILE_WRITE_CHARS
    ) {
      throw new Error(
        `File content must be at most ${MAX_FILE_WRITE_CHARS} characters.`,
      );
    }

    const filePath = await verifyWritableTarget(
      workspaceRoot,
      input.path,
    );
    let previousContent = "";
    let created = true;
    try {
      previousContent = await readFile(filePath, "utf8");
      created = false;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const lineChanges = calculateLineChanges(
      previousContent,
      input.content,
    );
    throwIfAborted(signal);
    await writeFile(filePath, input.content, "utf8");
    return {
      modelResult: {
        path: input.path,
        bytesWritten: Buffer.byteLength(input.content, "utf8"),
        created,
        ...lineChanges,
      },
      change: {
        path: input.path,
        beforeContent: previousContent,
        afterContent: input.content,
        created,
        reverted: false,
        ...lineChanges,
      },
    };
  }

  if (toolName === "apply_patch") {
    if (
      typeof input.old_text !== "string" ||
      !input.old_text ||
      typeof input.new_text !== "string" ||
      input.old_text.length > MAX_PATCH_TEXT_CHARS ||
      input.new_text.length > MAX_PATCH_TEXT_CHARS
    ) {
      throw new Error(
        `Patch text must be non-empty and at most ${MAX_PATCH_TEXT_CHARS} characters.`,
      );
    }
    const filePath = await verifyWritableTarget(
      workspaceRoot,
      input.path,
    );
    const previousContent = await readFile(filePath, "utf8");
    const occurrences = countExactOccurrences(
      previousContent,
      input.old_text,
    );
    if (occurrences === 0) {
      throw new Error("Patch failed because old_text was not found.");
    }
    if (!input.replace_all && occurrences !== 1) {
      throw new Error(
        `Patch is ambiguous because old_text occurs ${occurrences} times.`,
      );
    }
    const nextContent = input.replace_all
      ? previousContent.split(input.old_text).join(input.new_text)
      : previousContent.replace(input.old_text, input.new_text);
    if (nextContent.length > MAX_FILE_WRITE_CHARS) {
      throw new Error(
        `Patched file must be at most ${MAX_FILE_WRITE_CHARS} characters.`,
      );
    }
    const lineChanges = calculateLineChanges(
      previousContent,
      nextContent,
    );
    throwIfAborted(signal);
    await writeFile(filePath, nextContent, "utf8");
    return {
      modelResult: {
        path: input.path,
        replacements: input.replace_all ? occurrences : 1,
        bytesWritten: Buffer.byteLength(nextContent, "utf8"),
        created: false,
        ...lineChanges,
      },
      change: {
        path: input.path,
        beforeContent: previousContent,
        afterContent: nextContent,
        created: false,
        reverted: false,
        ...lineChanges,
      },
    };
  }

  if (toolName === "run_command") {
    if (
      typeof input.command !== "string" ||
      !input.command.trim() ||
      input.command.length > MAX_COMMAND_CHARS
    ) {
      throw new Error(
        `Command must be between 1 and ${MAX_COMMAND_CHARS} characters.`,
      );
    }
    const commandDirectory = await verifyExistingTarget(
      workspaceRoot,
      input.cwd || ".",
    );
    const commandDirectoryStats = await lstat(commandDirectory);
    if (!commandDirectoryStats.isDirectory()) {
      throw new Error("The command working directory is not a directory.");
    }

    const result = await sandboxExecutor({
      command: input.command.trim(),
      workspaceRoot,
      cwd: commandDirectory,
      signal,
    });
    return {
      modelResult: {
        command: input.command.trim(),
        cwd: input.cwd || ".",
        ...result,
      },
    };
  }

  if (toolName === "git_status") {
    const result = await runGitCommand({
      args: ["status", "--short", "--branch", "--untracked-files=all"],
      cwd: workspaceRoot,
      signal,
    });
    if (result.exitCode !== 0) {
      if (/not a git repository/i.test(result.stderr)) {
        return {
          modelResult: {
            applicable: false,
            skipped: true,
            reason: "当前工作区不是 Git 仓库",
          },
        };
      }
      throw new Error(
        result.stderr.trim() ||
          "Unable to read Git status. The workspace may not be a repository.",
      );
    }
    return {
      modelResult: {
        branchAndChanges: result.stdout.trim(),
        clean: !result.stdout
          .split(/\r?\n/)
          .some((line) => line && !line.startsWith("##")),
        truncated: result.stdout.length >= MAX_COMMAND_OUTPUT_CHARS,
      },
    };
  }

  if (toolName === "git_diff") {
    let requestedPath = null;
    if (input.path !== undefined) {
      if (
        typeof input.path !== "string" ||
        !input.path.trim() ||
        input.path.includes("\0")
      ) {
        throw new Error("Git diff path must be a workspace-relative path.");
      }
      const verifiedPath = await verifyExistingTarget(
        workspaceRoot,
        input.path,
      );
      requestedPath = relative(workspaceRoot, verifiedPath).replace(
        /\\/g,
        "/",
      );
    }
    const args = [
      "diff",
      "--no-ext-diff",
      "--no-color",
      ...(input.staged ? ["--cached"] : []),
      ...(requestedPath ? ["--", requestedPath] : []),
    ];
    const result = await runGitCommand({
      args,
      cwd: workspaceRoot,
      signal,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim() ||
          "Unable to read Git diff. The workspace may not be a repository.",
      );
    }
    return {
      modelResult: {
        path: requestedPath,
        staged: Boolean(input.staged),
        diff: result.stdout.slice(0, MAX_GIT_DIFF_CHARS),
        truncated: result.stdout.length > MAX_GIT_DIFF_CHARS,
      },
    };
  }

  throw new Error(`Unsupported tool: ${toolName}`);
}

function normalizeImageAttachment(attachment) {
  if (
    !attachment ||
    typeof attachment.dataUrl !== "string" ||
    !attachment.dataUrl.startsWith("data:image/") ||
    attachment.dataUrl.length > 12_000_000
  ) {
    return null;
  }
  return {
    type: "image_url",
    image_url: {
      url: attachment.dataUrl,
    },
  };
}

function normalizeDocumentAttachment(attachment) {
  if (
    !attachment ||
    attachment.kind !== "document" ||
    typeof attachment.content !== "string"
  ) {
    return null;
  }
  const name = String(attachment.name || "未命名附件")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 240);
  const format = String(attachment.format || "文件")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 80);
  const pageDescription = Number.isInteger(attachment.pageCount)
    ? `，${attachment.pageCount} 页`
    : "";
  const notices = [
    attachment.truncated ? "内容已按本地安全上限截断" : "",
    attachment.requiresOcr ? "未提取到正文，可能需要 OCR" : "",
  ].filter(Boolean);
  const noticeText = notices.length ? `\n说明：${notices.join("；")}` : "";
  return [
    `[附件开始：${name}｜${format}${pageDescription}]`,
    attachment.content.slice(0, MAX_FILE_READ_CHARS),
    `${noticeText}\n[附件结束：${name}]`,
  ].join("\n");
}

export function sanitizeConversation(
  messages,
  { supportsImages = false } = {},
) {
  if (!Array.isArray(messages)) return [];

  return messages
    .filter(
      (message) =>
        ["user", "assistant"].includes(message?.role) &&
        typeof message?.content === "string" &&
        !message?.error &&
        !["failed", "interrupted", "running"].includes(message?.status) &&
        (message.content.trim() || message.attachments?.length),
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => {
      const text = message.content.slice(0, 100_000);
      if (message.role !== "user" || !message.attachments?.length) {
        return { role: message.role, content: text };
      }
      const documentText = message.attachments
        .slice(0, 6)
        .map(normalizeDocumentAttachment)
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 240_000);
      const combinedText = [text, documentText].filter(Boolean).join("\n\n");
      const imageAttachments = message.attachments.filter(
        (attachment) =>
          attachment?.kind === "image" ||
          typeof attachment?.dataUrl === "string",
      );
      if (!imageAttachments.length) {
        return { role: message.role, content: combinedText };
      }
      if (!supportsImages) {
        const attachmentNotice =
          "[系统提示：当前模型不支持读取本消息中的图片附件，图片已从模型请求中省略。]";
        return {
          role: message.role,
          content: combinedText
            ? `${combinedText}\n\n${attachmentNotice}`
            : attachmentNotice,
        };
      }
      const imageParts = imageAttachments
        .slice(0, 4)
        .map(normalizeImageAttachment)
        .filter(Boolean);
      if (!imageParts.length) {
        return { role: message.role, content: combinedText };
      }
      return {
        role: message.role,
        content: [
          {
            type: "text",
            text: combinedText || "请检查所附图片。",
          },
          ...imageParts,
        ],
      };
    });
}

async function loadProjectInstructions(workspaceRoot) {
  if (!workspaceRoot) return { content: "", files: [] };
  const sections = [];
  const files = [];

  for (const fileName of PROJECT_INSTRUCTION_FILES) {
    try {
      const filePath = await verifyExistingTarget(workspaceRoot, fileName);
      const stats = await lstat(filePath);
      if (!stats.isFile()) continue;
      const content = (await readFile(filePath, "utf8")).slice(0, 32_000);
      if (!content.trim()) continue;
      files.push(fileName);
      sections.push(`## ${fileName}\n${content}`);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // A missing optional project instruction file is expected.
      }
    }
  }

  return {
    files,
    content: sections.join("\n\n"),
  };
}

async function loadProjectConfig(workspaceRoot) {
  if (!workspaceRoot) {
    return { file: null, permissions: {} };
  }

  for (const fileName of PROJECT_CONFIG_FILES) {
    try {
      const filePath = await verifyExistingTarget(workspaceRoot, fileName);
      const stats = await lstat(filePath);
      if (!stats.isFile() || stats.size > 64_000) continue;
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      const permissions =
        parsed?.permissions &&
        typeof parsed.permissions === "object" &&
        !Array.isArray(parsed.permissions)
          ? parsed.permissions
          : {};
      return { file: fileName, permissions };
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error instanceof SyntaxError) {
        throw new Error(`${fileName} contains invalid JSON.`);
      }
      throw error;
    }
  }

  return { file: null, permissions: {} };
}

function appendToolCallDelta(toolCalls, incomingCall) {
  const index = Number.isInteger(incomingCall.index)
    ? incomingCall.index
    : toolCalls.length;
  const current = toolCalls[index] || {
    id: "",
    type: "function",
    function: { name: "", arguments: "" },
  };
  if (incomingCall.id) current.id = incomingCall.id;
  if (incomingCall.type) current.type = incomingCall.type;
  if (incomingCall.function?.name) {
    current.function.name += incomingCall.function.name;
  }
  if (incomingCall.function?.arguments) {
    current.function.arguments += incomingCall.function.arguments;
  }
  toolCalls[index] = current;
}

function compactConversationForRequest(conversation, onEvent) {
  let totalChars = JSON.stringify(conversation).length;
  if (totalChars <= CONTEXT_COMPACT_THRESHOLD_CHARS) return;

  let compactedMessages = 0;
  const keepRecentFrom = Math.max(1, conversation.length - 10);
  for (
    let index = 1;
    index < keepRecentFrom &&
    totalChars > CONTEXT_COMPACT_THRESHOLD_CHARS;
    index += 1
  ) {
    const message = conversation[index];
    if (
      message?.role !== "tool" ||
      typeof message.content !== "string" ||
      message.content.length <= COMPACTED_TOOL_CONTENT_CHARS
    ) {
      continue;
    }
    let compactedContent;
    try {
      const parsed = JSON.parse(message.content);
      compactedContent = JSON.stringify({
        compacted: true,
        path: parsed?.path || null,
        command: parsed?.command || null,
        query: parsed?.query || null,
        exitCode:
          typeof parsed?.exitCode === "number" ? parsed.exitCode : null,
        note:
          "Older verbose tool output was compacted. Re-run the tool if exact content is needed.",
      });
    } catch {
      compactedContent = JSON.stringify({
        compacted: true,
        preview: message.content.slice(
          0,
          COMPACTED_TOOL_CONTENT_CHARS,
        ),
        note:
          "Older verbose tool output was compacted. Re-run the tool if exact content is needed.",
      });
    }
    totalChars -= message.content.length - compactedContent.length;
    message.content = compactedContent;
    compactedMessages += 1;
  }

  if (compactedMessages > 0) {
    onEvent?.({
      type: "context.compacted",
      compactedMessages,
      estimatedChars: totalChars,
    });
  }
}

async function callModelProvider({
  provider,
  body,
  signal,
  onEvent,
}) {
  for (let attempt = 1; attempt <= PROVIDER_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await callModelProviderOnce({
        provider,
        body,
        signal,
        onEvent,
      });
    } catch (error) {
      if (
        signal?.aborted ||
        !error?.retryable ||
        attempt >= PROVIDER_MAX_ATTEMPTS
      ) {
        throw error;
      }
      const delayMs = 750 * 2 ** (attempt - 1);
      onEvent?.({
        type: "response.retry",
        attempt: attempt + 1,
        maxAttempts: PROVIDER_MAX_ATTEMPTS,
        delayMs,
        reason: error.message,
        provider: provider.name,
      });
      await waitForAbortableDelay(delayMs, signal);
    }
  }
  throw new Error(
    `${provider.name} request failed after automatic retries.`,
  );
}

function createOpenAICompatibleProvider({
  config,
  model,
  onEvent,
}) {
  return Object.freeze({
    id: config.id,
    name: config.name,
    vendor: config.vendor,
    supportsImages: Boolean(model.supportsImages),
    supportsTools: model.supportsTools !== false,
    supportsThinking: Boolean(model.supportsThinking),
    thinkingMode: model.thinkingMode || "none",
    supportsModel: (modelId) => model.id === modelId,
    complete: ({ body, signal }) =>
      callModelProvider({
        provider: config,
        body,
        signal,
        onEvent,
      }),
  });
}

function waitForAbortableDelay(delayMs, signal) {
  throwIfAborted(signal);
  return new Promise((resolveDelay, rejectDelay) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolveDelay();
    }, delayMs);
    const handleAbort = () => {
      clearTimeout(timeout);
      rejectDelay(createAbortError());
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

async function callModelProviderOnce({
  provider,
  body,
  signal,
  onEvent,
}) {
  throwIfAborted(signal);
  const controller = new AbortController();
  const handleAbort = () => controller.abort();
  signal?.addEventListener("abort", handleAbort, { once: true });
  let idleTimedOut = false;
  let idleTimeout = null;
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => {
      idleTimedOut = true;
      controller.abort();
    }, PROVIDER_IDLE_TIMEOUT_MS);
  };
  resetIdleTimeout();

  try {
    const response = await fetch(providerChatEndpoint(provider.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey
          ? { Authorization: `Bearer ${provider.apiKey}` }
          : {}),
      },
      body: JSON.stringify({
        ...body,
        stream: true,
        ...(["deepseek", "openai"].includes(provider.vendor)
          ? { stream_options: { include_usage: true } }
          : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const detail =
        payload?.error?.message ||
        payload?.message ||
        `${provider.name} API returned HTTP ${response.status}.`;
      const error = new Error(detail);
      error.retryable =
        response.status === 408 ||
        response.status === 409 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500;
      error.status = response.status;
      throw error;
    }
    if (!response.body) {
      throw new Error(
        `${provider.name} API returned an empty response stream.`,
      );
    }

    let content = "";
    let reasoningContent = "";
    let usage = null;
    let buffer = "";
    const toolCalls = [];
    const decoder = new TextDecoder();

    for await (const chunk of response.body) {
      throwIfAborted(signal);
      resetIdleTimeout();
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const payload = JSON.parse(data);
        if (payload.usage) usage = payload.usage;
        const delta = payload?.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          onEvent?.({ type: "response.delta", delta: delta.content });
        }
        if (
          typeof delta.reasoning_content === "string" &&
          delta.reasoning_content
        ) {
          reasoningContent += delta.reasoning_content;
        }
        for (const toolCall of delta.tool_calls || []) {
          appendToolCallDelta(toolCalls, toolCall);
        }
      }
    }

    return {
      message: {
        content,
        ...(reasoningContent
          ? { reasoning_content: reasoningContent }
          : {}),
        ...(toolCalls.length
          ? { tool_calls: toolCalls.filter(Boolean) }
          : {}),
      },
      usage,
    };
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    if (idleTimedOut) {
      const timeoutError = new Error(
        `${provider.name} connection was idle for 180 seconds.`,
      );
      timeoutError.retryable = true;
      throw timeoutError;
    }
    if (error?.name === "AbortError") {
      const abortError = new Error(
        `${provider.name} request was interrupted.`,
      );
      abortError.retryable = true;
      throw abortError;
    }
    if (error instanceof TypeError) {
      error.retryable = true;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeout);
    signal?.removeEventListener("abort", handleAbort);
  }
}

function buildChanges(changeMap) {
  return [...changeMap.values()].filter(
    (change) => change.beforeContent !== change.afterContent,
  );
}

function buildSelfCheckResult(selfCheck, changeMap) {
  const changedPaths = buildChanges(changeMap).map((change) => change.path);
  if (changedPaths.length === 0) {
    return {
      required: false,
      completed: true,
      reviewedFiles: [],
      summary: "",
      checks: [],
      improvements: [],
      remainingRisks: [],
      verification: {
        required: false,
        attempted: false,
        passed: false,
        candidates: [],
        results: [],
      },
    };
  }
  return {
    required: true,
    completed: Boolean(selfCheck.completed),
    reviewedFiles: changedPaths.filter(
      (path) =>
        selfCheck.reviewedVersions.get(path) ===
        changeMap.get(path)?.afterContent,
    ),
    summary: selfCheck.report?.summary || "",
    checks: selfCheck.report?.checks || [],
    improvements: selfCheck.report?.improvements || [],
    remainingRisks: selfCheck.report?.remainingRisks || [],
    verification: {
      required: selfCheck.verificationCandidates.length > 0,
      attempted: selfCheck.verificationAttempted,
      passed: selfCheck.verificationPassed,
      candidates: selfCheck.verificationCandidates,
      results: selfCheck.verificationResults,
    },
  };
}

async function discoverVerificationCommands(workspaceRoot, changeMap) {
  if (!workspaceRoot) return [];
  const directories = new Set(["."]);
  for (const change of buildChanges(changeMap)) {
    let directory = dirname(change.path).replace(/\\/g, "/");
    while (directory && directory !== ".") {
      directories.add(directory);
      const parent = dirname(directory).replace(/\\/g, "/");
      if (!parent || parent === directory) break;
      directory = parent;
    }
  }

  const candidates = [];
  const priorityScripts = ["test", "typecheck", "lint", "build"];
  for (const directory of directories) {
    try {
      const packagePath = directory === "."
        ? "package.json"
        : `${directory}/package.json`;
      const verifiedPackagePath = await verifyExistingTarget(
        workspaceRoot,
        packagePath,
      );
      const packageJson = JSON.parse(
        await readFile(verifiedPackagePath, "utf8"),
      );
      for (const scriptName of priorityScripts) {
        const script = packageJson?.scripts?.[scriptName];
        if (
          typeof script !== "string" ||
          !script.trim() ||
          /no test specified/i.test(script)
        ) {
          continue;
        }
        candidates.push({
          command: `npm run ${scriptName}`,
          cwd: directory,
          label: scriptName,
        });
      }
    } catch (error) {
      if (
        error?.code !== "ENOENT" &&
        !(error instanceof SyntaxError)
      ) {
        // Optional project metadata may be unreadable.
      }
    }
  }
  return candidates.slice(0, 8);
}

function createSelfCheckPrompt(changeMap, verificationCandidates) {
  const changes = buildChanges(changeMap);
  const changedPaths = changes.map((change) => change.path);
  const includesOfficeArtifacts = changes.some(
    (change) => change.binary && isOfficePath(change.path),
  );
  return [
    "进入强制自检阶段。最终答复暂时不会被接受。",
    "你必须使用 read_file 重新读取下面每个本轮修改过的文件，并检查正确性、完整性、安全性、性能和明显的边界情况：",
    ...changedPaths.map((path) => `- ${path}`),
    includesOfficeArtifacts
      ? "For every changed .docx, .pptx, or .xlsx file, use inspect_office_file instead of read_file. Confirm that the package is valid and that its document blocks, slides, sheets, rows, and formulas match the request. If an Office artifact is wrong, regenerate it with its create_* tool rather than write_file. Structural inspection does not prove the final visual layout, so record the missing visual render check in remaining_risks."
      : "",
    "发现问题时立即使用 write_file 修复。任何再次写入的文件都必须在修复后重新 read_file。",
    verificationCandidates.length
      ? [
          "Harness 检测到以下项目验证命令。必须使用 run_command 至少尝试一项最相关的验证；命令仍需用户审批：",
          ...verificationCandidates.map(
            (candidate) =>
              `- ${candidate.command}（目录：${candidate.cwd}）`,
          ),
        ].join("\n")
      : "未自动发现 package.json 中的 test/typecheck/lint/build 脚本；请进行静态复核并把未运行验证记录为剩余风险。",
    "全部复核完成后，调用 complete_self_check 提交具体检查项、改进内容和剩余风险。不要在调用该工具前给出最终答复。",
  ].join("\n");
}

function findVerificationCandidate(candidates, input) {
  if (!input || !Array.isArray(candidates)) return null;
  const command = String(input.command || "").trim();
  const cwd = String(input.cwd || ".")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "") || ".";
  return (
    candidates.find(
      (candidate) =>
        candidate.command === command && candidate.cwd === cwd,
    ) || null
  );
}

function sanitizeFinalAnswer(content) {
  return String(content || "")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
    .replace(/!\[[^\]]*\]\((?:data:image\/svg\+xml|[^)\s]+\.svg)[^)]*\)/gi, "")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function formatToolStepDetail(toolName, modelResult) {
  if (modelResult?.reason) return modelResult.reason;
  const error = String(modelResult?.error || "");
  if (!error) return null;
  if (/Invalid arguments/i.test(error)) {
    return "工具参数格式无效，Agent 将重新生成参数";
  }
  if (/Mandatory self-check has not started yet/i.test(error)) {
    return "Harness 已自动进入强制自检，继续复核本轮修改";
  }
  if (/Re-read these changed files/i.test(error)) {
    return error.replace(
      /^Re-read these changed files after their latest write before completing self-check:\s*/i,
      "仍需重新读取：",
    );
  }
  if (/Run at least one detected project verification command/i.test(error)) {
    return "仍需运行一项已检测到的项目验证命令";
  }
  return error;
}

export async function runHarness({
  provider: providerConfig,
  workspacePath,
  modelId,
  thinking,
  effort,
  permission,
  messages,
  signal,
  onEvent,
  requestApproval = async () => ({ approved: false }),
  sandboxExecutor = runSandboxedCommand,
  sandboxStatusResolver = getSandboxStatus,
}) {
  if (
    !providerConfig ||
    typeof providerConfig.id !== "string" ||
    typeof providerConfig.name !== "string" ||
    typeof providerConfig.baseUrl !== "string" ||
    !Array.isArray(providerConfig.models)
  ) {
    throw new Error("A valid model Provider is required.");
  }
  const emit = createEventEmitter(onEvent);
  const modelConfig = providerConfig.models.find(
    (candidate) => candidate.id === modelId,
  );
  if (!modelConfig) {
    throw new Error(
      `模型 ${modelId || "unknown"} 不属于 Provider ${providerConfig.name}。`,
    );
  }
  const provider = createOpenAICompatibleProvider({
    config: providerConfig,
    model: modelConfig,
    onEvent: emit,
  });

  const hasWorkspace =
    typeof workspacePath === "string" && Boolean(workspacePath.trim());
  const workspaceRoot = hasWorkspace
    ? await getVerifiedWorkspaceRoot(workspacePath)
    : null;
  const projectInstructions = await loadProjectInstructions(workspaceRoot);
  const projectConfig = await loadProjectConfig(workspaceRoot);
  const permissionPolicy = createPermissionPolicy(
    permission,
    projectConfig.permissions,
  );
  const canWriteWorkspace =
    getToolPermission(permissionPolicy, "write_file") !== "deny" ||
    getToolPermission(permissionPolicy, "apply_patch") !== "deny" ||
    [...OFFICE_CREATE_TOOL_NAMES].some(
      (toolName) =>
        getToolPermission(permissionPolicy, toolName) !== "deny",
    );
  const canRunCommands =
    getToolPermission(permissionPolicy, "run_command") !== "deny";
  const sandboxStatus =
    hasWorkspace && canRunCommands
      ? await sandboxStatusResolver()
      : null;
  const commandToolAvailable =
    canRunCommands && Boolean(sandboxStatus?.available);
  const toolCatalog = hasWorkspace
    ? TOOL_REGISTRY.catalog(permissionPolicy).map((tool) =>
        tool.name === "run_command" && !commandToolAvailable
          ? {
              ...tool,
              permission: "deny",
              unavailableReason:
                sandboxStatus?.detail || "Sandbox unavailable.",
            }
          : tool,
      )
    : [];
  const enabledToolDefinitions = hasWorkspace
    ? TOOL_REGISTRY.definitions(permissionPolicy).filter(
        (definition) =>
          provider.supportsTools &&
          (definition.function.name !== "run_command" ||
            commandToolAvailable),
      )
    : [];
  emit({
    type: "turn.started",
    provider: provider.id,
    providerName: provider.name,
    model: modelId,
    workspace: hasWorkspace,
    permissionMode: permission,
    permissionConfigFile: projectConfig.file,
    tools: toolCatalog,
    sandbox: sandboxStatus,
  });
  const conversation = [
    {
      role: "system",
      content: [
        "You are AporiaX, a local coding and productivity agent.",
        "Inspect the authorized workspace with tools before making claims about its contents.",
        "Use search_text to locate relevant code before reading many files.",
        "Use workspace-relative paths only.",
        "Never claim a file was changed unless write_file or apply_patch succeeded.",
        "Prefer apply_patch for localized edits and write_file for new files or complete rewrites.",
        "Use concise Markdown headings and GFM tables when structure helps.",
        "Put source code in fenced code blocks with an accurate language tag.",
        "Do not use emoji, pictograms, decorative symbols, or status glyphs anywhere in the final answer.",
        "Do not generate SVG markup or SVG files unless the user explicitly asks for SVG output.",
        "Use git_status and git_diff to inspect repository changes when the workspace is a Git repository.",
        "Use create_word_document, create_presentation, and create_spreadsheet for real Office files. Do not try to write Office binaries with write_file.",
        "Create one Office artifact per tool call and follow its JSON schema exactly. For Word, blocks must be an array of heading, paragraph, bullets, table, or page_break objects.",
        "After creating or replacing an Office file, use inspect_office_file during mandatory self-check. Treat structural inspection as distinct from final visual rendering.",
        commandToolAvailable
          ? "Use run_command only when a command materially verifies the result. Commands run in a network-disabled OS-level container sandbox with a read-only root filesystem and only the current workspace mounted writable."
          : "Command execution is unavailable because the OS-level sandbox is not ready. Never claim that a build or test was run.",
        "When the Harness starts the mandatory self-check phase, re-read every changed file, fix issues you find, re-read files after fixes, and call complete_self_check before answering.",
        "The desktop UI already presents changed files, verification, Route history, and deliverables. Do not repeat them as Markdown inventory tables or tool-call logs in the final answer.",
        !hasWorkspace
          ? "No workspace is attached. Answer without file tools and ask the user to attach a workspace when file access is required."
          : [
              canWriteWorkspace
                ? "Workspace file changes are available subject to the effective Harness permission policy."
                : "File mutation tools are disabled for this task.",
              commandToolAvailable
                ? "The sandboxed command tool is available subject to the effective Harness permission policy."
                : canRunCommands
                  ? `The command tool is fail-closed because the sandbox is unavailable: ${sandboxStatus?.detail || "unknown reason"}`
                  : "The command tool is disabled for this task.",
            ].join(" "),
        "Keep the final answer concise. State the outcome, important limitations, and any user action still required.",
        projectInstructions.content
          ? `Follow these project instructions:\n${projectInstructions.content}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    ...sanitizeConversation(messages, {
      supportsImages: provider.supportsImages,
    }),
  ];

  if (conversation.length < 2) {
    throw new Error("At least one user message is required.");
  }

  const steps = [];
  const changeMap = new Map();
  const selfCheck = {
    started: false,
    completed: false,
    reviewedVersions: new Map(),
    report: null,
    verificationCandidates: [],
    verificationAttempted: false,
    verificationPassed: false,
    verificationResults: [],
  };
  let totalUsage = null;

  try {
    for (let step = 0; ; step += 1) {
      throwIfAborted(signal);
      emit({
        type: "response.reset",
        round: step + 1,
        phase: selfCheck.started ? "self-check" : "work",
      });
      compactConversationForRequest(conversation, emit);
      const { message, usage } = await provider.complete({
        signal,
        body: {
          model: modelId,
          messages: conversation,
          ...(hasWorkspace && provider.supportsTools
            ? {
                tools: enabledToolDefinitions,
                tool_choice: "auto",
              }
            : {}),
          ...(provider.supportsThinking &&
          provider.thinkingMode === "deepseek"
            ? {
                thinking: {
                  type: thinking ? "enabled" : "disabled",
                },
                reasoning_effort: effort === "max" ? "max" : "high",
              }
            : {}),
          ...(provider.supportsThinking &&
          provider.thinkingMode === "reasoning-effort" &&
          thinking
            ? {
                reasoning_effort: effort === "max" ? "high" : "medium",
              }
            : {}),
        },
      });
      totalUsage = usage || totalUsage;

      if (
        !Array.isArray(message.tool_calls) ||
        message.tool_calls.length === 0
      ) {
        const changes = buildChanges(changeMap);
        if (changes.length > 0 && !selfCheck.started) {
          selfCheck.started = true;
          selfCheck.completed = false;
          selfCheck.report = null;
          selfCheck.verificationCandidates =
            !commandToolAvailable
              ? []
              : await discoverVerificationCommands(
                  workspaceRoot,
                  changeMap,
                );
          emit({
            type: "self_check.started",
            paths: changes.map((change) => change.path),
            verificationCandidates:
              selfCheck.verificationCandidates,
          });
          conversation.push({
            role: "assistant",
            content: message.content || "初步实现已经完成。",
          });
          conversation.push({
            role: "user",
            content: createSelfCheckPrompt(
              changeMap,
              selfCheck.verificationCandidates,
            ),
          });
          continue;
        }

        if (selfCheck.started && !selfCheck.completed) {
          const pendingPaths = getPendingSelfCheckPaths(
            changeMap,
            selfCheck.reviewedVersions,
          );
          conversation.push({
            role: "assistant",
            content: message.content || "自检尚未完成。",
          });
          conversation.push({
            role: "user",
            content: [
              "强制自检尚未完成，当前最终答复被 Harness 拦截。",
              pendingPaths.length
                ? `仍需在最新写入后重新读取：\n${pendingPaths
                    .map((path) => `- ${path}`)
                    .join("\n")}`
                : "所有改动文件已读取，但还没有成功调用 complete_self_check。",
              "继续自检并调用 complete_self_check，不要直接结束任务。",
            ].join("\n"),
          });
          continue;
        }

        const completedResult = {
          status: "completed",
          content:
            typeof message.content === "string" && message.content.trim()
              ? sanitizeFinalAnswer(message.content)
              : "任务已完成，但模型没有返回文本结果。",
          steps,
          changes: buildChanges(changeMap),
          usage: totalUsage,
          instructionFiles: projectInstructions.files,
          permissionConfigFile: projectConfig.file,
          provider: provider.id,
          providerName: provider.name,
          model: modelId,
          sandbox: sandboxStatus,
          tools: toolCatalog,
          selfCheck: buildSelfCheckResult(selfCheck, changeMap),
        };
        emit({
          type: "turn.completed",
          status: completedResult.status,
          changedFiles: completedResult.changes.length,
          toolSteps: steps.length,
        });
        return completedResult;
      }

      const assistantToolMessage = {
        role: "assistant",
        content: message.content ?? null,
        tool_calls: message.tool_calls,
      };
      if (message.reasoning_content) {
        assistantToolMessage.reasoning_content =
          message.reasoning_content;
      }
      conversation.push(assistantToolMessage);

      for (const toolCall of message.tool_calls) {
        throwIfAborted(signal);
        let result;
        let success = true;
        let matchedVerificationCandidate = null;
        emit({
          type: "tool.requested",
          callId: toolCall.id,
          tool: toolCall.function.name,
          phase: selfCheck.started ? "self-check" : "work",
        });
        emit({
          type: "tool.started",
          tool: toolCall.function.name,
          phase: selfCheck.started ? "self-check" : "work",
        });
        try {
          if (toolCall.function.name === "complete_self_check") {
            if (!selfCheck.started) {
              const changes = buildChanges(changeMap);
              if (!changes.length) {
                throw new Error(
                  "Mandatory self-check has not started yet because no changed files exist.",
                );
              }
              selfCheck.started = true;
              selfCheck.completed = false;
              selfCheck.report = null;
              selfCheck.verificationCandidates =
                getToolPermission(permissionPolicy, "run_command") === "deny"
                  ? []
                  : await discoverVerificationCommands(
                      workspaceRoot,
                      changeMap,
                    );
              emit({
                type: "self_check.started",
                paths: changes.map((change) => change.path),
                verificationCandidates:
                  selfCheck.verificationCandidates,
              });
            }
            const pendingPaths = getPendingSelfCheckPaths(
              changeMap,
              selfCheck.reviewedVersions,
            );
            if (pendingPaths.length > 0) {
              throw new Error(
                `Re-read these changed files after their latest write before completing self-check: ${pendingPaths.join(", ")}`,
              );
            }
            if (
              selfCheck.verificationCandidates.length > 0 &&
              !selfCheck.verificationAttempted
            ) {
              throw new Error(
                "Run at least one detected project verification command before completing self-check.",
              );
            }
            const report = normalizeSelfCheckReport(
              parseToolArguments(toolCall),
            );
            const includesUnrenderedOfficeArtifact = buildChanges(
              changeMap,
            ).some(
              (change) =>
                change.binary &&
                isOfficePath(change.path) &&
                change.artifact?.visualQa !== "rendered",
            );
            if (
              includesUnrenderedOfficeArtifact &&
              !report.remainingRisks.some((risk) =>
                /visual|render|layout|版式|渲染|视觉/i.test(risk),
              )
            ) {
              report.remainingRisks.push(
                "Office 文件已通过结构检查，最终视觉版式仍需在对应 Office 应用中确认。",
              );
            }
            if (
              (!selfCheck.verificationCandidates.length ||
                (selfCheck.verificationAttempted &&
                  !selfCheck.verificationPassed)) &&
              report.remainingRisks.length === 0
            ) {
              report.remainingRisks.push(
                selfCheck.verificationCandidates.length
                  ? "项目验证命令未通过，仍需人工确认运行结果。"
                  : "未发现可执行的项目验证脚本，已完成静态复核。",
              );
            }
            selfCheck.completed = true;
            selfCheck.report = report;
            result = {
              modelResult: {
                completed: true,
                reviewedFiles: buildChanges(changeMap).map(
                  (change) => change.path,
                ),
                ...report,
              },
            };
            emit({
              type: "self_check.completed",
              report: buildSelfCheckResult(selfCheck, changeMap),
            });
          } else {
            const parsedToolInput =
              toolCall.function.name === "run_command"
                ? parseToolArguments(toolCall)
                : null;
            matchedVerificationCandidate = selfCheck.started
              ? findVerificationCandidate(
                  selfCheck.verificationCandidates,
                  parsedToolInput,
                )
              : null;
            if (matchedVerificationCandidate) {
              selfCheck.verificationAttempted = true;
            }
            result = await executeTool({
              toolCall,
              workspaceRoot,
              permissionPolicy,
              requestApproval,
              signal,
              sandboxExecutor,
              sandboxStatus,
            });
            if (result.change) {
              mergeFileChange(changeMap, result.change);
              emit({
                type: "file.changed",
                path: result.change.path,
                additions: result.change.additions,
                deletions: result.change.deletions,
                binary: Boolean(result.change.binary),
                artifact: result.change.artifact || null,
                created: result.change.created,
              });
              if (selfCheck.started) {
                selfCheck.completed = false;
                selfCheck.report = null;
              }
            }
            if (
              selfCheck.started &&
              changeMap.has(result.modelResult?.path) &&
              ((changeMap.get(result.modelResult.path).binary &&
                toolCall.function.name === "inspect_office_file") ||
                (!changeMap.get(result.modelResult.path).binary &&
                  toolCall.function.name === "read_file"))
            ) {
              selfCheck.reviewedVersions.set(
                result.modelResult.path,
                changeMap.get(result.modelResult.path).afterContent,
              );
            }
            if (
              matchedVerificationCandidate &&
              toolCall.function.name === "run_command"
            ) {
              const passed = result.modelResult?.exitCode === 0;
              selfCheck.verificationPassed =
                selfCheck.verificationPassed || passed;
              selfCheck.verificationResults.push({
                command:
                  result.modelResult?.command ||
                  parsedToolInput?.command ||
                  "",
                cwd:
                  result.modelResult?.cwd ||
                  parsedToolInput?.cwd ||
                  ".",
                passed,
                exitCode:
                  typeof result.modelResult?.exitCode === "number"
                    ? result.modelResult.exitCode
                    : null,
              });
            }
          }
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          success = false;
          if (
            selfCheck.started &&
            toolCall.function.name === "run_command"
          ) {
            let failedCommand = "";
            let failedCwd = ".";
            try {
              const failedInput = parseToolArguments(toolCall);
              failedCommand = failedInput.command || "";
              failedCwd = failedInput.cwd || ".";
              matchedVerificationCandidate =
                findVerificationCandidate(
                  selfCheck.verificationCandidates,
                  failedInput,
                );
            } catch {
              // Invalid tool input is already surfaced to the model.
            }
            if (matchedVerificationCandidate) {
              selfCheck.verificationAttempted = true;
              selfCheck.verificationResults.push({
                command: failedCommand,
                cwd: failedCwd,
                passed: false,
                exitCode: null,
                error: error.message,
              });
            }
          }
          result = { modelResult: { error: error.message } };
        }

        const modelResult = result.modelResult;
        const stepDetail = formatToolStepDetail(
          toolCall.function.name,
          modelResult,
        );
        const shouldRetry =
          !success &&
          (toolCall.function.name === "complete_self_check" ||
            /Invalid arguments/i.test(modelResult?.error || ""));
        steps.push({
          name: toolCall.function.name,
          success,
          skipped: Boolean(modelResult?.skipped),
          retry: shouldRetry,
          detail: stepDetail,
          path: modelResult?.path || null,
          command: modelResult?.command || null,
          additions: modelResult?.additions || 0,
          deletions: modelResult?.deletions || 0,
          created: Boolean(modelResult?.created),
          binary: Boolean(result.change?.binary),
          artifact:
            modelResult?.artifact ||
            modelResult?.inspection ||
            null,
          exitCode:
            typeof modelResult?.exitCode === "number"
              ? modelResult.exitCode
              : null,
        });
        emit({
          type: "tool.completed",
          tool: toolCall.function.name,
          success,
          skipped: Boolean(modelResult?.skipped),
          retry: shouldRetry,
          detail: stepDetail,
          phase: selfCheck.started ? "self-check" : "work",
        });
        conversation.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(modelResult),
        });
      }
    }

  } catch (error) {
    if (error?.name === "AbortError" || signal?.aborted) {
      const interruptedResult = {
        status: "interrupted",
        content: "任务已停止。已经完成的文件修改仍保留，可在审核面板中撤销。",
        steps,
        changes: buildChanges(changeMap),
        usage: totalUsage,
        instructionFiles: projectInstructions.files,
        permissionConfigFile: projectConfig.file,
        provider: provider.id,
        providerName: provider.name,
        model: modelId,
        sandbox: sandboxStatus,
        tools: toolCatalog,
        selfCheck: buildSelfCheckResult(selfCheck, changeMap),
      };
      emit({
        type: "turn.cancelled",
        status: interruptedResult.status,
        changedFiles: interruptedResult.changes.length,
        toolSteps: steps.length,
      });
      return interruptedResult;
    }
    const failedResult = {
      status: "failed",
      error: true,
      content: error?.message || "Harness 运行失败。",
      steps,
      changes: buildChanges(changeMap),
      usage: totalUsage,
      instructionFiles: projectInstructions.files,
      permissionConfigFile: projectConfig.file,
      provider: provider.id,
      providerName: provider.name,
      model: modelId,
      sandbox: sandboxStatus,
      tools: toolCatalog,
      selfCheck: buildSelfCheckResult(selfCheck, changeMap),
    };
    emit({
      type: "turn.failed",
      status: failedResult.status,
      error: failedResult.content,
      changedFiles: failedResult.changes.length,
      toolSteps: steps.length,
    });
    return failedResult;
  }
}

export async function listWorkspaceTree(workspacePath) {
  const workspaceRoot = await getVerifiedWorkspaceRoot(workspacePath);
  const entries = [];

  async function visit(relativeDirectory, depth) {
    if (entries.length >= MAX_TREE_ENTRIES || depth > MAX_TREE_DEPTH) return;
    const directoryPath = await verifyExistingTarget(
      workspaceRoot,
      relativeDirectory || ".",
    );
    const children = await readdir(directoryPath, { withFileTypes: true });
    children.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

    for (const child of children) {
      if (entries.length >= MAX_TREE_ENTRIES) break;
      if (TREE_IGNORES.has(child.name) || child.isSymbolicLink()) continue;
      const childRelative = relativeDirectory && relativeDirectory !== "."
        ? `${relativeDirectory.replace(/\\/g, "/")}/${child.name}`
        : child.name;
      if (child.isDirectory()) {
        entries.push({
          path: childRelative,
          name: child.name,
          type: "directory",
          depth,
        });
        await visit(childRelative, depth + 1);
      } else if (child.isFile()) {
        entries.push({
          path: childRelative,
          name: child.name,
          type: "file",
          depth,
          extension: extname(child.name).slice(1).toLowerCase(),
        });
      }
    }
  }

  await visit(".", 0);
  return {
    entries,
    truncated: entries.length >= MAX_TREE_ENTRIES,
  };
}

export async function readWorkspacePreview(workspacePath, requestedPath) {
  const workspaceRoot = await getVerifiedWorkspaceRoot(workspacePath);
  const filePath = await verifyExistingTarget(workspaceRoot, requestedPath);
  const stats = await lstat(filePath);
  if (!stats.isFile()) throw new Error("The selected path is not a file.");
  if (extname(requestedPath).toLowerCase() === ".pdf") {
    if (stats.size > MAX_ATTACHMENT_BYTES) {
      throw new Error("PDF preview is limited to 8 MB.");
    }
    const pdf = await extractPdfText(await readFile(filePath), {
      maxChars: 200_000,
    });
    return {
      path: requestedPath,
      ...pdf,
      extension: "pdf",
      readOnly: true,
    };
  }
  if (isOfficePath(requestedPath)) {
    if (stats.size > MAX_OFFICE_FILE_BYTES) {
      throw new Error(
        `Office preview is limited to ${Math.floor(MAX_OFFICE_FILE_BYTES / 1_000_000)} MB.`,
      );
    }
    const artifact = await inspectOfficeArtifact(
      requestedPath,
      await readFile(filePath),
    );
    const content = JSON.stringify(artifact, null, 2);
    return {
      path: requestedPath,
      content,
      truncated: false,
      extension: extname(requestedPath).slice(1).toLowerCase(),
      artifact,
      binary: true,
    };
  }
  if (stats.size > 2_000_000) {
    throw new Error("File preview is limited to 2 MB.");
  }
  const content = await readFile(filePath, "utf8");
  if (content.includes("\0")) {
    throw new Error("Binary files cannot be previewed.");
  }
  return {
    path: requestedPath,
    content: content.slice(0, 200_000),
    truncated: content.length > 200_000,
    extension: extname(requestedPath).slice(1).toLowerCase(),
  };
}

export async function saveWorkspaceTextFile({
  workspacePath,
  requestedPath,
  content,
  expectedContent,
}) {
  if (typeof content !== "string") {
    throw new Error("Text content is required.");
  }
  if (Buffer.byteLength(content, "utf8") > 2_000_000) {
    throw new Error("Text editing is limited to 2 MB.");
  }

  const workspaceRoot = await getVerifiedWorkspaceRoot(workspacePath);
  const existingPath = await verifyExistingTarget(
    workspaceRoot,
    requestedPath,
  );
  const stats = await lstat(existingPath);
  if (!stats.isFile()) throw new Error("The selected path is not a file.");

  const currentContent = await readFile(existingPath, "utf8");
  if (currentContent.includes("\0")) {
    throw new Error("Binary files cannot be edited as text.");
  }
  if (
    typeof expectedContent === "string" &&
    currentContent !== expectedContent
  ) {
    throw new Error(
      "文件已在编辑器之外发生变化。请重新打开文件后再保存。",
    );
  }

  const writablePath = await verifyWritableTarget(
    workspaceRoot,
    requestedPath,
  );
  await writeFile(writablePath, content, "utf8");
  return {
    path: requestedPath,
    content,
    truncated: false,
    extension: extname(requestedPath).slice(1).toLowerCase(),
    savedAt: new Date().toISOString(),
  };
}

export async function revertWorkspaceChanges({
  workspacePath,
  changes,
}) {
  const workspaceRoot = await getVerifiedWorkspaceRoot(workspacePath);
  if (!Array.isArray(changes) || changes.length === 0) return [];
  const results = [];

  for (const change of changes.slice(0, 100)) {
    if (
      !change ||
      typeof change.path !== "string" ||
      typeof change.beforeContent !== "string" ||
      typeof change.afterContent !== "string" ||
      (change.binary &&
        (!isOfficePath(change.path) ||
          change.beforeContent.length >
            Math.ceil(MAX_OFFICE_FILE_BYTES * 1.4) ||
          change.afterContent.length >
            Math.ceil(MAX_OFFICE_FILE_BYTES * 1.4)))
    ) {
      results.push({
        path: change?.path || "unknown",
        success: false,
        reason: "invalid-checkpoint",
      });
      continue;
    }

    try {
      const filePath = await verifyWritableTarget(
        workspaceRoot,
        change.path,
      );
      let currentContent = null;
      try {
        const currentBuffer = await readFile(filePath);
        currentContent = change.binary
          ? currentBuffer.toString("base64")
          : currentBuffer.toString("utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }

      if (currentContent !== change.afterContent) {
        results.push({
          path: change.path,
          success: false,
          reason: "file-changed-after-checkpoint",
        });
        continue;
      }

      if (change.created) {
        await rm(filePath, { force: true });
      } else if (change.binary) {
        const previousBuffer = Buffer.from(
          change.beforeContent,
          "base64",
        );
        if (previousBuffer.length > MAX_OFFICE_FILE_BYTES) {
          throw new Error("Office checkpoint exceeds the restore limit.");
        }
        await writeFile(filePath, previousBuffer);
      } else {
        await writeFile(filePath, change.beforeContent, "utf8");
      }
      results.push({ path: change.path, success: true });
    } catch (error) {
      results.push({
        path: change.path,
        success: false,
        reason: error.message,
      });
    }
  }

  return results;
}
