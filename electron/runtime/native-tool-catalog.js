import { ToolRegistry } from "../agent-core.js";
import { OFFICE_TOOL_DEFINITIONS } from "../office-tools.js";
import { BROWSER_TOOL_DEFINITIONS, BROWSER_TOOL_RISKS } from "../browser-runtime.js";
import { MAX_SUBAGENT_ROUNDS } from "./subagent-model.js";

export const MAX_SEARCH_RESULTS = 200;

export const TOOL_DEFINITIONS = [
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
        "Read a UTF-8 text file or extract text from a PDF inside the authorized workspace. Supports line ranges and character continuation for large files. Scanned PDFs may require OCR.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path.",
          },
          start_line: {
            type: "integer",
            minimum: 1,
            description: "Optional 1-based first line to read from a text file.",
          },
          end_line: {
            type: "integer",
            minimum: 1,
            description: "Optional inclusive 1-based last line. Use with start_line.",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description: "Optional character offset for continuation reads.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 120000,
            description: "Maximum characters returned. Defaults to 60000.",
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
        "Search workspace text with bundled ripgrep using literal, regex, symbol, definition, or reference modes plus include/exclude globs.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text, regular expression, or symbol name to search for.",
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
          mode: {
            type: "string",
            enum: ["literal", "regex", "symbol", "definition", "references"],
            description: "Search mode. Definition/reference modes are language-agnostic heuristics.",
          },
          include_glob: {
            type: "array",
            maxItems: 32,
            items: { type: "string" },
            description: "Optional ripgrep globs to include, for example src/** or *.js.",
          },
          exclude_glob: {
            type: "array",
            maxItems: 32,
            items: { type: "string" },
            description: "Optional globs to exclude.",
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
        "Apply an exact replacement or a preflighted unified diff containing multiple hunks or files, including creates and deletes.",
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
          patch: {
            type: "string",
            description: "Optional unified diff. When supplied, exact replacement fields are ignored.",
          },
          expected_sha256: {
            type: "string",
            description: "Optional SHA-256 of the current content for a single-file patch.",
          },
          dry_run: {
            type: "boolean",
            description: "Validate and report changes without writing files.",
          },
        },
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
        required: ["command", "cwd"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_process",
      description:
        "Start a managed persistent terminal process for a dev server, watcher, REPL, or interactive command. It is scoped to this task and requires approval.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string", description: "Workspace-relative working directory." },
          reason: { type: "string" },
        },
        required: ["command", "cwd", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_process",
      description: "Read new stdout/stderr from a managed persistent process without blocking.",
      parameters: {
        type: "object",
        properties: {
          process_id: { type: "string" },
          cursor: { type: "integer", minimum: 0 },
          max_chars: { type: "integer", minimum: 1, maximum: 80000 },
        },
        required: ["process_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_stdin",
      description: "Write text to a managed process stdin, optionally closing stdin afterward.",
      parameters: {
        type: "object",
        properties: {
          process_id: { type: "string" },
          data: { type: "string" },
          close: { type: "boolean" },
        },
        required: ["process_id", "data"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kill_process",
      description: "Stop a managed persistent process and its child process tree.",
      parameters: {
        type: "object",
        properties: { process_id: { type: "string" } },
        required: ["process_id"],
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
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Read recent Git commit history without modifying the repository.",
      parameters: {
        type: "object",
        properties: {
          max_count: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_stage",
      description: "Stage explicit workspace-relative paths for a future commit. Requires approval and never stages the whole repository implicitly.",
      parameters: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: { type: "string" },
          },
          reason: { type: "string" },
        },
        required: ["paths", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description: "Create a Git commit from the currently staged changes. This tool does not auto-stage files.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", minLength: 1, maxLength: 4000 },
          reason: { type: "string" },
        },
        required: ["message", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_create_branch",
      description: "Create and switch to a new Git branch after validating its ref name.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 240 },
          reason: { type: "string" },
        },
        required: ["name", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_pull",
      description: "Pull remote Git changes into a clean workspace. Defaults to --ff-only; rebase is available explicitly. Requires approval.",
      parameters: {
        type: "object",
        properties: {
          remote: { type: "string", maxLength: 120 },
          branch: { type: "string", maxLength: 240 },
          strategy: { type: "string", enum: ["ff-only", "rebase"] },
          reason: { type: "string" },
        },
        required: ["reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_push",
      description: "Push the current or named branch to a remote. Force push is intentionally unsupported. Requires approval.",
      parameters: {
        type: "object",
        properties: {
          remote: { type: "string", maxLength: 120 },
          branch: { type: "string", maxLength: 240 },
          set_upstream: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_pr_create",
      description: "Create a GitHub pull request through the authenticated GitHub CLI. Requires approval and never exposes GitHub credentials to the model.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 240 },
          body: { type: "string", maxLength: 20000 },
          base: { type: "string", maxLength: 240 },
          head: { type: "string", maxLength: 240 },
          draft: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["title", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_pr_view",
      description: "Read the current or numbered GitHub pull request through GitHub CLI.",
      parameters: {
        type: "object",
        properties: {
          number: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_pr_checks",
      description: "Read GitHub checks for the current or numbered pull request. A failing check is returned as evidence rather than treated as a tool failure.",
      parameters: {
        type: "object",
        properties: {
          number: { type: "integer", minimum: 1 },
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
      name: "request_self_check",
      description:
        "Request an independent adaptive self-check when the work may be wrong, incomplete, risky, or difficult to verify. Do not call this for casual conversation or a straightforward answer with no file changes.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description:
              "Concise concrete reason an independent review is warranted.",
          },
          focus: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional workspace-relative files or concerns the reviewers should prioritize.",
          },
        },
        required: ["reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_external_file",
      description:
        "Read a user-approved UTF-8 text file or PDF outside the workspace. Every call requires explicit approval and never grants write access.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute external file path." },
          start_line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 1 },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 120000 },
          reason: { type: "string", description: "Why this external file is needed." },
        },
        required: ["path", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_self_check",
      description:
        "Finish an active fallback self-check phase. This succeeds only after every changed text file has been re-read and every changed Office file has been structurally inspected after its latest write.",
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

export const TOOL_RISKS = {
  delegate_subagent: "control",
  collect_subagents: "control",
  remember_project_fact: "control",
  update_plan: "control",
  list_directory: "read",
  read_file: "read",
  read_external_file: "read",
  search_text: "read",
  git_status: "read",
  git_diff: "read",
  git_log: "read",
  git_stage: "write",
  git_commit: "write",
  git_create_branch: "write",
  git_pull: "write",
  git_push: "control",
  github_pr_create: "control",
  github_pr_view: "read",
  github_pr_checks: "read",
  inspect_office_file: "read",
  write_file: "write",
  apply_patch: "write",
  create_word_document: "write",
  create_presentation: "write",
  create_spreadsheet: "write",
  run_command: "execute",
  start_process: "execute",
  read_process: "read",
  write_stdin: "control",
  kill_process: "control",
  ...BROWSER_TOOL_RISKS,
  request_self_check: "control",
  complete_self_check: "control",
};

export const TOOL_REGISTRY = new ToolRegistry(
  TOOL_DEFINITIONS.map((definition) => ({
    definition,
    risk: TOOL_RISKS[definition.function.name],
  })),
);

