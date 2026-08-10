import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
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
  runCommandWithFallback,
} from "./sandbox-runtime.js";
import {
  compactConversationForRequest as compactManagedConversation,
  createProjectMemoryStore,
  createTokenAccounting,
  estimateConversationTokens as estimateManagedConversationTokens,
  loadProjectInstructionContext,
  mergeTokenUsage,
  recordProviderUsage,
  resolveScopedInstructions,
  upsertRelevantContextMessage,
} from "./agent-context.js";
import { createWitnessMonitor } from "./witness-monitor.js";
import {
  BROWSER_TOOL_DEFINITIONS,
  BROWSER_TOOL_RISKS,
  createBrowserRuntime,
  executeBrowserTool,
  isBrowserToolName,
} from "./browser-runtime.js";
import {
  createProjectUnderstandingStore,
  normalizeProjectUnderstandingCandidate,
} from "./project-understanding.js";

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
const MAX_GIT_DIFF_CHARS = 120_000;
const MAX_ANCHOR_FILES = 1_200;
const MAX_ANCHOR_TOTAL_BYTES = 8_000_000;
const MAX_ANCHOR_TEXT_FILE_BYTES = 1_000_000;
const MAX_ANCHOR_BINARY_FILE_BYTES = 2_000_000;
const PROVIDER_IDLE_TIMEOUT_MS = 180_000;
const PROVIDER_MAX_ATTEMPTS = 3;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const MAX_PARALLEL_TOOL_CALLS = 4;
const DEFAULT_SUBAGENT_ROUNDS = 8;
const MAX_SUBAGENT_ROUNDS = 20;
const MAX_SUBAGENT_TASK_CHARS = 4_000;
const MAX_SUBAGENT_RESULT_CHARS = 24_000;
const MAX_SUBAGENT_EVIDENCE_CHARS = 24_000;
const PROGRESSIVE_REVIEW_FILE_THRESHOLD = 3;
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
const ANCHOR_IGNORES = new Set([
  ...TREE_IGNORES,
  ".cache",
  ".parcel-cache",
  ".runtime-smoke",
  ".venv",
  "__pycache__",
  "build",
  "out",
  "release",
  "release_update",
  "release_v031_latest",
  "target",
  "venv",
]);

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "delegate_subagent",
      description:
        "Delegate an independent exploration, code review, or verification task to a restricted subagent with its own context. Issue multiple delegate_subagent calls in one response when the tasks are independent; AporiaX runs them concurrently. Use background=true for a long verification while the main agent continues other work.",
      parameters: {
        type: "object",
        properties: {
          role: {
            type: "string",
            enum: ["explore", "review", "verify", "curator"],
            description:
              "explore searches and explains, review inspects correctness without editing, verify may run project checks, and curator extracts durable project understanding with evidence.",
          },
          task: {
            type: "string",
            description:
              "A self-contained task with the question, expected evidence, and completion criteria.",
          },
          scope: {
            type: "array",
            maxItems: 12,
            items: { type: "string" },
            description:
              "Optional workspace-relative paths the subagent may inspect. Defaults to the whole workspace.",
          },
          background: {
            type: "boolean",
            description:
              "Run without blocking the main agent. Background results are collected before final delivery.",
          },
          max_rounds: {
            type: "integer",
            minimum: 2,
            maximum: MAX_SUBAGENT_ROUNDS,
            description:
              "Maximum isolated model rounds. Defaults to 8 and is a safety budget, not the parent task limit.",
          },
        },
        required: ["role", "task"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "collect_subagents",
      description:
        "Collect completed or running background subagent results. Wait for them when their evidence is needed before continuing or answering.",
      parameters: {
        type: "object",
        properties: {
          agent_ids: {
            type: "array",
            maxItems: 12,
            items: { type: "string" },
            description:
              "Optional agent ids to collect. Omit to collect every uncollected background subagent.",
          },
          wait: {
            type: "boolean",
            description:
              "Wait for running agents to finish. Defaults to true.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember_project_fact",
      description:
        "Propose a durable, non-secret Project Understanding candidate for future tasks. The proposal is not committed immediately: the Curator subagent and Harness validate its evidence before creating a revision. Use only for reusable architecture, commands, conventions, decisions, debugging knowledge, or explicit user preferences; never submit credentials or one-off task details.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: [
              "architecture",
              "module",
              "command",
              "convention",
              "decision",
              "debugging",
              "known_issue",
              "preference",
              "verification",
            ],
          },
          content: { type: "string" },
          evidence: {
            type: "string",
            description:
              "Optional file, command, or user statement supporting the fact.",
          },
        },
        required: ["category", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_plan",
      description:
        "Create or revise the explicit execution plan shown to the user. Use this before a multi-step task and whenever the route changes.",
      parameters: {
        type: "object",
        properties: {
          explanation: {
            type: "string",
            description:
              "A concise reason for creating or revising this plan.",
          },
          steps: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description:
                    "Stable short identifier reused across plan updates.",
                },
                title: {
                  type: "string",
                  description: "Concrete user-facing step title.",
                },
                status: {
                  type: "string",
                  enum: [
                    "pending",
                    "in_progress",
                    "completed",
                    "blocked",
                  ],
                },
                detail: {
                  type: "string",
                  description:
                    "Optional short evidence, blocker, or expected output.",
                },
              },
              required: ["id", "title", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["steps"],
        additionalProperties: false,
      },
    },
  },
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
        "Run one foreground workspace command. Prefer the network-disabled Docker sandbox; when Docker is unavailable, use the explicitly approved host fallback without OS isolation.",
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
  ...BROWSER_TOOL_DEFINITIONS,
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
  delegate_subagent: "control",
  collect_subagents: "control",
  remember_project_fact: "control",
  update_plan: "control",
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
  ...BROWSER_TOOL_RISKS,
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

function anchorFileLimit(path) {
  return isOfficePath(path)
    ? MAX_OFFICE_FILE_BYTES
    : MAX_ANCHOR_TEXT_FILE_BYTES;
}

function decodeAnchorFile(path, buffer) {
  if (isOfficePath(path)) {
    return {
      path,
      binary: true,
      content: buffer.toString("base64"),
      bytes: buffer.length,
    };
  }
  try {
    return {
      path,
      binary: false,
      content: new TextDecoder("utf-8", { fatal: true }).decode(buffer),
      bytes: buffer.length,
    };
  } catch {
    if (buffer.length > MAX_ANCHOR_BINARY_FILE_BYTES) return null;
    return {
      path,
      binary: true,
      content: buffer.toString("base64"),
      bytes: buffer.length,
    };
  }
}

async function captureWorkspaceStateFromRoot(
  workspaceRoot,
  signal,
) {
  const files = new Map();
  let totalBytes = 0;
  let skippedFiles = 0;
  let truncated = false;

  async function visit(relativeDirectory, depth) {
    throwIfAborted(signal);
    if (
      files.size >= MAX_ANCHOR_FILES ||
      totalBytes >= MAX_ANCHOR_TOTAL_BYTES ||
      depth > 12
    ) {
      truncated = true;
      return;
    }
    const directoryPath =
      relativeDirectory === "."
        ? workspaceRoot
        : resolveWorkspacePath(workspaceRoot, relativeDirectory);
    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      skippedFiles += 1;
      return;
    }
    entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      throwIfAborted(signal);
      if (
        files.size >= MAX_ANCHOR_FILES ||
        totalBytes >= MAX_ANCHOR_TOTAL_BYTES
      ) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink() || ANCHOR_IGNORES.has(entry.name)) {
        continue;
      }
      const relativePath =
        relativeDirectory === "."
          ? entry.name
          : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const filePath = resolveWorkspacePath(
          workspaceRoot,
          relativePath,
        );
        const stats = await lstat(filePath);
        if (
          !stats.isFile() ||
          stats.isSymbolicLink() ||
          stats.size > anchorFileLimit(relativePath) ||
          totalBytes + stats.size > MAX_ANCHOR_TOTAL_BYTES
        ) {
          skippedFiles += 1;
          if (totalBytes + stats.size > MAX_ANCHOR_TOTAL_BYTES) {
            truncated = true;
          }
          continue;
        }
        const record = decodeAnchorFile(
          relativePath.replace(/\\/g, "/"),
          await readFile(filePath),
        );
        if (!record) {
          skippedFiles += 1;
          continue;
        }
        files.set(record.path, record);
        totalBytes += record.bytes;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        skippedFiles += 1;
      }
    }
  }

  await visit(".", 0);
  return {
    files,
    capturedFiles: files.size,
    totalBytes,
    skippedFiles,
    truncated,
  };
}

export async function captureWorkspaceState(workspacePath, options = {}) {
  const workspaceRoot = await getVerifiedWorkspaceRoot(workspacePath);
  return captureWorkspaceStateFromRoot(workspaceRoot, options.signal);
}

function reconcileWorkspaceState(
  changeMap,
  beforeSnapshot,
  afterSnapshot,
) {
  if (!beforeSnapshot?.files || !afterSnapshot?.files) return [];
  const changed = [];
  const paths = new Set([
    ...beforeSnapshot.files.keys(),
    ...afterSnapshot.files.keys(),
  ]);
  for (const path of paths) {
    const before = beforeSnapshot.files.get(path) || null;
    const after = afterSnapshot.files.get(path) || null;
    if (
      Boolean(before) === Boolean(after) &&
      before?.binary === after?.binary &&
      before?.content === after?.content
    ) {
      continue;
    }
    const current = changeMap.get(path);
    const binary = Boolean(
      before?.binary || after?.binary || current?.binary,
    );
    const change = {
      ...(current || {}),
      path,
      beforeContent:
        before?.content ?? current?.beforeContent ?? "",
      afterContent: after?.content ?? "",
      beforeMissing: !before,
      afterMissing: !after,
      binary,
      artifact: current?.artifact || null,
      created: !before,
      deleted: !after,
      reverted: false,
      source: current?.source || "workspace-snapshot",
    };
    if (binary) {
      change.additions = 0;
      change.deletions = 0;
    } else {
      const lineChanges = calculateLineChanges(
        change.beforeContent,
        change.afterContent,
      );
      change.additions = lineChanges.additions;
      change.deletions = lineChanges.deletions;
    }
    changeMap.set(path, change);
    changed.push(change);
  }
  return changed;
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

function describeToolActivity(toolCall) {
  try {
    const input = JSON.parse(toolCall.function.arguments || "{}");
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return {};
    }
    const path =
      input.path ||
      input.filePath ||
      input.outputPath ||
      input.destination ||
      input.archivePath ||
      "";
    const command =
      typeof input.command === "string" ? input.command : "";
    const detail =
      input.query ||
      input.pattern ||
      input.title ||
      input.name ||
      "";
    return {
      ...(path ? { path: String(path).slice(0, 260) } : {}),
      ...(command ? { command: command.slice(0, 420) } : {}),
      ...(detail ? { detail: String(detail).slice(0, 260) } : {}),
    };
  } catch {
    return {};
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
  current.afterMissing = Boolean(change.afterMissing);
  current.deleted = Boolean(change.afterMissing || change.deleted);
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
        !change?.afterMissing &&
        (!change?.binary || isOfficePath(change.path)) &&
        (Boolean(change?.beforeMissing) !==
          Boolean(change?.afterMissing) ||
          change?.beforeContent !== change?.afterContent) &&
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

function normalizeExecutionPlan(input, previousPlan = null) {
  if (!Array.isArray(input?.steps) || input.steps.length === 0) {
    throw new Error("update_plan requires at least one plan step.");
  }
  if (input.steps.length > 20) {
    throw new Error("update_plan supports at most 20 plan steps.");
  }
  const ids = new Set();
  let activeSteps = 0;
  const steps = input.steps.map((step, index) => {
    const id = String(step?.id || `step-${index + 1}`)
      .trim()
      .slice(0, 80);
    const title = String(step?.title || "").trim().slice(0, 240);
    const status = String(step?.status || "pending");
    if (!id || ids.has(id)) {
      throw new Error("Every plan step must have a unique id.");
    }
    if (!title) {
      throw new Error("Every plan step must have a title.");
    }
    if (
      !["pending", "in_progress", "completed", "blocked"].includes(
        status,
      )
    ) {
      throw new Error(`Unsupported plan step status: ${status}`);
    }
    ids.add(id);
    if (status === "in_progress") activeSteps += 1;
    return {
      id,
      title,
      status,
      detail: String(step?.detail || "").trim().slice(0, 500),
    };
  });
  if (activeSteps > 1) {
    throw new Error("Only one plan step can be in progress at a time.");
  }
  return {
    revision: (previousPlan?.revision || 0) + 1,
    explanation: String(input?.explanation || "").trim().slice(0, 500),
    steps,
    updatedAt: new Date().toISOString(),
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
  approvalMode = "manual",
  requestApproval,
  signal,
  sandboxExecutor = runCommandWithFallback,
  sandboxStatus = null,
  browserRuntime = null,
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
  const sandboxAutoApproved =
    approvalMode === "sandbox-auto" &&
    toolName === "run_command" &&
    Boolean(
      sandboxStatus?.autoApprovalSafe ||
        sandboxStatus?.available ||
        sandboxStatus?.localAvailable,
    );
  const requiresApproval =
    (permissionAction === "ask" && !sandboxAutoApproved) ||
    (toolName === "run_command" &&
      approvalMode === "manual" &&
      !sandboxAutoApproved);
  if (requiresApproval) {
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

  if (isBrowserToolName(toolName)) {
    return {
      modelResult: await executeBrowserTool(browserRuntime, toolName, input),
    };
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
        beforeMissing: created,
        afterMissing: false,
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
        beforeMissing: created,
        afterMissing: false,
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
        beforeMissing: false,
        afterMissing: false,
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
      sandboxStatus,
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
    complete: ({ body, signal, onStreamEvent }) =>
      callModelProvider({
        provider: config,
        body,
        signal,
        onEvent:
          typeof onStreamEvent === "function"
            ? onStreamEvent
            : onEvent,
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
    (change) =>
      Boolean(change.beforeMissing) !==
        Boolean(change.afterMissing) ||
      change.beforeContent !== change.afterContent,
  );
}

function reviewableChanges(changeMap) {
  return buildChanges(changeMap).filter(
    (change) =>
      (!change.binary || isOfficePath(change.path)),
  );
}

function createChangeVersionSignature(changes) {
  const digest = createHash("sha256");
  for (const change of [...changes].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    digest.update(change.path);
    digest.update("\0");
    digest.update(String(change.afterContent ?? ""));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function parseProgressiveReviewReport(summary, kind) {
  const source = String(summary || "").trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || source.slice(
    Math.max(0, source.indexOf("{")),
    source.lastIndexOf("}") + 1,
  );
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return {
      verdict: "uncertain",
      checks: [],
      findings: [],
      commands: [],
      remainingRisks: ["子 Agent 未返回可解析的结构化自检报告。"],
      parseError: true,
    };
  }
  const allowedVerdicts = kind === "verify"
    ? new Set(["pass", "fail", "not_run", "uncertain"])
    : new Set(["pass", "needs_changes", "uncertain"]);
  const verdict = allowedVerdicts.has(parsed?.verdict)
    ? parsed.verdict
    : "uncertain";
  return {
    verdict,
    checks: Array.isArray(parsed?.checks)
      ? parsed.checks.map(String).filter(Boolean).slice(0, 20)
      : [],
    findings: Array.isArray(parsed?.findings)
      ? parsed.findings
          .map((finding) => ({
            severity: String(finding?.severity || "medium").toLowerCase(),
            path: String(finding?.path || ""),
            message: String(finding?.message || "").trim(),
          }))
          .filter((finding) => finding.message)
          .slice(0, 20)
      : [],
    commands: Array.isArray(parsed?.commands)
      ? parsed.commands
          .map((command) => ({
            command: String(command?.command || ""),
            cwd: String(command?.cwd || "."),
            exitCode: Number.isInteger(command?.exit_code)
              ? command.exit_code
              : null,
            passed: command?.passed === true,
          }))
          .filter((command) => command.command)
          .slice(0, 8)
      : [],
    remainingRisks: Array.isArray(parsed?.remaining_risks)
      ? parsed.remaining_risks.map(String).filter(Boolean).slice(0, 20)
      : [],
    parseError: verdict === "uncertain",
  };
}

function createProgressiveReviewTask(changes, reason, language) {
  const paths = changes.map((change) => change.path);
  const fileList = changes
    .map(
      (change) =>
        `- ${change.path}${change.afterMissing ? " (deleted)" : ""}`,
    )
    .join("\n");
  const outputSchema = [
    "Return only one JSON object with this exact shape:",
    '{"verdict":"pass|needs_changes|uncertain","checks":["..."],"findings":[{"severity":"critical|high|medium|low","path":"...","message":"..."}],"remaining_risks":["..."]}',
  ].join("\n");
  if (language === "en") {
    return [
      `Perform an automated staged review (${reason}).`,
      "Read every delegated file after its latest write. Use inspect_office_file for Office artifacts.",
      "For a deleted path, confirm the deletion with read_file and inspect git_diff when available.",
      "Review correctness, completeness, security, regressions, maintainability, and obvious edge cases.",
      "Do not edit files. A pass verdict means there are no unresolved critical, high, or medium findings.",
      fileList,
      outputSchema,
    ].join("\n");
  }
  return [
    `执行自动分段自检（${reason}）。`,
    "逐一读取下列文件的最新版本；Office 文件必须使用 inspect_office_file。",
    "对于已删除路径，使用 read_file 确认其不存在，并在可用时检查 git_diff。",
    "检查正确性、完整性、安全性、回归风险、可维护性和明显边界条件。",
    "禁止修改文件。只有不存在尚未解决的严重、高级或中级问题时才能返回 pass。",
    fileList,
    outputSchema,
  ].join("\n");
}

function createProgressiveVerifyTask(candidates, reason, language) {
  const candidateList = candidates
    .map((candidate) => `- ${candidate.command} (cwd: ${candidate.cwd})`)
    .join("\n");
  const outputSchema = [
    "Return only one JSON object with this exact shape:",
    '{"verdict":"pass|fail|not_run|uncertain","commands":[{"command":"...","cwd":".","exit_code":0,"passed":true}],"checks":["..."],"remaining_risks":["..."]}',
  ].join("\n");
  if (language === "en") {
    return [
      `Perform staged verification (${reason}).`,
      "Run the single most relevant command below. Do not edit source files. Report the exact observed exit code.",
      candidateList,
      outputSchema,
    ].join("\n");
  }
  return [
    `执行分段验证（${reason}）。`,
    "从下列候选中运行一条最相关的命令。禁止修改源文件，并如实记录命令和退出码。",
    candidateList,
    outputSchema,
  ].join("\n");
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
      mode: selfCheck.mode || "progressive",
      segments: [],
      seal: selfCheck.seal || null,
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
    mode: selfCheck.mode || "legacy",
    segments: (selfCheck.segments || []).map((segment) => ({
      id: segment.id,
      reason: segment.reason,
      planStepId: segment.planStepId || null,
      paths: segment.paths,
      status: segment.status,
      verdict: segment.verdict,
      startedAt: segment.startedAt,
      completedAt: segment.completedAt || null,
      reviewAgentId: segment.reviewAgentId || null,
      reviewAgentIds: segment.reviewAgentIds || [],
      verifyAgentId: segment.verifyAgentId || null,
      findings: segment.findings || [],
      checks: segment.checks || [],
      remainingRisks: segment.remainingRisks || [],
    })),
    seal: selfCheck.seal || null,
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

function createSelfCheckPrompt(
  changeMap,
  verificationCandidates,
  language = "zh-CN",
) {
  const changes = buildChanges(changeMap);
  const reviewableChanges = changes.filter(
    (change) =>
      !change.afterMissing &&
      (!change.binary || isOfficePath(change.path)),
  );
  const changedPaths = reviewableChanges.map(
    (change) => change.path,
  );
  const includesOfficeArtifacts = changes.some(
    (change) =>
      !change.afterMissing &&
      change.binary &&
      isOfficePath(change.path),
  );
  if (language === "en") {
    return [
      "Begin the mandatory self-check phase. A final answer will not be accepted yet.",
      "Use read_file to re-read every file changed in this turn, then check correctness, completeness, security, performance, and obvious edge cases:",
      ...changedPaths.map((path) => `- ${path}`),
      includesOfficeArtifacts
        ? "For every changed .docx, .pptx, or .xlsx file, use inspect_office_file instead of read_file. Confirm that the package is valid and that its document blocks, slides, sheets, rows, and formulas match the request. If an Office artifact is wrong, regenerate it with its create_* tool rather than write_file. Structural inspection does not prove the final visual layout, so record the missing visual render check in remaining_risks."
        : "",
      "Fix problems immediately with write_file or apply_patch. Re-read every file after its latest write.",
      verificationCandidates.length
        ? [
            "Harness found the following project verification commands. Use run_command to attempt at least one relevant check; command execution still requires user approval:",
            ...verificationCandidates.map(
              (candidate) =>
                `- ${candidate.command} (directory: ${candidate.cwd})`,
            ),
          ].join("\n")
        : "No test, typecheck, lint, or build script was found in package.json. Perform a static review and record the missing runtime verification as a remaining risk.",
      "After all checks, call complete_self_check with concrete checks, improvements, and remaining risks. Do not provide the final answer before calling it.",
    ]
      .filter(Boolean)
      .join("\n");
  }
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

function formatToolStepDetail(
  toolName,
  modelResult,
  language = "zh-CN",
) {
  if (modelResult?.reason) return modelResult.reason;
  const error = String(modelResult?.error || "");
  if (!error) return null;
  if (/Invalid arguments/i.test(error)) {
    return language === "en"
      ? "Invalid tool arguments; the agent will regenerate them"
      : "工具参数格式无效，Agent 将重新生成参数";
  }
  if (/Mandatory self-check has not started yet/i.test(error)) {
    return language === "en"
      ? "Harness started the mandatory self-check and will continue reviewing this turn"
      : "Harness 已自动进入强制自检，继续复核本轮修改";
  }
  if (/Re-read these changed files/i.test(error)) {
    return error.replace(
      /^Re-read these changed files after their latest write before completing self-check:\s*/i,
      language === "en" ? "Still needs re-reading: " : "仍需重新读取：",
    );
  }
  if (/Run at least one detected project verification command/i.test(error)) {
    return language === "en"
      ? "At least one detected project verification command still needs to run"
      : "仍需运行一项已检测到的项目验证命令";
  }
  return error;
}

const SUBAGENT_ROLE_CONFIG = Object.freeze({
  explore: {
    description:
      "Search and understand the codebase. Return concise findings with exact file and line evidence. Do not edit files.",
    tools: new Set([
      "list_directory",
      "read_file",
      "search_text",
      "git_status",
      "git_diff",
      "inspect_office_file",
    ]),
  },
  review: {
    description:
      "Review existing code or artifacts for correctness, security, completeness, maintainability, and regressions. Report actionable findings with evidence. Do not edit files.",
    tools: new Set([
      "list_directory",
      "read_file",
      "search_text",
      "git_status",
      "git_diff",
      "inspect_office_file",
    ]),
  },
  verify: {
    description:
      "Verify a focused claim using repository inspection and relevant project commands. Do not edit source files. Report the exact command, exit code, evidence, and remaining uncertainty.",
    tools: new Set([
      "list_directory",
      "read_file",
      "search_text",
      "git_status",
      "git_diff",
      "inspect_office_file",
      "run_command",
    ]),
  },
  curator: {
    description:
      "Extract durable, reusable project understanding from verified task changes. Read the supporting files and return only the requested JSON proposal. Do not edit files or invent unsupported facts.",
    tools: new Set([
      "list_directory",
      "read_file",
      "search_text",
      "git_status",
      "git_diff",
      "inspect_office_file",
    ]),
  },
});

const PARALLEL_MAIN_TOOLS = new Set([
  "list_directory",
  "read_file",
  "search_text",
  "git_status",
  "git_diff",
  "inspect_office_file",
  "delegate_subagent",
]);

const MUTATING_TOOLS = new Set([
  "write_file",
  "apply_patch",
  "run_command",
  ...OFFICE_CREATE_TOOL_NAMES,
]);

function normalizeWorkspaceScope(values) {
  const input = Array.isArray(values) && values.length ? values : ["."];
  const normalized = [];
  for (const item of input.slice(0, 12)) {
    const value = String(item || ".")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/{2,}/g, "/")
      .replace(/\/$/, "") || ".";
    if (
      value.startsWith("/") ||
      /^[a-zA-Z]:\//.test(value) ||
      value.split("/").includes("..") ||
      value.includes("\0")
    ) {
      throw new Error("Subagent scope must stay inside the workspace.");
    }
    if (!normalized.includes(value)) normalized.push(value);
  }
  return normalized.length ? normalized : ["."];
}

function normalizeSubagentInput(input) {
  const role = String(input?.role || "").trim();
  if (!SUBAGENT_ROLE_CONFIG[role]) {
    throw new Error("Subagent role must be explore, review, verify, or curator.");
  }
  const task = String(input?.task || "").trim();
  if (!task || task.length > MAX_SUBAGENT_TASK_CHARS) {
    throw new Error(
      `Subagent task must be between 1 and ${MAX_SUBAGENT_TASK_CHARS} characters.`,
    );
  }
  const requestedRounds = Number(input?.max_rounds);
  const maxRounds = Number.isInteger(requestedRounds)
    ? Math.min(MAX_SUBAGENT_ROUNDS, Math.max(2, requestedRounds))
    : DEFAULT_SUBAGENT_ROUNDS;
  return {
    role,
    task,
    scope: normalizeWorkspaceScope(input?.scope),
    background: Boolean(input?.background),
    maxRounds,
  };
}

function normalizeUnderstandingCategory(category) {
  if (category === "debugging") return "known_issue";
  return [
    "architecture",
    "module",
    "command",
    "convention",
    "decision",
    "verification",
    "known_issue",
    "preference",
  ].includes(category)
    ? category
    : "convention";
}

function createUnderstandingCuratorTask({
  request,
  finalAnswer,
  changes,
  currentFacts,
  selfCheck,
  taskSteps,
  candidates,
  language,
}) {
  const changedFiles = changes.map((change) => ({
    path: change.path,
    created: Boolean(change.created),
    deleted: Boolean(change.deleted),
    binary: Boolean(change.binary),
    additions: change.additions || 0,
    deletions: change.deletions || 0,
  }));
  return [
    "Curate the durable Project Understanding produced by this completed AporiaX task.",
    "Inspect the changed files before proposing facts. Preserve only reusable project knowledge: architecture, modules, commands, conventions, decisions, verification facts, known issues, or explicit durable preferences.",
    "Do not store one-off progress, final-answer prose, credentials, secrets, timestamps, or guesses.",
    "Every proposed fact must cite evidence you personally inspected during this subagent run. Prefer exact workspace-relative file paths. A verification command may be cited only when the supplied self-check says it passed.",
    "The parent agent may have staged candidates through remember_project_fact. Re-check each candidate, keep only durable claims, and copy candidateId when accepting or refining it. An explicit user preference or decision may cite type=user evidence when it came from a staged candidate.",
    "Return JSON only, without Markdown fences, using this schema:",
    JSON.stringify({
      summary: "short revision summary",
      changes: [
        {
          operation: "upsert",
          candidateId: "optional staged candidate id",
          factId: "optional existing fact id when refining it",
          category: "architecture|command|convention|decision|module|verification|known_issue|preference",
          content: "durable fact",
          confidence: 0.85,
          evidence: [
            { type: "file|command|test", reference: "src/example.js", detail: "brief support" },
          ],
        },
      ],
    }),
    `Response language: ${language === "en" ? "English" : "Simplified Chinese"}.`,
    `Task request:\n${String(request || "").slice(0, 6_000)}`,
    `Final result summary:\n${String(finalAnswer || "").slice(0, 4_000)}`,
    `Changed files:\n${JSON.stringify(changedFiles)}`,
    `Observed task actions:\n${JSON.stringify(
      (taskSteps || []).slice(-80).map((step) => ({
        tool: step.name,
        success: step.success,
        path: step.path || null,
        command: step.command || null,
        exitCode: step.exitCode,
      })),
    ).slice(0, 12_000)}`,
    `Staged Understanding candidates:\n${JSON.stringify(
      (candidates || []).map((candidate) => ({
        id: candidate.id,
        category: candidate.category,
        content: candidate.content,
        evidence: candidate.evidence,
        source: candidate.source,
      })),
    ).slice(0, 12_000)}`,
    `Self-check evidence:\n${JSON.stringify({
      mode: selfCheck?.mode,
      seal: selfCheck?.seal,
      verificationResults: selfCheck?.verificationResults || [],
    }).slice(0, 8_000)}`,
    `Current Understanding facts (reuse factId when refining):\n${JSON.stringify(
      (currentFacts || []).slice(0, 60).map((fact) => ({
        id: fact.id,
        category: fact.category,
        content: fact.content,
      })),
    ).slice(0, 16_000)}`,
  ].join("\n\n");
}

function parseJsonObject(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function normalizeUnderstandingProposal({
  summary,
  evidence,
  changedPaths,
  passedVerifications,
  candidates,
}) {
  const parsed = parseJsonObject(summary);
  if (!parsed || !Array.isArray(parsed.changes)) {
    throw new Error("Understanding curator did not return a valid JSON proposal.");
  }
  const inspectedPaths = new Set(
    (evidence || [])
      .filter((item) =>
        ["read_file", "git_diff", "inspect_office_file"].includes(item?.tool),
      )
      .map((item) => String(item.path || "").replace(/\\/g, "/"))
      .filter(Boolean),
  );
  const changed = new Set(
    (changedPaths || []).map((path) => String(path).replace(/\\/g, "/")),
  );
  const commands = new Set(
    (passedVerifications || [])
      .filter((item) => item?.passed)
      .map((item) => String(item.command || "").trim())
      .filter(Boolean),
  );
  const stagedCandidates = Array.isArray(candidates) ? candidates : [];
  const candidateById = new Map(
    stagedCandidates.map((candidate) => [candidate.id, candidate]),
  );
  const changes = [];
  for (const raw of parsed.changes.slice(0, 16)) {
    if (raw?.operation === "remove") continue;
    const content = String(raw?.content || "").replace(/\s+/g, " ").trim();
    const category = normalizeUnderstandingCategory(raw?.category);
    const confidence = Number(raw?.confidence);
    if (!content || content.length > 1_600 || !Number.isFinite(confidence) || confidence < 0.65) {
      continue;
    }
    const stagedCandidate =
      candidateById.get(String(raw?.candidateId || "")) ||
      stagedCandidates.find(
        (candidate) =>
          normalizeUnderstandingCategory(candidate.category) === category &&
          String(candidate.content || "").toLowerCase() === content.toLowerCase(),
      );
    const validatedEvidence = [];
    for (const item of (Array.isArray(raw?.evidence) ? raw.evidence : []).slice(0, 12)) {
      const type = ["file", "command", "test", "user"].includes(item?.type)
        ? item.type
        : "file";
      const reference = String(
        item?.reference || item?.path || item?.command || "",
      ).trim();
      if (!reference) continue;
      const normalizedReference = reference.replace(/\\/g, "/");
      const fileVerified =
        inspectedPaths.has(normalizedReference) ||
        [...inspectedPaths].some(
          (path) => path === normalizedReference || path.endsWith(`/${normalizedReference}`),
        );
      const commandVerified = commands.has(reference);
      const userVerified =
        type === "user" &&
        stagedCandidate &&
        (stagedCandidate.evidence || []).some(
          (candidateEvidence) => candidateEvidence.type === "user",
        );
      if (type === "file" && !fileVerified) continue;
      if (["command", "test"].includes(type) && !commandVerified) continue;
      if (type === "user" && !userVerified) continue;
      validatedEvidence.push({
        type,
        reference: normalizedReference,
        detail: String(item?.detail || "").replace(/\s+/g, " ").trim().slice(0, 600),
      });
    }
    if (!validatedEvidence.length) {
      const fallbackPath = [...inspectedPaths].find((path) => changed.has(path));
      if (fallbackPath) {
        validatedEvidence.push({
          type: "file",
          reference: fallbackPath,
          detail: "Inspected by the Understanding curator after the task completed.",
        });
      }
    }
    if (!validatedEvidence.length) continue;
    changes.push({
      operation: "upsert",
      factId: raw?.factId ? String(raw.factId) : undefined,
      category,
      content,
      confidence,
      evidence: validatedEvidence,
    });
  }
  return {
    summary: String(parsed.summary || "Updated Project Understanding")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1_200),
    changes,
  };
}

function subagentToolPaths(toolName, input) {
  if (toolName === "run_command") return [input.cwd || "."];
  if (toolName === "git_diff") return input.path ? [input.path] : ["."];
  if ([
    "list_directory",
    "read_file",
    "search_text",
    "inspect_office_file",
  ].includes(toolName)) {
    return [input.path || "."];
  }
  return ["."];
}

function requestedPathsForToolCall(toolCall) {
  const toolName = toolCall?.function?.name || "";
  let input;
  try {
    input = parseToolArguments(toolCall);
  } catch {
    return [];
  }
  if (toolName === "delegate_subagent") {
    try {
      return normalizeWorkspaceScope(input.scope);
    } catch {
      return [];
    }
  }
  if (typeof input.path === "string") return [input.path];
  if (toolName === "run_command") return [input.cwd || "."];
  return [];
}

function pathIsInsideScope(path, scope) {
  const normalized = String(path || ".")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "") || ".";
  return scope.some(
    (allowed) =>
      allowed === "." ||
      normalized === allowed ||
      normalized.startsWith(`${allowed}/`),
  );
}

function assertSubagentScope(toolName, input, scope) {
  if (toolName === "run_command" && !scope.includes(".")) {
    throw new Error(
      "run_command requires repository-wide scope (\".\") because an arbitrary command cannot be reliably confined to a narrower path scope.",
    );
  }
  if (
    (toolName === "git_status" && scope.includes(".")) ||
    (toolName === "git_diff" && !input.path && scope.includes("."))
  ) {
    return;
  }
  if (toolName === "git_status") {
    throw new Error(
      "git_status requires repository-wide scope (\".\") because it exposes the whole workspace.",
    );
  }
  for (const path of subagentToolPaths(toolName, input)) {
    if (!pathIsInsideScope(path, scope)) {
      throw new Error(
        `Subagent path is outside its delegated scope: ${path}`,
      );
    }
  }
}

function createSubagentPermissionPolicy(parentPolicy, role) {
  const allowed = SUBAGENT_ROLE_CONFIG[role].tools;
  const policy = { "*": "deny" };
  for (const toolName of allowed) {
    policy[toolName] = getToolPermission(parentPolicy, toolName);
  }
  return Object.freeze(policy);
}

function compactSubagentModelResult(modelResult) {
  const result = modelResult && typeof modelResult === "object"
    ? { ...modelResult }
    : { value: modelResult };
  if (typeof result.content === "string" && result.content.length > 16_000) {
    result.content = `${result.content.slice(0, 16_000)}\n[truncated]`;
    result.truncated = true;
  }
  if (typeof result.diff === "string" && result.diff.length > 16_000) {
    result.diff = `${result.diff.slice(0, 16_000)}\n[truncated]`;
    result.truncated = true;
  }
  if (typeof result.stdout === "string" && result.stdout.length > 12_000) {
    result.stdout = `${result.stdout.slice(0, 12_000)}\n[truncated]`;
    result.truncated = true;
  }
  if (typeof result.stderr === "string" && result.stderr.length > 8_000) {
    result.stderr = `${result.stderr.slice(0, 8_000)}\n[truncated]`;
    result.truncated = true;
  }
  return result;
}

function subagentEvidence(toolName, result) {
  const value = compactSubagentModelResult(result);
  return {
    tool: toolName,
    path: value.path || null,
    command: value.command || null,
    cwd: value.cwd || null,
    query: value.query || null,
    exitCode:
      typeof value.exitCode === "number" ? value.exitCode : null,
    error: value.error ? String(value.error).slice(0, 500) : null,
    preview: String(
      value.content ||
        value.diff ||
        value.stdout ||
        value.reason ||
        "",
    )
      .replace(/\s+/g, " ")
      .slice(0, 1_200),
  };
}

function compactSubagentEvidence(items) {
  const output = [];
  let characters = 0;
  for (const item of (items || []).slice(-40).reverse()) {
    const compact = {
      ...item,
      preview: String(item?.preview || "").slice(0, 800),
    };
    const size = JSON.stringify(compact).length;
    if (output.length && characters + size > MAX_SUBAGENT_EVIDENCE_CHARS) {
      break;
    }
    output.unshift(compact);
    characters += size;
  }
  return output;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

function subagentToolsAreParallel(toolCalls) {
  return (
    toolCalls.length > 1 &&
    toolCalls.every((call) =>
      [
        "list_directory",
        "read_file",
        "search_text",
        "git_status",
        "git_diff",
        "inspect_office_file",
      ].includes(call?.function?.name),
    )
  );
}

async function runSubagentTask({
  agentId,
  input,
  provider,
  modelId,
  modelConfig,
  thinking,
  effort,
  workspaceRoot,
  parentPermissionPolicy,
  approvalMode,
  requestApproval,
  signal,
  sandboxExecutor,
  sandboxStatus,
  language,
  memoryFacts,
  emit,
}) {
  const roleConfig = SUBAGENT_ROLE_CONFIG[input.role];
  const permissionPolicy = createSubagentPermissionPolicy(
    parentPermissionPolicy,
    input.role,
  );
  const enabledTools = TOOL_REGISTRY
    .definitions(permissionPolicy)
    .filter((definition) => roleConfig.tools.has(definition.function.name));
  const instructionContext = await loadProjectInstructionContext(
    workspaceRoot,
  );
  const contextCheckpoints = [];
  const tokenAccounting = createTokenAccounting();
  tokenAccounting.providerOverheadTokens =
    estimateManagedConversationTokens([
      {
        role: "system",
        content: JSON.stringify(enabledTools),
      },
    ]);
  let usageTotal = null;
  const evidence = [];
  const toolSteps = [];
  const conversation = [
    {
      role: "system",
      content: [
        `You are the AporiaX ${input.role} subagent.`,
        roleConfig.description,
        `Your delegated workspace scope is: ${input.scope.join(", ")}.`,
        "Work independently and return a concise evidence-backed report to the parent agent.",
        "Use workspace-relative paths. Do not claim anything you did not verify with tools.",
        "Do not expose hidden reasoning. Report conclusions, evidence, commands, and uncertainty only.",
        instructionContext.root.content
          ? `Project instructions:\n${instructionContext.root.content}`
          : "",
        memoryFacts?.length
          ? `Relevant project memory:\n${JSON.stringify(memoryFacts.slice(0, 10))}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    { role: "user", content: input.task },
  ];
  const contextWindowTokens = Math.max(
    32_000,
    Number(modelConfig.contextWindow || DEFAULT_CONTEXT_WINDOW_TOKENS),
  );

  emit({
    type: "subagent.started",
    agentId,
    role: input.role,
    task: input.task,
    scope: input.scope,
    background: input.background,
  });

  try {
    for (let round = 1; round <= input.maxRounds; round += 1) {
      throwIfAborted(signal);
      const relevant = upsertRelevantContextMessage(conversation, {
        checkpoints: contextCheckpoints,
        memoryFacts,
      });
      compactManagedConversation({
        conversation,
        onEvent: (event) =>
          emit({ ...event, type: "subagent.context.compacted", agentId }),
        contextCheckpoints,
        contextWindowTokens,
        accounting: tokenAccounting,
        relevantMemory: relevant,
      });
      const requestConversation = conversation;
      const { message, usage } = await provider.complete({
        signal,
        onStreamEvent: () => undefined,
        body: {
          model: modelId,
          messages: requestConversation,
          ...(provider.supportsTools && enabledTools.length
            ? { tools: enabledTools, tool_choice: "auto" }
            : {}),
          ...(provider.supportsThinking &&
          provider.thinkingMode === "deepseek"
            ? {
                thinking: { type: thinking ? "enabled" : "disabled" },
                reasoning_effort: effort === "max" ? "max" : "high",
              }
            : {}),
          ...(provider.supportsThinking &&
          provider.thinkingMode === "reasoning-effort" &&
          thinking
            ? { reasoning_effort: effort === "max" ? "high" : "medium" }
            : {}),
        },
      });
      recordProviderUsage(tokenAccounting, usage, requestConversation);
      usageTotal = mergeTokenUsage(usageTotal, usage);
      if (!Array.isArray(message.tool_calls) || !message.tool_calls.length) {
        const summary = String(message.content || "")
          .trim()
          .slice(0, MAX_SUBAGENT_RESULT_CHARS);
        const result = {
          agentId,
          role: input.role,
          status: "completed",
          summary:
            summary ||
            (language === "en"
              ? "The subagent completed without a textual report."
              : "子 Agent 已完成，但没有返回文本报告。"),
          evidence: compactSubagentEvidence(evidence),
          steps: toolSteps.slice(-60),
          usage: usageTotal,
          rounds: round,
          instructionFiles: [...instructionContext.loadedFiles],
        };
        emit({
          type: "subagent.completed",
          agentId,
          role: input.role,
          status: result.status,
          rounds: round,
          toolSteps: toolSteps.length,
          summary: result.summary.slice(0, 500),
        });
        return result;
      }

      conversation.push({
        role: "assistant",
        content: message.content ?? null,
        tool_calls: message.tool_calls,
      });
      const parallelBatch = subagentToolsAreParallel(message.tool_calls);
      const executeCall = async (toolCall) => {
        const toolName = toolCall.function.name;
        let modelResult;
        let success = true;
        emit({
          type: "subagent.tool.started",
          agentId,
          callId: toolCall.id,
          role: input.role,
          tool: toolName,
          parallel: parallelBatch,
          ...describeToolActivity(toolCall),
        });
        try {
          if (!roleConfig.tools.has(toolName)) {
            throw new Error(`Tool is not available to ${input.role}: ${toolName}`);
          }
          const parsedInput = parseToolArguments(toolCall);
          assertSubagentScope(toolName, parsedInput, input.scope);
          const scoped = await resolveScopedInstructions(
            instructionContext,
            subagentToolPaths(toolName, parsedInput),
          );
          if (scoped.content) {
            conversation.splice(1, 0, {
              role: "system",
              content: `Scoped project instructions for this subagent:\n${scoped.content}`,
            });
            emit({
              type: "subagent.instructions.loaded",
              agentId,
              files: scoped.files,
            });
            if (toolName === "run_command") {
              throw new Error(
                `Scoped project instructions were loaded from ${scoped.files.join(", ")}. Review them, then retry the verification command if it remains appropriate.`,
              );
            }
          }
          const executed = await executeTool({
            toolCall,
            workspaceRoot,
            permissionPolicy,
            approvalMode,
            requestApproval,
            signal,
            sandboxExecutor,
            sandboxStatus,
          });
          modelResult = compactSubagentModelResult(executed.modelResult);
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          success = false;
          modelResult = { error: error.message };
        }
        const item = subagentEvidence(toolName, modelResult);
        evidence.push(item);
        toolSteps.push({
          name: toolName,
          success,
          path: item.path,
          command: item.command,
          exitCode: item.exitCode,
          detail: item.error || null,
        });
        emit({
          type: "subagent.tool.completed",
          agentId,
          callId: toolCall.id,
          role: input.role,
          tool: toolName,
          parallel: parallelBatch,
          success,
          path: item.path,
          command: item.command,
          exitCode: item.exitCode,
          detail: item.error || item.preview,
        });
        return { toolCall, modelResult };
      };
      const results = parallelBatch
        ? await mapWithConcurrency(
            message.tool_calls,
            MAX_PARALLEL_TOOL_CALLS,
            executeCall,
          )
        : await mapWithConcurrency(message.tool_calls, 1, executeCall);
      for (const { toolCall, modelResult } of results) {
        conversation.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(modelResult),
        });
      }
    }

    const result = {
      agentId,
      role: input.role,
      status: "budget_exhausted",
      summary:
        language === "en"
          ? `The subagent reached its ${input.maxRounds}-round safety budget. Use its evidence as partial results or delegate a narrower follow-up.`
          : `子 Agent 已达到 ${input.maxRounds} 轮安全预算。请把现有证据视为部分结果，或委派一个范围更小的后续任务。`,
      evidence: compactSubagentEvidence(evidence),
      steps: toolSteps.slice(-60),
      usage: usageTotal,
      rounds: input.maxRounds,
      instructionFiles: [...instructionContext.loadedFiles],
    };
    emit({
      type: "subagent.completed",
      agentId,
      role: input.role,
      status: result.status,
      rounds: result.rounds,
      toolSteps: toolSteps.length,
      summary: result.summary,
    });
    return result;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const result = {
      agentId,
      role: input.role,
      status: "failed",
      summary: error.message,
      evidence: compactSubagentEvidence(evidence),
      steps: toolSteps.slice(-60),
      usage: usageTotal,
    };
    emit({
      type: "subagent.failed",
      agentId,
      role: input.role,
      error: error.message,
    });
    return result;
  }
}

function mainToolBatchCanRunInParallel(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length < 2) return false;
  return toolCalls.every((toolCall) => {
    if (!PARALLEL_MAIN_TOOLS.has(toolCall?.function?.name)) return false;
    if (toolCall.function.name !== "delegate_subagent") return true;
    try {
      const input = normalizeSubagentInput(parseToolArguments(toolCall));
      return input.role !== "verify" || input.background;
    } catch {
      return false;
    }
  });
}

export async function runHarness({
  runId = "",
  taskId = "",
  provider: providerConfig,
  workspacePath,
  modelId,
  thinking,
  effort,
  permission,
  approvalMode = "manual",
  language = "zh-CN",
  messages,
  signal,
  onEvent,
  control = null,
  requestApproval = async () => ({ approved: false }),
  sandboxExecutor = runCommandWithFallback,
  sandboxStatusResolver = getSandboxStatus,
  memoryDirectory = null,
  understandingDirectory = null,
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
  const forwardEvent = createEventEmitter(onEvent);
  let witness = null;
  const emit = (event) => {
    forwardEvent(event);
    witness?.observe(event);
  };
  const isEnglish = language === "en";
  const responseLanguage =
    isEnglish ? "English" : "Simplified Chinese";
  const modelConfig = providerConfig.models.find(
    (candidate) => candidate.id === modelId,
  );
  if (!modelConfig) {
    throw new Error(
      isEnglish
        ? `Model ${modelId || "unknown"} does not belong to provider ${providerConfig.name}.`
        : `模型 ${modelId || "unknown"} 不属于 Provider ${providerConfig.name}。`,
    );
  }
  const provider = createOpenAICompatibleProvider({
    config: providerConfig,
    model: modelConfig,
    onEvent: emit,
  });
  const contextWindowTokens = Math.max(
    32_000,
    Number(modelConfig.contextWindow || DEFAULT_CONTEXT_WINDOW_TOKENS),
  );

  const hasWorkspace =
    typeof workspacePath === "string" && Boolean(workspacePath.trim());
  const workspaceRoot = hasWorkspace
    ? await getVerifiedWorkspaceRoot(workspacePath)
    : null;
  const instructionContext = await loadProjectInstructionContext(
    workspaceRoot,
  );
  const projectInstructions = instructionContext.root;
  const projectConfig = await loadProjectConfig(workspaceRoot);
  const initialMemoryQuery = (messages || [])
    .slice(-8)
    .map((message) => String(message?.content || ""))
    .filter(Boolean)
    .join("\n")
    .slice(-24_000);
  const projectMemory = await createProjectMemoryStore({
    baseDirectory: memoryDirectory,
    workspaceRoot,
  });
  const projectUnderstanding = await createProjectUnderstandingStore({
    baseDirectory: understandingDirectory,
    workspaceRoot,
  });
  let legacyUnderstandingImport = null;
  if (
    understandingDirectory &&
    workspaceRoot &&
    projectUnderstanding.snapshot().facts.length === 0 &&
    projectMemory.facts.length > 0
  ) {
    legacyUnderstandingImport = await projectUnderstanding
      .commit({
        taskId: "legacy-project-memory",
        runId,
        source: "legacy-memory-import",
        summary: `Imported ${projectMemory.facts.length} legacy Project Memory facts without modifying the legacy store`,
        changes: projectMemory.facts.map((fact) => ({
          operation: "upsert",
          category: normalizeUnderstandingCategory(fact.category),
          content: fact.content,
          confidence: Math.min(
            0.78,
            0.62 + Math.log2((fact.occurrences || 1) + 1) * 0.025,
          ),
          evidence: [
            {
              type: "note",
              reference: fact.evidence || "Legacy Project Memory",
              detail:
                "Compatibility import. Reconfirm against current project evidence when reused.",
            },
          ],
        })),
      })
      .catch(() => null);
  }
  const initialMemoryFacts = projectUnderstanding.snapshot().facts.length
    ? []
    : projectMemory.retrieve(initialMemoryQuery, 10);
  const initialUnderstandingFacts = projectUnderstanding.retrieve(
    initialMemoryQuery,
    14,
  );
  const effectiveApprovalMode =
    approvalMode === "sandbox-auto" ? "sandbox-auto" : "manual";
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
  const commandToolAvailable = canRunCommands;
  const commandUsesContainer = Boolean(sandboxStatus?.available);
  const commandUsesLocalSandbox =
    commandToolAvailable &&
    !commandUsesContainer &&
    Boolean(
      sandboxStatus?.localAvailable ||
        sandboxStatus?.autoApprovalSafe,
    );
  const toolCatalog = hasWorkspace
    ? TOOL_REGISTRY.catalog(permissionPolicy).map((tool) =>
        tool.name === "run_command" &&
        commandToolAvailable &&
        effectiveApprovalMode === "sandbox-auto" &&
        (commandUsesContainer || commandUsesLocalSandbox)
          ? {
              ...tool,
              permission: "allow",
              executionMode: commandUsesContainer
                ? "container-auto-approval"
                : "local-workspace-auto-approval",
              warning:
                commandUsesContainer
                  ? "Commands run automatically inside the isolated Docker sandbox."
                  : "Commands run automatically in a temporary workspace copy. Docker is optional for stronger OS isolation.",
            }
          : tool.name === "run_command" &&
              commandToolAvailable &&
              !commandUsesContainer &&
              !commandUsesLocalSandbox
            ? {
                ...tool,
                permission: "ask",
                executionMode: "host-approval",
                warning:
                  "No sandbox backend is available. Host execution requires explicit approval.",
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
  const browserRuntime = createBrowserRuntime();
  witness = createWitnessMonitor({ emit: forwardEvent });
  emit({
    type: "turn.started",
    provider: provider.id,
    providerName: provider.name,
    model: modelId,
    workspace: hasWorkspace,
    permissionMode: permission,
    approvalMode: effectiveApprovalMode,
    permissionConfigFile: projectConfig.file,
    tools: toolCatalog,
    sandbox: sandboxStatus,
  });
  if (legacyUnderstandingImport?.committed) {
    emit({
      type: "understanding.updated",
      source: "legacy-memory-import",
      revision: legacyUnderstandingImport.revision.number,
      revisionId: legacyUnderstandingImport.revision.id,
      summary: legacyUnderstandingImport.revision.summary,
      factCount: legacyUnderstandingImport.state.facts.length,
      changes: legacyUnderstandingImport.revision.changeCount,
    });
  }
  const conversation = [
    {
      role: "system",
      content: [
        "You are AporiaX, a local coding and productivity agent.",
        `Reply to the user in ${responseLanguage}. Keep file paths, command names, source code, API identifiers, and user-provided proper nouns unchanged.`,
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
        "Use browser_open and browser_snapshot when the task requires checking a running web page. Prefer semantic browser locators. Treat browser_click, browser_fill, and browser_press as potentially state-changing actions and never claim a page was verified without observing the resulting snapshot, console, or network evidence.",
        "For work that needs more than one meaningful action, call update_plan before changing files. Keep one step in_progress at a time and update the plan whenever the route changes.",
        "Delegate independent codebase exploration, review, and verification to delegate_subagent. Give each subagent a focused task and path scope. Issue multiple delegate_subagent calls in one response when they do not depend on each other; AporiaX can run them concurrently.",
        "Use background subagents for long verification while continuing independent work. Collect their results before relying on them or delivering the final answer.",
        "Subagents are read-only by design. The parent agent remains responsible for every file edit and for fixing review findings. Harness automatically delegates version-matched staged review and verification, then performs a lightweight final evidence seal. A full parent self-check is used only as a safety fallback.",
        "Project Understanding is the shared, versioned context for every task in this workspace. Relevant facts are injected automatically at the start of a task.",
        "When you discover a reusable, non-secret project fact such as a build command, architecture, convention, decision, debugging insight, or explicit user preference, call remember_project_fact to stage a candidate. This does not write immediately: Harness automatically asks the Curator subagent to verify the candidate and creates an Understanding revision only when evidence is sufficient. Never claim a candidate was committed before Harness confirms it. Never submit credentials, tokens, or one-off task content.",
        "Use create_word_document, create_presentation, and create_spreadsheet for real Office files. Do not try to write Office binaries with write_file.",
        "Create one Office artifact per tool call and follow its JSON schema exactly. For Word, blocks must be an array of heading, paragraph, bullets, table, or page_break objects.",
        "After creating or replacing an Office file, use inspect_office_file during mandatory self-check. Treat structural inspection as distinct from final visual rendering.",
        commandUsesContainer
          ? "Use run_command only when a command materially verifies the result. Commands run in a network-disabled OS-level container sandbox with a read-only root filesystem and only the current workspace mounted writable."
          : commandUsesLocalSandbox
            ? "Use run_command only when it materially verifies the result. Commands run in a temporary copy of the authorized workspace and changes are conflict-checked before being synchronized back. This local sandbox uses the host network and process permissions; never claim OS-level or network isolation. Docker is optional and only adds stronger isolation."
            : commandToolAvailable
              ? "Use run_command only when it materially verifies the result. No sandbox backend is available, so commands require explicit user approval. Keep commands scoped to the authorized workspace and never claim isolation."
            : "Command execution is disabled for this task. Never claim that a build or test was run.",
        "When Harness reports staged review findings, fix them before finishing. If Harness explicitly starts the fallback mandatory self-check, re-read the listed current file versions and call complete_self_check before answering.",
        "The desktop UI already presents changed files, verification, Route history, and deliverables. Do not repeat them as Markdown inventory tables or tool-call logs in the final answer.",
        !hasWorkspace
          ? "No workspace is attached. Answer without file tools and ask the user to attach a workspace when file access is required."
          : [
              canWriteWorkspace
                ? "Workspace file changes are available subject to the effective Harness permission policy."
                : "File mutation tools are disabled for this task.",
              commandUsesContainer
                ? effectiveApprovalMode === "sandbox-auto"
                  ? "Commands inside the isolated Docker sandbox are automatically approved."
                  : "Sandboxed commands require explicit approval before execution."
                : commandUsesLocalSandbox
                  ? effectiveApprovalMode === "sandbox-auto"
                    ? "Commands in the local temporary-workspace sandbox are automatically approved without per-command prompts."
                    : "Commands in the local temporary-workspace sandbox require explicit approval."
                : canRunCommands
                  ? `The command tool uses mandatory host approval because no sandbox backend is available: ${sandboxStatus?.detail || "unknown reason"}`
                  : "The command tool is disabled for this task.",
            ].join(" "),
        "Keep the final answer concise. State the outcome, important limitations, and any user action still required.",
        projectInstructions.content
          ? `Follow these project instructions:\n${projectInstructions.content}`
          : "",
        initialMemoryFacts.length
          ? `Relevant durable project memory from earlier tasks:\n${JSON.stringify(initialMemoryFacts)}`
          : "",
        initialUnderstandingFacts.length
          ? `Shared Project Understanding from other tasks in this workspace. Treat it as versioned context, verify it against current files before relying on details that may have changed:\n${JSON.stringify(initialUnderstandingFacts)}`
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
  const understandingCandidates = [];
  const changeMap = new Map();
  const contextCheckpoints = [];
  const tokenAccounting = createTokenAccounting();
  tokenAccounting.providerOverheadTokens =
    estimateManagedConversationTokens([
      {
        role: "system",
        content: JSON.stringify(enabledToolDefinitions),
      },
    ]);
  const subagents = new Map();
  const subagentController = new AbortController();
  const abortSubagents = () => subagentController.abort();
  signal?.addEventListener("abort", abortSubagents, { once: true });
  let subagentCounter = 0;
  let plan = null;
  const anchorStartedAt = new Date().toISOString();
  let anchorBaseline = null;
  let anchorLatest = null;
  let anchorCaptureError = "";
  const selfCheck = {
    started: false,
    completed: false,
    mode: "progressive",
    reviewedVersions: new Map(),
    report: null,
    segments: [],
    seal: null,
    segmentCounter: 0,
    lastBlockedSignature: "",
    repeatedBlockedAttempts: 0,
    legacyFallback: false,
    verificationCandidates: [],
    verificationAttempted: false,
    verificationPassed: false,
    verificationResults: [],
  };
  let progressiveReviewJob = null;
  let totalUsage = null;

  const applyRuntimeControlBoundary = async () => {
    await control?.waitIfPaused?.(signal);
    const steeringMessages = control?.consumeSteering?.() || [];
    if (!steeringMessages.length) return;
    const sanitizedSteering = sanitizeConversation(steeringMessages, {
      supportsImages: provider.supportsImages,
    });
    if (!sanitizedSteering.length) return;
    conversation.push(...sanitizedSteering);
    emit({
      type: "steering.applied",
      messageIds: steeringMessages.map((message) => message.id),
      count: steeringMessages.length,
    });
  };

  const loadScopedContextForToolCalls = async (toolCalls) => {
    const retryAfterInstructions = new Set();
    for (const toolCall of toolCalls || []) {
      const paths = requestedPathsForToolCall(toolCall);
      if (!paths.length) continue;
      const scoped = await resolveScopedInstructions(
        instructionContext,
        paths,
      );
      if (!scoped.content) continue;
      let insertAt = 0;
      while (conversation[insertAt]?.role === "system") insertAt += 1;
      conversation.splice(insertAt, 0, {
        role: "system",
        content: `Scoped project instructions loaded for ${paths.join(", ")}:\n${scoped.content}`,
      });
      emit({
        type: "instructions.loaded",
        files: scoped.files,
        paths,
      });
      if (MUTATING_TOOLS.has(toolCall.function.name)) {
        retryAfterInstructions.add(toolCall.id);
      }
    }
    return retryAfterInstructions;
  };

  const stageUnderstandingCandidate = (
    rawInput,
    { source = "parent-agent", evidenceType = null } = {},
  ) => {
    const category = normalizeUnderstandingCategory(rawInput?.category);
    const rawEvidence = String(rawInput?.evidence || "").trim();
    const inferredEvidenceType =
      evidenceType ||
      (["preference", "decision"].includes(category)
        ? "user"
        : ["command", "verification"].includes(category)
          ? "command"
          : /(?:^|[\\/])[\w.-]+\.[a-z0-9]{1,8}(?::\d+)?$/i.test(rawEvidence)
            ? "file"
            : "note");
    const normalized = normalizeProjectUnderstandingCandidate({
      category,
      content: rawInput?.content,
      confidence: Number(rawInput?.confidence) || 0.78,
      evidence: rawEvidence
        ? [
            {
              type: inferredEvidenceType,
              reference: rawEvidence,
              detail:
                source === "parent-agent"
                  ? "Staged by the parent agent for Curator review."
                  : "Observed by Harness and staged for Curator review.",
            },
          ]
        : inferredEvidenceType === "user"
          ? [
              {
                type: "user",
                reference: "Current user request",
                detail: "Explicit durable preference or decision proposed by the parent agent.",
              },
            ]
          : [],
    });
    const key = `${normalized.category}:${normalized.content.toLowerCase()}`;
    const existing = understandingCandidates.find(
      (candidate) =>
        `${candidate.category}:${candidate.content.toLowerCase()}` === key,
    );
    if (existing) return existing;
    const candidate = {
      id: `candidate-${createHash("sha256")
        .update(`${runId}:${key}`)
        .digest("hex")
        .slice(0, 12)}`,
      ...normalized,
      source,
      stagedAt: new Date().toISOString(),
    };
    understandingCandidates.push(candidate);
    emit({
      type: "understanding.candidate.staged",
      candidate: {
        id: candidate.id,
        category: candidate.category,
        content: candidate.content,
      },
      pending: understandingCandidates.length,
    });
    return candidate;
  };

  const startSubagent = async (rawInput, callId = "") => {
    const input = normalizeSubagentInput(rawInput);
    subagentCounter += 1;
    const agentId = `${runId || "run"}-sub-${subagentCounter}`;
    const relevantMemory = [
      ...projectUnderstanding.retrieve(input.task, 12),
      ...(projectUnderstanding.snapshot().facts.length
        ? []
        : projectMemory.retrieve(input.task, 8)),
    ].slice(0, 18);
    const record = {
      agentId,
      callId,
      role: input.role,
      task: input.task,
      background: input.background,
      status: "running",
      collected: false,
      result: null,
      promise: null,
    };
    record.promise = runSubagentTask({
      agentId,
      input,
      provider,
      modelId,
      modelConfig,
      thinking,
      effort,
      workspaceRoot,
      parentPermissionPolicy: permissionPolicy,
      approvalMode: effectiveApprovalMode,
      requestApproval,
      signal: subagentController.signal,
      sandboxExecutor,
      sandboxStatus,
      language,
      memoryFacts: relevantMemory,
      emit,
    })
      .catch((error) => ({
        agentId,
        role: input.role,
        status:
          error?.name === "AbortError" || subagentController.signal.aborted
            ? "interrupted"
            : "failed",
        summary: error?.message || "Subagent failed.",
        evidence: [],
        steps: [],
        usage: null,
      }))
      .then((result) => {
        record.status = result.status;
        record.result = result;
        totalUsage = mergeTokenUsage(totalUsage, result.usage);
        return result;
      });
    subagents.set(agentId, record);
    if (input.background) {
      emit({
        type: "subagent.backgrounded",
        agentId,
        role: input.role,
        task: input.task,
      });
      return {
        agentId,
        role: input.role,
        status: "running",
        background: true,
        message:
          language === "en"
            ? "The subagent is running in the background. Continue independent work and collect it before final delivery."
            : "子 Agent 正在后台运行。可以继续处理独立工作，但最终交付前需要收集结果。",
      };
    }
    const result = await record.promise;
    record.collected = true;
    return result;
  };

  const curateProjectUnderstanding = async ({ finalAnswer, changes }) => {
    const evidenceSteps = steps.filter(
      (step) =>
        step.success &&
        [
          "read_file",
          "search_text",
          "git_status",
          "git_diff",
          "inspect_office_file",
          "run_command",
        ].includes(step.name),
    );
    if (
      !understandingDirectory ||
      !workspaceRoot ||
      ((!Array.isArray(changes) || changes.length === 0) &&
        evidenceSteps.length === 0 &&
        understandingCandidates.length === 0)
    ) {
      return null;
    }
    emit({
      type: "understanding.curating",
      changedFiles: changes.length,
      candidates: understandingCandidates.length,
    });
    try {
      const currentState = projectUnderstanding.snapshot();
      const request = (messages || [])
        .filter((message) => message?.role === "user")
        .slice(-3)
        .map((message) => String(message?.content || ""))
        .join("\n")
        .slice(-8_000);
      const curatorResult = await startSubagent(
        {
          role: "curator",
          task: createUnderstandingCuratorTask({
            request,
            finalAnswer,
            changes,
            currentFacts: currentState.facts,
            selfCheck,
            taskSteps: evidenceSteps,
            candidates: understandingCandidates,
            language,
          }),
          scope: ["."],
          background: false,
          max_rounds: 7,
        },
        "understanding-curator",
      );
      if (curatorResult?.status !== "completed") {
        throw new Error(
          curatorResult?.summary || "Understanding curator did not complete.",
        );
      }
      const proposal = normalizeUnderstandingProposal({
        summary: curatorResult.summary,
        evidence: curatorResult.evidence,
        changedPaths: changes.map((change) => change.path),
        passedVerifications: selfCheck.verificationResults,
        candidates: understandingCandidates,
      });
      if (!proposal.changes.length) {
        emit({
          type: "understanding.skipped",
          reason: "no-evidence-backed-delta",
        });
        return {
          committed: false,
          currentRevision: currentState.currentRevision,
        };
      }
      const committed = await projectUnderstanding.commit({
        taskId,
        runId,
        summary: proposal.summary,
        changes: proposal.changes,
      });
      if (committed.committed) {
        emit({
          type: "understanding.updated",
          revision: committed.revision.number,
          revisionId: committed.revision.id,
          summary: committed.revision.summary,
          factCount: committed.state.facts.length,
          changes: committed.revision.changes.length,
        });
      }
      return {
        committed: committed.committed,
        currentRevision: committed.state.currentRevision,
        revisionId: committed.revision?.id || null,
        summary: committed.revision?.summary || proposal.summary,
        factCount: committed.state.facts.length,
      };
    } catch (error) {
      emit({
        type: "understanding.failed",
        error: String(error?.message || error).slice(0, 800),
      });
      return {
        committed: false,
        error: String(error?.message || error).slice(0, 800),
      };
    }
  };

  const runProgressiveSelfCheckSegment = async ({
    reason,
    planStepId = null,
    runVerification = false,
  }) => {
    const pendingChanges = reviewableChanges(changeMap).filter(
      (change) =>
        selfCheck.reviewedVersions.get(change.path) !==
        change.afterContent,
    );
    if (
      runVerification &&
      commandToolAvailable &&
      selfCheck.verificationCandidates.length === 0
    ) {
      selfCheck.verificationCandidates =
        await discoverVerificationCommands(workspaceRoot, changeMap);
    }
    const verificationCandidates = runVerification
      ? selfCheck.verificationCandidates.slice(0, 4)
      : [];
    if (!pendingChanges.length && !verificationCandidates.length) {
      return null;
    }

    selfCheck.segmentCounter += 1;
    const segmentId = `segment-${selfCheck.segmentCounter}`;
    const versions = new Map(
      pendingChanges.map((change) => [change.path, change.afterContent]),
    );
    const segment = {
      id: segmentId,
      reason,
      planStepId,
      paths: pendingChanges.map((change) => change.path),
      versions,
      versionSignature: createChangeVersionSignature(pendingChanges),
      status: "running",
      verdict: "uncertain",
      startedAt: new Date().toISOString(),
      completedAt: null,
      reviewAgentId: null,
      reviewAgentIds: [],
      verifyAgentId: null,
      findings: [],
      checks: [],
      remainingRisks: [],
    };
    selfCheck.segments.push(segment);
    emit({
      type: "self_check.segment.started",
      segmentId,
      reason,
      planStepId,
      paths: segment.paths,
      verificationCandidates,
    });

    const reviewGroupCount = Math.min(
      verificationCandidates.length ? 1 : 2,
      pendingChanges.length,
    );
    const reviewGroups = Array.from(
      { length: reviewGroupCount },
      () => [],
    );
    pendingChanges.forEach((change, index) => {
      reviewGroups[index % reviewGroupCount]?.push(change);
    });
    const reviewPromises = reviewGroups.map((changes, index) =>
      startSubagent(
        {
          role: "review",
          task: createProgressiveReviewTask(changes, reason, language),
          scope:
            changes.length <= 12
              ? changes.map((change) => change.path)
              : ["."],
          background: false,
          max_rounds: Math.min(
            6,
            Math.max(3, Math.ceil(changes.length / 6) + 2),
          ),
        },
        `${segmentId}-review-${index + 1}`,
      ),
    );
    const verifyPromise = verificationCandidates.length
      ? startSubagent(
          {
            role: "verify",
            task: createProgressiveVerifyTask(
              verificationCandidates,
              reason,
              language,
            ),
            scope: ["."],
            background: false,
            max_rounds: 4,
          },
          `${segmentId}-verify`,
        )
      : Promise.resolve(null);
    const [reviewResults, verifyResult] = await Promise.all([
      Promise.all(reviewPromises),
      verifyPromise,
    ]);

    const reviewReports = reviewResults.map((result) =>
      parseProgressiveReviewReport(result?.summary, "review"),
    );
    const reviewReport = {
      verdict: reviewReports.every((report) => report.verdict === "pass")
        ? "pass"
        : reviewReports.some((report) => report.verdict === "needs_changes")
          ? "needs_changes"
          : "uncertain",
      checks: reviewReports.flatMap((report) => report.checks || []),
      findings: reviewReports.flatMap((report) => report.findings || []),
      remainingRisks: reviewReports.flatMap(
        (report) => report.remainingRisks || [],
      ),
      parseError: reviewReports.some((report) => report.parseError),
    };
    const reviewEvidence = reviewResults.flatMap(
      (result) => result?.evidence || [],
    );
    const missingReviewEvidence = pendingChanges
      .filter((change) =>
        !reviewEvidence.some((item) => {
          if (item?.path !== change.path) return false;
          if (change.afterMissing) {
            return ["read_file", "git_diff"].includes(item.tool);
          }
          return change.binary
            ? item.tool === "inspect_office_file"
            : item.tool === "read_file";
        }),
      )
      .map((change) => change.path);
    if (
      reviewResults.some((result) => result?.status !== "completed") ||
      missingReviewEvidence.length
    ) {
      reviewReport.verdict = "uncertain";
      reviewReport.parseError = true;
      reviewReport.remainingRisks.push(
        missingReviewEvidence.length
          ? `缺少文件读取证据：${missingReviewEvidence.join(", ")}`
          : "审查子 Agent 未正常完成。",
      );
    }
    if (
      reviewReport.findings.some((finding) =>
        ["critical", "high", "medium"].includes(finding.severity),
      )
    ) {
      reviewReport.verdict = "needs_changes";
    }

    const verifyReport = verificationCandidates.length
      ? parseProgressiveReviewReport(verifyResult?.summary, "verify")
      : {
          verdict: "not_run",
          checks: [],
          commands: [],
          remainingRisks: [],
          parseError: false,
        };
    const observedCommands = (verifyResult?.evidence || [])
      .filter(
        (item) =>
          item?.tool === "run_command" &&
          item.command &&
          findVerificationCandidate(verificationCandidates, {
            command: item.command,
            cwd: item.cwd || ".",
          }),
      )
      .map((item) => ({
        command: item.command,
        cwd: item.cwd || ".",
        passed: item.exitCode === 0,
        exitCode: item.exitCode,
        error: item.error || null,
      }));
    if (verificationCandidates.length) {
      if (verifyResult?.status !== "completed" || !observedCommands.length) {
        verifyReport.verdict = "uncertain";
        verifyReport.parseError = true;
        verifyReport.remainingRisks.push(
          "验证子 Agent 没有留下可核验的命令执行证据。",
        );
      } else {
        verifyReport.commands = observedCommands;
        verifyReport.verdict = observedCommands.some(
          (command) => command.passed,
        )
          ? "pass"
          : "fail";
        selfCheck.verificationAttempted = true;
        selfCheck.verificationPassed =
          selfCheck.verificationPassed ||
          observedCommands.some((command) => command.passed);
        for (const command of observedCommands) {
          selfCheck.verificationResults.push(command);
        }
      }
    }

    if (reviewReport.verdict === "pass") {
      for (const [path, version] of versions) {
        if (changeMap.get(path)?.afterContent === version) {
          selfCheck.reviewedVersions.set(path, version);
        }
      }
    }
    segment.reviewAgentIds = reviewResults
      .map((result) => result?.agentId)
      .filter(Boolean);
    segment.reviewAgentId = segment.reviewAgentIds[0] || null;
    segment.verifyAgentId = verifyResult?.agentId || null;
    segment.findings = reviewReport.findings;
    segment.checks = [
      ...reviewReport.checks,
      ...verifyReport.checks,
    ];
    segment.remainingRisks = [
      ...reviewReport.remainingRisks,
      ...verifyReport.remainingRisks,
      ...(verifyReport.verdict === "fail"
        ? ["项目验证命令未通过，失败证据已保留。"]
        : []),
    ];
    segment.verdict = reviewReport.verdict === "pass" &&
      verifyReport.verdict !== "uncertain"
      ? "pass"
      : reviewReport.verdict;
    segment.status = "completed";
    segment.completedAt = new Date().toISOString();
    emit({
      type: "self_check.segment.completed",
      segmentId,
      reason,
      planStepId,
      verdict: segment.verdict,
      paths: segment.paths,
      findings: segment.findings,
      checks: segment.checks,
      remainingRisks: segment.remainingRisks,
      reviewAgentId: segment.reviewAgentId,
      reviewAgentIds: segment.reviewAgentIds,
      verifyAgentId: segment.verifyAgentId,
    });
    return segment;
  };

  const progressiveSegmentMatchesCurrentVersions = (segment) =>
    Boolean(
      segment?.versions &&
        [...segment.versions.entries()].every(
          ([path, version]) => changeMap.get(path)?.afterContent === version,
        ),
    );

  const buildProgressiveReviewFeedback = (segment) => {
    if (
      !segment ||
      segment.feedbackDelivered ||
      segment.verdict !== "needs_changes"
    ) {
      return "";
    }
    segment.feedbackDelivered = true;
    if (!progressiveSegmentMatchesCurrentVersions(segment)) return "";
    const findings = Array.isArray(segment.findings)
      ? segment.findings
      : [];
    if (!findings.length) return "";
    return [
      "AporiaX background Review subagent found issues in the latest unchanged file versions.",
      "Address these findings before continuing. Do not merely restate them:",
      JSON.stringify(findings),
      segment.remainingRisks?.length
        ? `Uncertainty: ${JSON.stringify(segment.remainingRisks)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  };

  const describeProgressiveReviewJob = (job) => ({
    scheduled: true,
    status: job?.status || "running",
    segmentId: job?.result?.id || null,
    paths: job?.paths || [],
  });

  const scheduleProgressiveSelfCheckSegment = (options) => {
    if (progressiveReviewJob && !progressiveReviewJob.consumed) {
      return describeProgressiveReviewJob(progressiveReviewJob);
    }
    const paths = reviewableChanges(changeMap)
      .filter(
        (change) =>
          selfCheck.reviewedVersions.get(change.path) !==
          change.afterContent,
      )
      .map((change) => change.path);
    if (!paths.length && !options.runVerification) return null;
    const job = {
      status: "running",
      consumed: false,
      paths,
      result: null,
      promise: null,
    };
    job.promise = runProgressiveSelfCheckSegment(options)
      .then((segment) => {
        job.status = "completed";
        job.result = segment;
        return segment;
      })
      .catch((error) => {
        job.status = "failed";
        job.error = String(error?.message || error).slice(0, 800);
        emit({
          type: "self_check.segment.failed",
          error: job.error,
          paths: job.paths,
        });
        return null;
      });
    progressiveReviewJob = job;
    return describeProgressiveReviewJob(job);
  };

  const consumeProgressiveReviewJob = async ({ wait = false } = {}) => {
    const job = progressiveReviewJob;
    if (!job || job.consumed) return "";
    if (wait) await job.promise;
    if (job.status === "running") return "";
    job.consumed = true;
    return buildProgressiveReviewFeedback(job.result);
  };

  const sealProgressiveSelfCheck = async () => {
    const pendingPaths = reviewableChanges(changeMap)
      .filter(
        (change) =>
          selfCheck.reviewedVersions.get(change.path) !==
          change.afterContent,
      )
      .map((change) => change.path);
    if (pendingPaths.length) return null;
    if (
      selfCheck.verificationCandidates.length > 0 &&
      !selfCheck.verificationAttempted
    ) {
      return null;
    }
    const currentChanges = reviewableChanges(changeMap);
    const currentSignature = createChangeVersionSignature(currentChanges);
    const remainingRisks = [
      ...new Set(
        selfCheck.segments.flatMap(
          (segment) => segment.remainingRisks || [],
        ),
      ),
    ];
    if (
      selfCheck.verificationCandidates.length &&
      !selfCheck.verificationPassed &&
      !remainingRisks.some((risk) => /验证|verification|command/i.test(risk))
    ) {
      remainingRisks.push("项目验证命令未通过，仍需人工确认运行结果。");
    }
    if (!selfCheck.verificationCandidates.length) {
      remainingRisks.push("未发现可执行的项目验证脚本，已完成分段静态复核。");
    }
    const unreviewableBinaryPaths = buildChanges(changeMap)
      .filter(
        (change) =>
          change.binary &&
          !change.afterMissing &&
          !isOfficePath(change.path),
      )
      .map((change) => change.path);
    if (unreviewableBinaryPaths.length) {
      remainingRisks.push(
        `以下二进制产物未进行内容级复核：${unreviewableBinaryPaths.join(", ")}`,
      );
    }
    if (
      buildChanges(changeMap).some(
        (change) =>
          change.binary &&
          isOfficePath(change.path) &&
          change.artifact?.visualQa !== "rendered",
      )
    ) {
      remainingRisks.push(
        "Office 文件已通过结构检查，最终视觉版式仍需在对应 Office 应用中确认。",
      );
    }
    selfCheck.mode = "progressive";
    selfCheck.started = true;
    selfCheck.completed = true;
    selfCheck.seal = {
      id: `seal-${Date.now()}`,
      createdAt: new Date().toISOString(),
      versionSignature: currentSignature,
      reviewedFiles: currentChanges.map((change) => change.path),
      segmentCount: selfCheck.segments.length,
      verificationAttempted: selfCheck.verificationAttempted,
      verificationPassed: selfCheck.verificationPassed,
    };
    selfCheck.report = {
      summary:
        language === "en"
          ? `${selfCheck.segments.length} staged subagent review segment(s) cover every current changed file version; the final evidence seal is complete.`
          : `${selfCheck.segments.length} 个分段子 Agent 自检已覆盖全部当前文件版本，最终证据封印完成。`,
      checks: [
        ...new Set(
          selfCheck.segments.flatMap((segment) => segment.checks || []),
        ),
      ].slice(0, 20),
      improvements: [
        ...new Set(
          selfCheck.segments.flatMap((segment) =>
            (segment.findings || []).map(
              (finding) => `${finding.path || "任务"}: ${finding.message}`,
            ),
          ),
        ),
      ].slice(0, 20),
      remainingRisks: [...new Set(remainingRisks)].slice(0, 20),
    };
    emit({
      type: "self_check.sealed",
      seal: selfCheck.seal,
    });
    emit({
      type: "self_check.completed",
      report: buildSelfCheckResult(selfCheck, changeMap),
    });
    return selfCheck.seal;
  };

  const collectSubagents = async (rawInput = {}) => {
    const requestedIds = Array.isArray(rawInput.agent_ids)
      ? rawInput.agent_ids.map(String)
      : [];
    const wait = rawInput.wait !== false;
    const records = requestedIds.length
      ? requestedIds.map((id) => subagents.get(id)).filter(Boolean)
      : [...subagents.values()].filter((record) => !record.collected);
    if (!records.length) {
      return { results: [], running: [], message: "No matching subagents." };
    }
    const results = [];
    const running = [];
    for (const record of records) {
      if (!wait && record.status === "running") {
        running.push({
          agentId: record.agentId,
          role: record.role,
          task: record.task,
          status: record.status,
        });
        continue;
      }
      const result = await record.promise;
      record.collected = true;
      results.push(result);
    }
    emit({
      type: "subagent.collected",
      agentIds: results.map((result) => result.agentId),
      running: running.map((record) => record.agentId),
    });
    return { results, running };
  };

  const collectOutstandingSubagents = async () => {
    const records = [...subagents.values()].filter(
      (record) => !record.collected,
    );
    if (!records.length) return [];
    const results = [];
    for (const record of records) {
      const result = await record.promise;
      record.collected = true;
      results.push(result);
    }
    emit({
      type: "subagent.collected",
      agentIds: results.map((result) => result.agentId),
      automatic: true,
    });
    return results;
  };

  const refreshAnchorSnapshot = async ({
    ignoreAbort = false,
  } = {}) => {
    if (!anchorBaseline || !workspaceRoot) return [];
    try {
      const nextSnapshot = await captureWorkspaceStateFromRoot(
        workspaceRoot,
        ignoreAbort ? undefined : signal,
      );
      const previousSnapshot = anchorLatest || anchorBaseline;
      const changedSinceLast = new Set();
      const paths = new Set([
        ...previousSnapshot.files.keys(),
        ...nextSnapshot.files.keys(),
      ]);
      for (const path of paths) {
        const previous = previousSnapshot.files.get(path) || null;
        const next = nextSnapshot.files.get(path) || null;
        if (
          Boolean(previous) !== Boolean(next) ||
          previous?.binary !== next?.binary ||
          previous?.content !== next?.content
        ) {
          changedSinceLast.add(path);
        }
      }
      reconcileWorkspaceState(
        changeMap,
        anchorBaseline,
        nextSnapshot,
      );
      anchorLatest = nextSnapshot;
      return buildChanges(changeMap).filter((change) =>
        changedSinceLast.has(change.path),
      );
    } catch (error) {
      if (error?.name === "AbortError" && !ignoreAbort) throw error;
      anchorCaptureError = error?.message || "Snapshot capture failed.";
      return [];
    }
  };

  const finalizeAnchor = async (status) => {
    await refreshAnchorSnapshot({ ignoreAbort: true });
    const changes = buildChanges(changeMap);
    const latest = anchorLatest || anchorBaseline;
    return {
      changes,
      anchor: {
        id: runId || `anchor-${anchorStartedAt}`,
        startedAt: anchorStartedAt,
        completedAt: new Date().toISOString(),
        status,
        scope: "workspace-delta",
        changedFiles: changes.length,
        capturedFiles: latest?.capturedFiles || 0,
        skippedFiles: Math.max(
          anchorBaseline?.skippedFiles || 0,
          latest?.skippedFiles || 0,
        ),
        snapshotComplete: Boolean(
          anchorBaseline &&
            latest &&
            !anchorBaseline.truncated &&
            !latest.truncated &&
            !anchorCaptureError,
        ),
        warning: anchorCaptureError,
      },
    };
  };

  try {
    if (hasWorkspace && canWriteWorkspace) {
      try {
        anchorBaseline = await captureWorkspaceStateFromRoot(
          workspaceRoot,
          signal,
        );
        anchorLatest = anchorBaseline;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        anchorCaptureError =
          error?.message || "Initial snapshot capture failed.";
      }
    }
    for (let step = 0; ; step += 1) {
      throwIfAborted(signal);
      await applyRuntimeControlBoundary();
      const completedReviewFeedback = await consumeProgressiveReviewJob();
      if (completedReviewFeedback) {
        conversation.push({
          role: "user",
          content: completedReviewFeedback,
        });
      }
      emit({
        type: "response.reset",
        round: step + 1,
        phase: selfCheck.started ? "self-check" : "work",
      });
      const relevantDurableContext = upsertRelevantContextMessage(
        conversation,
        {
          checkpoints: contextCheckpoints,
          memoryFacts: projectMemory.facts,
          plan,
        },
      );
      compactManagedConversation({
        conversation,
        onEvent: emit,
        contextCheckpoints,
        contextWindowTokens,
        accounting: tokenAccounting,
        plan,
        relevantMemory: relevantDurableContext,
      });
      const requestConversation = conversation;
      const { message, usage } = await provider.complete({
        signal,
        body: {
          model: modelId,
          messages: requestConversation,
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
      recordProviderUsage(
        tokenAccounting,
        usage,
        requestConversation,
      );
      totalUsage = mergeTokenUsage(totalUsage, usage);
      emit({
        type: "context.usage",
        round: step + 1,
        usage,
        totalUsage,
        estimatedPromptTokens: estimateManagedConversationTokens(
          conversation,
          tokenAccounting,
        ),
        estimator: tokenAccounting.source,
        contextWindowTokens,
      });

      if (
        !Array.isArray(message.tool_calls) ||
        message.tool_calls.length === 0
      ) {
        const finalBackgroundReviewFeedback =
          await consumeProgressiveReviewJob({ wait: true });
        if (finalBackgroundReviewFeedback) {
          conversation.push({
            role: "assistant",
            content:
              message.content ||
              (isEnglish
                ? "The independent work is complete; I am incorporating the background review findings."
                : "独立工作已完成，正在吸收后台审查结果。"),
          });
          conversation.push({
            role: "user",
            content: finalBackgroundReviewFeedback,
          });
          continue;
        }
        const outstandingSubagentResults =
          await collectOutstandingSubagents();
        if (outstandingSubagentResults.length) {
          conversation.push({
            role: "assistant",
            content:
              message.content ||
              (isEnglish
                ? "I finished the independent work while the background subagents were running."
                : "后台子 Agent 运行期间，我已完成其余独立工作。"),
          });
          conversation.push({
            role: "user",
            content: [
              "AporiaX Harness automatically collected the remaining background subagents.",
              "Integrate their evidence, resolve conflicts, and continue the task before giving the final answer:",
              JSON.stringify(outstandingSubagentResults),
            ].join("\n"),
          });
          continue;
        }
        const changes = buildChanges(changeMap);
        const progressiveEligible =
          !selfCheck.legacyFallback &&
          (Boolean(plan) ||
            reviewableChanges(changeMap).length >=
              PROGRESSIVE_REVIEW_FILE_THRESHOLD ||
            selfCheck.segments.length > 0);
        if (
          changes.length > 0 &&
          !selfCheck.completed &&
          progressiveEligible
        ) {
          if (!selfCheck.started) {
            selfCheck.started = true;
            selfCheck.mode = "progressive";
            emit({
              type: "self_check.started",
              mode: "progressive",
              paths: changes.map((change) => change.path),
              verificationCandidates:
                selfCheck.verificationCandidates,
            });
          }
          const finalSegment = await runProgressiveSelfCheckSegment({
            reason: "final-seal",
            runVerification: true,
          });
          const currentSignature = createChangeVersionSignature(
            reviewableChanges(changeMap),
          );
          if (finalSegment?.verdict === "needs_changes") {
            if (selfCheck.lastBlockedSignature === currentSignature) {
              selfCheck.repeatedBlockedAttempts += 1;
            } else {
              selfCheck.lastBlockedSignature = currentSignature;
              selfCheck.repeatedBlockedAttempts = 1;
            }
            if (selfCheck.repeatedBlockedAttempts < 2) {
              conversation.push({
                role: "assistant",
                content:
                  message.content ||
                  (isEnglish
                    ? "The implementation reached its staged review checkpoint."
                    : "当前实现已到达分段自检检查点。"),
              });
              conversation.push({
                role: "user",
                content: [
                  "AporiaX staged Review subagent blocked the final seal.",
                  "Fix the findings below, then continue the task. Do not merely restate them:",
                  JSON.stringify(finalSegment.findings),
                ].join("\n"),
              });
              continue;
            }
          }
          const seal = !finalSegment || finalSegment.verdict === "pass"
            ? await sealProgressiveSelfCheck()
            : null;
          if (!seal) {
            selfCheck.mode = "legacy";
            selfCheck.legacyFallback = true;
            selfCheck.completed = false;
            selfCheck.report = null;
            selfCheck.seal = null;
            selfCheck.reviewedVersions.clear();
            if (!selfCheck.verificationCandidates.length) {
              selfCheck.verificationCandidates =
                !commandToolAvailable
                  ? []
                  : await discoverVerificationCommands(
                      workspaceRoot,
                      changeMap,
                    );
            }
            emit({
              type: "self_check.fallback",
              reason:
                finalSegment?.verdict || "incomplete-evidence",
              paths: changes.map((change) => change.path),
            });
            conversation.push({
              role: "assistant",
              content:
                message.content ||
                (isEnglish
                  ? "The staged review could not produce a complete evidence seal."
                  : "分段自检未能生成完整的证据封印。"),
            });
            conversation.push({
              role: "user",
              content: [
                createSelfCheckPrompt(
                  changeMap,
                  selfCheck.verificationCandidates,
                  language,
                ),
                finalSegment?.findings?.length
                  ? `Staged review findings:\n${JSON.stringify(finalSegment.findings)}`
                  : "",
              ]
                .filter(Boolean)
                .join("\n\n"),
            });
            continue;
          }
        } else if (changes.length > 0 && !selfCheck.started) {
          selfCheck.started = true;
          selfCheck.mode = "legacy";
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
            mode: "legacy",
            paths: changes.map((change) => change.path),
            verificationCandidates:
              selfCheck.verificationCandidates,
          });
          conversation.push({
            role: "assistant",
            content:
              message.content ||
              (isEnglish
                ? "The initial implementation is complete."
                : "初步实现已经完成。"),
          });
          conversation.push({
            role: "user",
            content: createSelfCheckPrompt(
              changeMap,
              selfCheck.verificationCandidates,
              language,
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
            content:
              message.content ||
              (isEnglish
                ? "The self-check is not complete yet."
                : "自检尚未完成。"),
          });
          conversation.push({
            role: "user",
            content: isEnglish
              ? [
                  "The mandatory self-check is incomplete, so Harness blocked the final answer.",
                  pendingPaths.length
                    ? `Re-read these files after their latest write:\n${pendingPaths
                        .map((path) => `- ${path}`)
                        .join("\n")}`
                    : "All changed files were read, but complete_self_check has not succeeded.",
                  "Continue the self-check and call complete_self_check before finishing.",
                ].join("\n")
              : [
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

        const finalizedAnchor = await finalizeAnchor("completed");
        for (const verification of selfCheck.verificationResults) {
          if (!verification.passed) continue;
          stageUnderstandingCandidate(
            {
              category: "verification",
              content: `Verified command: ${verification.command} (cwd: ${verification.cwd || "."})`,
              confidence: 0.96,
              evidence: verification.command,
            },
            {
              source: "harness-verification",
              evidenceType: "command",
            },
          );
        }
        const finalContent =
          typeof message.content === "string" && message.content.trim()
            ? sanitizeFinalAnswer(message.content)
            : isEnglish
              ? "The task completed, but the model returned no text."
              : "任务已完成，但模型没有返回文本结果。";
        const curatedUnderstanding = await curateProjectUnderstanding({
          finalAnswer: finalContent,
          changes: finalizedAnchor.changes,
        });
        const understanding =
          curatedUnderstanding ||
          (legacyUnderstandingImport?.committed
            ? {
                committed: true,
                currentRevision:
                  legacyUnderstandingImport.state.currentRevision,
                revisionId: legacyUnderstandingImport.revision.id,
                summary: legacyUnderstandingImport.revision.summary,
                factCount: legacyUnderstandingImport.state.facts.length,
                source: "legacy-memory-import",
              }
            : null);
        const completedResult = {
          status: "completed",
          content:
            typeof message.content === "string" && message.content.trim()
              ? sanitizeFinalAnswer(message.content)
              : isEnglish
                ? "The task completed, but the model returned no text."
                : "任务已完成，但模型没有返回文本结果。",
          steps,
          changes: finalizedAnchor.changes,
          anchor: finalizedAnchor.anchor,
          usage: totalUsage,
          instructionFiles: [...instructionContext.loadedFiles],
          permissionConfigFile: projectConfig.file,
          provider: provider.id,
          providerName: provider.name,
          model: modelId,
          sandbox: sandboxStatus,
          tools: toolCatalog,
          selfCheck: buildSelfCheckResult(selfCheck, changeMap),
          understanding,
          plan,
          contextCheckpoints,
          contextStats: {
            estimator: tokenAccounting.source,
            requests: tokenAccounting.requests,
            estimatedPromptTokens: estimateManagedConversationTokens(
              conversation,
              tokenAccounting,
            ),
            contextWindowTokens,
          },
          subagents: [...subagents.values()].map((record) => ({
            agentId: record.agentId,
            role: record.role,
            task: record.task,
            status: record.status,
            background: record.background,
          })),
        };
        completedResult.content = finalContent;
        emit({
          type: "turn.completed",
          status: completedResult.status,
          changedFiles: completedResult.changes.length,
          toolSteps: steps.length,
        });
        completedResult.witness = witness.snapshot();
        subagentController.abort();
        signal?.removeEventListener("abort", abortSubagents);
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

      const retryAfterScopedInstructions =
        await loadScopedContextForToolCalls(message.tool_calls);

      if (mainToolBatchCanRunInParallel(message.tool_calls)) {
        emit({
          type: "parallel_batch.started",
          count: message.tool_calls.length,
          tools: message.tool_calls.map((call) => call.function.name),
        });
        const parallelResults = await mapWithConcurrency(
          message.tool_calls,
          MAX_PARALLEL_TOOL_CALLS,
          async (toolCall) => {
            throwIfAborted(signal);
            await control?.waitIfPaused?.(signal);
            const toolName = toolCall.function.name;
            const activity = describeToolActivity(toolCall);
            emit({
              type: "tool.requested",
              callId: toolCall.id,
              tool: toolName,
              phase: selfCheck.started ? "self-check" : "work",
              parallel: true,
            });
            emit({
              type: "tool.started",
              callId: toolCall.id,
              tool: toolName,
              phase: selfCheck.started ? "self-check" : "work",
              planStepId:
                plan?.steps.find((step) => step.status === "in_progress")
                  ?.id || null,
              parallel: true,
              ...activity,
            });
            let result;
            let success = true;
            try {
              if (toolName === "delegate_subagent") {
                result = {
                  modelResult: await startSubagent(
                    parseToolArguments(toolCall),
                    toolCall.id,
                  ),
                };
              } else {
                result = await executeTool({
                  toolCall,
                  workspaceRoot,
                  permissionPolicy,
                  approvalMode: effectiveApprovalMode,
                  requestApproval,
                  signal,
                  sandboxExecutor,
                  sandboxStatus,
                });
              }
            } catch (error) {
              if (error?.name === "AbortError") throw error;
              success = false;
              result = { modelResult: { error: error.message } };
            }
            const modelResult = result.modelResult;
            const detail = formatToolStepDetail(
              toolName,
              modelResult,
              language,
            );
            emit({
              type: "tool.completed",
              callId: toolCall.id,
              tool: toolName,
              success,
              detail,
              phase: selfCheck.started ? "self-check" : "work",
              parallel: true,
            });
            return { toolCall, result, success, detail };
          },
        );
        for (const outcome of parallelResults) {
          const { toolCall, result, success, detail } = outcome;
          const modelResult = result.modelResult;
          if (
            selfCheck.started &&
            changeMap.has(modelResult?.path) &&
            ((changeMap.get(modelResult.path).binary &&
              toolCall.function.name === "inspect_office_file") ||
              (!changeMap.get(modelResult.path).binary &&
                toolCall.function.name === "read_file"))
          ) {
            selfCheck.reviewedVersions.set(
              modelResult.path,
              changeMap.get(modelResult.path).afterContent,
            );
          }
          steps.push({
            name: toolCall.function.name,
            planStepId:
              plan?.steps.find((step) => step.status === "in_progress")
                ?.id || null,
            success,
            skipped: Boolean(modelResult?.skipped),
            retry: false,
            parallel: true,
            detail,
            path: modelResult?.path || null,
            command: modelResult?.command || null,
            exitCode:
              typeof modelResult?.exitCode === "number"
                ? modelResult.exitCode
                : null,
            agentId: modelResult?.agentId || null,
          });
          conversation.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(modelResult),
          });
        }
        emit({
          type: "parallel_batch.completed",
          count: parallelResults.length,
          succeeded: parallelResults.filter((item) => item.success).length,
        });
        continue;
      }

      for (const toolCall of message.tool_calls) {
        throwIfAborted(signal);
        await control?.waitIfPaused?.(signal);
        let result;
        let success = true;
        let matchedVerificationCandidate = null;
        const activity = describeToolActivity(toolCall);
        emit({
          type: "tool.requested",
          callId: toolCall.id,
          tool: toolCall.function.name,
          phase: selfCheck.started ? "self-check" : "work",
        });
        emit({
          type: "tool.started",
          callId: toolCall.id,
          tool: toolCall.function.name,
          phase: selfCheck.started ? "self-check" : "work",
          planStepId:
            plan?.steps.find((step) => step.status === "in_progress")
              ?.id || null,
          ...activity,
        });
        try {
          if (retryAfterScopedInstructions.has(toolCall.id)) {
            throw new Error(
              "Scoped project instructions were loaded for this path. Review them and retry the file mutation with compliant content.",
            );
          }
          if (toolCall.function.name === "delegate_subagent") {
            result = {
              modelResult: await startSubagent(
                parseToolArguments(toolCall),
                toolCall.id,
              ),
            };
          } else if (toolCall.function.name === "collect_subagents") {
            result = {
              modelResult: await collectSubagents(
                parseToolArguments(toolCall),
              ),
            };
          } else if (toolCall.function.name === "remember_project_fact") {
            const candidate = stageUnderstandingCandidate(
              parseToolArguments(toolCall),
            );
            result = {
              modelResult: {
                proposed: true,
                committed: false,
                candidate: {
                  id: candidate.id,
                  category: candidate.category,
                  content: candidate.content,
                },
                next: "Curator review and Harness evidence validation",
              },
            };
          } else if (toolCall.function.name === "update_plan") {
            const previousPlan = plan;
            const nextPlan = normalizeExecutionPlan(
              parseToolArguments(toolCall),
              plan,
            );
            const newlyCompletedSteps = nextPlan.steps.filter((step) => {
              if (step.status !== "completed") return false;
              return previousPlan?.steps?.find(
                (previousStep) => previousStep.id === step.id,
              )?.status !== "completed";
            });
            plan = nextPlan;
            result = {
              modelResult: {
                updated: true,
                revision: plan.revision,
                steps: plan.steps,
              },
            };
            emit({
              type: "plan.updated",
              plan,
            });
            if (
              newlyCompletedSteps.length &&
              reviewableChanges(changeMap).some(
                (change) =>
                  selfCheck.reviewedVersions.get(change.path) !==
                  change.afterContent,
              )
            ) {
              const completedStep = newlyCompletedSteps.at(-1);
              const stagedReview =
                scheduleProgressiveSelfCheckSegment({
                  reason: `plan-step:${completedStep.title}`,
                  planStepId: completedStep.id,
                  runVerification: /test|verify|build|lint|check|测试|验证|构建|检查/i.test(
                    `${completedStep.title} ${completedStep.detail || ""}`,
                  ),
                });
              result.modelResult.stagedReview = stagedReview
                ? {
                    segmentId: stagedReview.segmentId,
                    status: stagedReview.status,
                    paths: stagedReview.paths,
                  }
                : null;
            }
          } else if (toolCall.function.name === "complete_self_check") {
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
            selfCheck.mode = "legacy";
            selfCheck.seal = {
              id: `legacy-seal-${Date.now()}`,
              createdAt: new Date().toISOString(),
              versionSignature: createChangeVersionSignature(
                reviewableChanges(changeMap),
              ),
              reviewedFiles: reviewableChanges(changeMap).map(
                (change) => change.path,
              ),
              segmentCount: selfCheck.segments.length,
              verificationAttempted: selfCheck.verificationAttempted,
              verificationPassed: selfCheck.verificationPassed,
              fallback: true,
            };
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
              approvalMode: effectiveApprovalMode,
              requestApproval,
              signal,
              sandboxExecutor,
              sandboxStatus,
              browserRuntime,
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
                selfCheck.seal = null;
              }
            }
            if (toolCall.function.name === "run_command") {
              const snapshotChanges = await refreshAnchorSnapshot();
              if (snapshotChanges.length > 0) {
                result.modelResult.workspaceChanges =
                  snapshotChanges.map((change) => ({
                    path: change.path,
                    created: Boolean(change.created),
                    deleted: Boolean(change.deleted),
                    binary: Boolean(change.binary),
                    additions: change.additions || 0,
                    deletions: change.deletions || 0,
                  }));
                for (const change of snapshotChanges) {
                  emit({
                    type: "file.changed",
                    path: change.path,
                    additions: change.additions,
                    deletions: change.deletions,
                    binary: Boolean(change.binary),
                    artifact: change.artifact || null,
                    created: change.created,
                    deleted: change.deleted,
                    source: "workspace-snapshot",
                  });
                }
                if (selfCheck.started) {
                  selfCheck.completed = false;
                  selfCheck.report = null;
                  selfCheck.seal = null;
                }
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
          language,
        );
        const shouldRetry =
          !success &&
          (toolCall.function.name === "complete_self_check" ||
            /Invalid arguments/i.test(modelResult?.error || ""));
        steps.push({
          name: toolCall.function.name,
          planStepId:
            plan?.steps.find((step) => step.status === "in_progress")
              ?.id || null,
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
          callId: toolCall.id,
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
      if (!selfCheck.started) {
        const pendingStagePaths = reviewableChanges(changeMap)
          .filter(
            (change) =>
              selfCheck.reviewedVersions.get(change.path) !==
              change.afterContent,
          )
          .map((change) => change.path);
        if (
          pendingStagePaths.length >=
          PROGRESSIVE_REVIEW_FILE_THRESHOLD
        ) {
          scheduleProgressiveSelfCheckSegment({
            reason: "change-batch",
            planStepId:
              plan?.steps.find((step) => step.status === "in_progress")
                ?.id || null,
            runVerification: false,
          });
        }
      }
    }

  } catch (error) {
    subagentController.abort();
    signal?.removeEventListener("abort", abortSubagents);
    if (error?.name === "AbortError" || signal?.aborted) {
      const finalizedAnchor = await finalizeAnchor("interrupted");
      const interruptedResult = {
        status: "interrupted",
        content: isEnglish
          ? "The task was stopped. Completed file changes remain available and can be reverted from the review panel."
          : "任务已停止。已经完成的文件修改仍保留，可在审核面板中撤销。",
        steps,
        changes: finalizedAnchor.changes,
        anchor: finalizedAnchor.anchor,
        usage: totalUsage,
        instructionFiles: [...instructionContext.loadedFiles],
        permissionConfigFile: projectConfig.file,
        provider: provider.id,
        providerName: provider.name,
        model: modelId,
        sandbox: sandboxStatus,
        tools: toolCatalog,
        selfCheck: buildSelfCheckResult(selfCheck, changeMap),
        plan,
        contextCheckpoints,
        contextStats: {
          estimator: tokenAccounting.source,
          requests: tokenAccounting.requests,
          contextWindowTokens,
        },
        subagents: [...subagents.values()].map((record) => ({
          agentId: record.agentId,
          role: record.role,
          task: record.task,
          status: record.status,
          background: record.background,
        })),
      };
      emit({
        type: "turn.cancelled",
        status: interruptedResult.status,
        changedFiles: interruptedResult.changes.length,
        toolSteps: steps.length,
      });
      interruptedResult.witness = witness.snapshot();
      return interruptedResult;
    }
    const finalizedAnchor = await finalizeAnchor("failed");
    const failedResult = {
      status: "failed",
      error: true,
      content:
        error?.message ||
        (isEnglish ? "Harness run failed." : "Harness 运行失败。"),
      steps,
      changes: finalizedAnchor.changes,
      anchor: finalizedAnchor.anchor,
      usage: totalUsage,
      instructionFiles: [...instructionContext.loadedFiles],
      permissionConfigFile: projectConfig.file,
      provider: provider.id,
      providerName: provider.name,
      model: modelId,
      sandbox: sandboxStatus,
      tools: toolCatalog,
      selfCheck: buildSelfCheckResult(selfCheck, changeMap),
      plan,
      contextCheckpoints,
      contextStats: {
        estimator: tokenAccounting.source,
        requests: tokenAccounting.requests,
        contextWindowTokens,
      },
      subagents: [...subagents.values()].map((record) => ({
        agentId: record.agentId,
        role: record.role,
        task: record.task,
        status: record.status,
        background: record.background,
      })),
    };
    emit({
      type: "turn.failed",
      status: failedResult.status,
      error: failedResult.content,
      changedFiles: failedResult.changes.length,
      toolSteps: steps.length,
    });
    failedResult.witness = witness.snapshot();
    return failedResult;
  } finally {
    await browserRuntime.close().catch(() => undefined);
    witness?.dispose();
  }
}

export async function listWorkspaceTree(
  workspacePath,
  requestedDirectory = ".",
) {
  const workspaceRoot = await getVerifiedWorkspaceRoot(workspacePath);
  const normalizedDirectory = String(requestedDirectory || ".")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "") || ".";
  const directoryPath = await verifyExistingTarget(
    workspaceRoot,
    normalizedDirectory,
  );
  const stats = await lstat(directoryPath);
  if (!stats.isDirectory()) {
    throw new Error("The selected workspace path is not a directory.");
  }
  const children = await readdir(directoryPath, { withFileTypes: true });
  children.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) {
      return left.isDirectory() ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  const entries = [];
  for (const child of children) {
    if (entries.length >= MAX_TREE_ENTRIES) break;
    if (TREE_IGNORES.has(child.name) || child.isSymbolicLink()) continue;
    const childRelative = normalizedDirectory !== "."
      ? `${normalizedDirectory}/${child.name}`
      : child.name;
    entries.push({
      path: childRelative,
      name: child.name,
      type: child.isDirectory() ? "directory" : "file",
      parentPath: normalizedDirectory,
      extension: child.isFile()
        ? extname(child.name).slice(1).toLowerCase()
        : "",
    });
  }
  return {
    directory: normalizedDirectory,
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

function checkpointBinaryLimit(path) {
  return isOfficePath(path)
    ? MAX_OFFICE_FILE_BYTES
    : MAX_ANCHOR_BINARY_FILE_BYTES;
}

function normalizeCheckpointState(change, side) {
  const before = side === "before";
  const missing = before
    ? Boolean(change.beforeMissing ?? change.created)
    : Boolean(change.afterMissing ?? change.deleted);
  return {
    missing,
    binary: Boolean(change.binary),
    content: missing
      ? ""
      : String(
          before ? change.beforeContent ?? "" : change.afterContent ?? "",
        ),
  };
}

function validateCheckpoint(change) {
  if (
    !change ||
    typeof change.path !== "string" ||
    !change.path.trim() ||
    typeof change.beforeContent !== "string" ||
    typeof change.afterContent !== "string"
  ) {
    return false;
  }
  if (!change.binary) {
    return (
      change.beforeContent.length <= MAX_FILE_WRITE_CHARS * 6 &&
      change.afterContent.length <= MAX_FILE_WRITE_CHARS * 6
    );
  }
  const maximum = Math.ceil(checkpointBinaryLimit(change.path) * 1.4);
  return (
    change.beforeContent.length <= maximum &&
    change.afterContent.length <= maximum
  );
}

async function readCheckpointState(
  workspaceRoot,
  requestedPath,
  binary,
) {
  const filePath = resolveWorkspacePath(workspaceRoot, requestedPath);
  try {
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Checkpoint target is not a regular file.");
    }
    const verifiedPath = await realpath(filePath);
    if (!isPathInside(workspaceRoot, verifiedPath)) {
      throw new Error("Checkpoint target escapes the workspace.");
    }
    const buffer = await readFile(verifiedPath);
    return {
      missing: false,
      binary,
      content: binary
        ? buffer.toString("base64")
        : buffer.toString("utf8"),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { missing: true, binary, content: "" };
    }
    throw error;
  }
}

function checkpointStatesEqual(left, right) {
  return (
    Boolean(left?.missing) === Boolean(right?.missing) &&
    (left?.missing ||
      (Boolean(left?.binary) === Boolean(right?.binary) &&
        left?.content === right?.content))
  );
}

async function writeCheckpointState(
  workspaceRoot,
  requestedPath,
  state,
) {
  const filePath = resolveWorkspacePath(workspaceRoot, requestedPath);
  if (state.missing) {
    try {
      const stats = await lstat(filePath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error("Refusing to remove a non-file checkpoint target.");
      }
      const verifiedPath = await realpath(filePath);
      if (!isPathInside(workspaceRoot, verifiedPath)) {
        throw new Error("Checkpoint target escapes the workspace.");
      }
      await rm(verifiedPath, { force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return;
  }

  await mkdir(dirname(filePath), { recursive: true });
  const verifiedParent = await realpath(dirname(filePath));
  if (!isPathInside(workspaceRoot, verifiedParent)) {
    throw new Error("Checkpoint parent escapes the workspace.");
  }
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || stats.isDirectory()) {
      throw new Error("Refusing to overwrite a symbolic link or directory.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (state.binary) {
    const buffer = Buffer.from(state.content, "base64");
    if (buffer.length > checkpointBinaryLimit(requestedPath)) {
      throw new Error("Binary checkpoint exceeds the restore limit.");
    }
    await writeFile(filePath, buffer);
  } else {
    await writeFile(filePath, state.content, "utf8");
  }
}

export async function revertWorkspaceChanges({
  workspacePath,
  changes,
}) {
  const workspaceRoot = await getVerifiedWorkspaceRoot(workspacePath);
  if (!Array.isArray(changes) || changes.length === 0) return [];
  const results = [];

  for (const change of changes.slice(0, 100)) {
    if (!validateCheckpoint(change)) {
      results.push({
        path: change?.path || "unknown",
        success: false,
        reason: "invalid-checkpoint",
      });
      continue;
    }
    try {
      const expected = normalizeCheckpointState(change, "after");
      const current = await readCheckpointState(
        workspaceRoot,
        change.path,
        expected.binary,
      );
      if (!checkpointStatesEqual(current, expected)) {
        results.push({
          path: change.path,
          success: false,
          reason: "file-changed-after-checkpoint",
        });
        continue;
      }
      await writeCheckpointState(
        workspaceRoot,
        change.path,
        normalizeCheckpointState(change, "before"),
      );
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

export async function restoreWorkspaceAnchor({
  workspacePath,
  checkpoints,
}) {
  const workspaceRoot = await getVerifiedWorkspaceRoot(workspacePath);
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return {
      success: false,
      restoredFiles: 0,
      restoredCheckpoints: [],
      conflicts: [],
      reason: "no-checkpoints",
    };
  }

  const operations = [];
  for (const checkpoint of checkpoints.slice(0, 100)) {
    for (const change of (checkpoint?.changes || []).slice(0, 100)) {
      if (change?.reverted) continue;
      operations.push({
        checkpointId: String(checkpoint?.id || ""),
        change,
      });
      if (operations.length >= 500) break;
    }
    if (operations.length >= 500) break;
  }
  if (!operations.length) {
    return {
      success: false,
      restoredFiles: 0,
      restoredCheckpoints: [],
      conflicts: [],
      reason: "no-active-checkpoints",
    };
  }

  const virtualStates = new Map();
  const originalStates = new Map();
  const conflicts = [];
  for (const operation of operations) {
    const { change } = operation;
    if (!validateCheckpoint(change)) {
      conflicts.push({
        path: change?.path || "unknown",
        checkpointId: operation.checkpointId,
        reason: "invalid-checkpoint",
      });
      continue;
    }
    let current = virtualStates.get(change.path);
    if (!current) {
      current = await readCheckpointState(
        workspaceRoot,
        change.path,
        Boolean(change.binary),
      );
      originalStates.set(change.path, current);
    }
    const expected = normalizeCheckpointState(change, "after");
    if (!checkpointStatesEqual(current, expected)) {
      conflicts.push({
        path: change.path,
        checkpointId: operation.checkpointId,
        reason: "file-changed-after-checkpoint",
      });
      continue;
    }
    virtualStates.set(
      change.path,
      normalizeCheckpointState(change, "before"),
    );
  }

  if (conflicts.length > 0) {
    return {
      success: false,
      restoredFiles: 0,
      restoredCheckpoints: [],
      conflicts,
      reason: "preflight-conflict",
    };
  }

  const appliedPaths = [];
  try {
    for (const [path, state] of virtualStates) {
      await writeCheckpointState(workspaceRoot, path, state);
      appliedPaths.push(path);
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const path of [...appliedPaths].reverse()) {
      try {
        await writeCheckpointState(
          workspaceRoot,
          path,
          originalStates.get(path),
        );
      } catch (rollbackError) {
        rollbackFailures.push({
          path,
          reason: rollbackError.message,
        });
      }
    }
    return {
      success: false,
      restoredFiles: 0,
      restoredCheckpoints: [],
      conflicts: [
        {
          path: appliedPaths.at(-1) || "workspace",
          reason: error.message,
        },
        ...rollbackFailures,
      ],
      reason: "restore-failed",
    };
  }

  return {
    success: true,
    restoredFiles: virtualStates.size,
    restoredCheckpoints: [
      ...new Set(operations.map((operation) => operation.checkpointId)),
    ],
    conflicts: [],
    restoredAt: new Date().toISOString(),
  };
}
