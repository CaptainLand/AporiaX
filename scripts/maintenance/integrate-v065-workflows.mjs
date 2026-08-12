import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const githubBranch = "origin/agent/0.6.5-github-workflow";

async function read(path) {
  return readFile(resolve(root, path), "utf8");
}

async function write(path, content) {
  const target = resolve(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

function gitShow(path) {
  return execFileSync("git", ["show", `${githubBranch}:${path}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

function replaceOnce(content, oldText, newText, label) {
  const first = content.indexOf(oldText);
  if (first < 0) throw new Error(`Missing integration anchor: ${label}`);
  if (content.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`Ambiguous integration anchor: ${label}`);
  }
  return content.slice(0, first) + newText + content.slice(first + oldText.length);
}

function insertBefore(content, anchor, insertion, label) {
  return replaceOnce(content, anchor, insertion + anchor, label);
}

// Bring over the GitHub runtime and approval UI from the already-validated #46 branch.
for (const path of [
  "electron/runtime/github-runtime.js",
  "electron/runtime/tool-permissions.js",
  "docs/releases/v0.6.5-github-workflow.md",
  "tests/github-workflow-smoke.mjs",
]) {
  await write(path, gitShow(path));
}

// Merge permission policies: local Git lifecycle is autonomous in workspace-write;
// host/global or remote mutations still require approval.
{
  let content = await read("electron/agent-core.js");
  content = replaceOnce(
    content,
    `    lsp: "allow",\n    git_status: "allow",\n    git_diff: "allow",\n    inspect_office_file: "allow",`,
    `    lsp: "allow",\n    git_status: "allow",\n    git_diff: "allow",\n    git_log: "allow",\n    git_remote_list: "allow",\n    github_pr_view: "allow",\n    github_pr_checks: "allow",\n    inspect_office_file: "allow",`,
    "read-only git inspection policy",
  );
  content = replaceOnce(
    content,
    `    lsp: "allow",\n    git_status: "allow",\n    git_diff: "allow",\n    write_file: "allow",`,
    `    lsp: "allow",\n    lsp_install: "ask",\n    git_status: "allow",\n    git_diff: "allow",\n    git_log: "allow",\n    git_init: "allow",\n    git_stage: "allow",\n    git_commit: "allow",\n    git_create_branch: "allow",\n    git_remote_list: "allow",\n    git_remote_add: "ask",\n    git_pull: "ask",\n    git_push: "ask",\n    github_repo_create: "ask",\n    github_pr_create: "ask",\n    github_pr_view: "allow",\n    github_pr_checks: "allow",\n    write_file: "allow",`,
    "workspace-write integrated git policy",
  );
  content = replaceOnce(
    content,
    `    lsp: "allow",\n    git_status: "allow",\n    git_diff: "allow",\n    update_plan: "allow",`,
    `    lsp: "allow",\n    git_status: "allow",\n    git_diff: "allow",\n    git_log: "allow",\n    git_remote_list: "allow",\n    update_plan: "allow",`,
    "builder git read policy",
  );
  await write("electron/agent-core.js", content);
}

// Extend approval labels copied from #46.
{
  let content = await read("electron/runtime/tool-permissions.js");
  content = replaceOnce(
    content,
    `  const approvalTitles = {\n    git_stage: "暂存 Git 变更",\n    git_commit: "创建 Git Commit",\n    git_create_branch: "创建 Git 分支",\n    git_pull: "拉取远程 Git 变更",\n    git_push: "推送 Git 分支",\n    github_pr_create: "创建 GitHub Pull Request",\n  };`,
    `  const approvalTitles = {\n    lsp_install: "安装语言服务器",\n    git_init: "初始化 Git 仓库",\n    git_stage: "暂存 Git 变更",\n    git_commit: "创建 Git Commit",\n    git_create_branch: "创建 Git 分支",\n    git_remote_add: "添加 Git 远程仓库",\n    git_pull: "拉取远程 Git 变更",\n    git_push: "推送 Git 分支",\n    github_repo_create: "创建 GitHub 仓库",\n    github_pr_create: "创建 GitHub Pull Request",\n  };`,
    "approval titles",
  );
  await write("electron/runtime/tool-permissions.js", content);
}

// Tool catalog: add installable LSP and a complete Git/GitHub bootstrap workflow.
{
  let content = await read("electron/runtime/native-tool-catalog.js");
  const lspInstallTool = `  {\n    type: "function",\n    function: {\n      name: "lsp_install",\n      description:\n        "Install a missing language server for AporiaX. This is a host-level dependency/network mutation and requires approval. Python and Go are installed into AporiaX-managed storage; Rust uses rustup; clangd uses the platform package manager.",\n      parameters: {\n        type: "object",\n        properties: {\n          language: {\n            type: "string",\n            enum: ["python", "rust", "go", "clangd"],\n          },\n          reason: { type: "string" },\n        },\n        required: ["language", "reason"],\n        additionalProperties: false,\n      },\n    },\n  },\n`;
  content = insertBefore(
    content,
    `  {\n    type: "function",\n    function: {\n      name: "run_command",`,
    lspInstallTool,
    "lsp install tool",
  );

  const gitTools = `  {\n    type: "function",\n    function: {\n      name: "git_log",\n      description: "Read recent Git commit history without modifying the repository.",\n      parameters: { type: "object", properties: { max_count: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false },\n    },\n  },\n  {\n    type: "function",\n    function: {\n      name: "git_init",\n      description: "Initialize the authorized workspace as a Git repository. Local repository bootstrap is safe to perform autonomously when workspace-write permission allows it.",\n      parameters: {\n        type: "object",\n        properties: {\n          initial_branch: { type: "string", maxLength: 240, description: "Initial branch name. Defaults to main." },\n          reason: { type: "string" },\n        },\n        additionalProperties: false,\n      },\n    },\n  },\n  {\n    type: "function",\n    function: {\n      name: "git_stage",\n      description: "Stage explicit workspace-relative paths for a future commit. Never stages the whole repository implicitly.",\n      parameters: {\n        type: "object",\n        properties: { paths: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } }, reason: { type: "string" } },\n        required: ["paths"],\n        additionalProperties: false,\n      },\n    },\n  },\n  {\n    type: "function",\n    function: {\n      name: "git_commit",\n      description: "Create a Git commit from currently staged changes. This tool never auto-stages files.",\n      parameters: {\n        type: "object",\n        properties: { message: { type: "string", minLength: 1, maxLength: 4000 }, reason: { type: "string" } },\n        required: ["message"],\n        additionalProperties: false,\n      },\n    },\n  },\n  {\n    type: "function",\n    function: {\n      name: "git_create_branch",\n      description: "Create and switch to a new Git branch after validating its ref name.",\n      parameters: {\n        type: "object",\n        properties: { name: { type: "string", minLength: 1, maxLength: 240 }, reason: { type: "string" } },\n        required: ["name"],\n        additionalProperties: false,\n      },\n    },\n  },\n  {\n    type: "function",\n    function: {\n      name: "git_remote_list",\n      description: "Read configured Git remotes without modifying the repository.",\n      parameters: { type: "object", properties: {}, additionalProperties: false },\n    },\n  },\n  {\n    type: "function",\n    function: {\n      name: "git_remote_add",\n      description: "Add a named Git remote. Requires approval because it changes repository routing to an external destination.",\n      parameters: {\n        type: "object",\n        properties: { remote: { type: "string", maxLength: 120 }, url: { type: "string", maxLength: 2048 }, reason: { type: "string" } },\n        required: ["remote", "url", "reason"],\n        additionalProperties: false,\n      },\n    },\n  },\n  {\n    type: "function",\n    function: {\n      name: "git_pull",\n      description: "Pull remote Git changes into a clean workspace. Defaults to --ff-only; rebase is available explicitly. Requires approval.",\n      parameters: {\n        type: "object",\n        properties: { remote: { type: "string", maxLength: 120 }, branch: { type: "string", maxLength: 240 }, strategy: { type: "string", enum: ["ff-only", "rebase"] }, reason: { type: "string" } },\n        required: ["reason"],\n        additionalProperties: false,\n      },\n    },\n  },\n  {\n    type: "function",\n    function: {\n      name: "git_push",\n      description: "Push the current or named branch to a remote. Force push is intentionally unsupported. Requires approval.",\n      parameters: {\n        type: "object",\n        properties: { remote: { type: "string", maxLength: 120 }, branch: { type: "string", maxLength: 240 }, set_upstream: { type: "boolean" }, reason: { type: "string" } },\n        required: ["reason"],\n        additionalProperties: false,\n      },\n    },\n  },\n  {\n    type: "function",\n    function: {\n      name: "github_repo_create",\n      description: "Create a GitHub repository from the current local Git workspace through authenticated GitHub CLI and attach it as a remote. Does not push commits automatically. Requires approval.",\n      parameters: {\n        type: "object",\n        properties: {\n          name: { type: "string", maxLength: 240, description: "Optional repository name or owner/name. Defaults to the workspace directory name." },\n          visibility: { type: "string", enum: ["private", "public", "internal"] },\n          description: { type: "string", maxLength: 500 },\n          remote: { type: "string", maxLength: 120 },\n          reason: { type: "string" },\n        },\n        required: ["reason"],\n        additionalProperties: false,\n      },\n    },\n  },\n  {\n    type: "function",\n    function: {\n      name: "github_pr_create",\n      description: "Create a GitHub pull request through the authenticated GitHub CLI. Requires approval and never exposes GitHub credentials to the model.",\n      parameters: {\n        type: "object",\n        properties: { title: { type: "string", minLength: 1, maxLength: 240 }, body: { type: "string", maxLength: 20000 }, base: { type: "string", maxLength: 240 }, head: { type: "string", maxLength: 240 }, draft: { type: "boolean" }, reason: { type: "string" } },\n        required: ["title", "reason"],\n        additionalProperties: false,\n      },\n    },\n  },\n  {\n    type: "function",\n    function: {\n      name: "github_pr_view",\n      description: "Read the current or numbered GitHub pull request through GitHub CLI.",\n      parameters: { type: "object", properties: { number: { type: "integer", minimum: 1 } }, additionalProperties: false },\n    },\n  },\n  {\n    type: "function",\n    function: {\n      name: "github_pr_checks",\n      description: "Read GitHub checks for the current or numbered pull request. A failing check is returned as evidence rather than treated as a tool failure.",\n      parameters: { type: "object", properties: { number: { type: "integer", minimum: 1 } }, additionalProperties: false },\n    },\n  },\n`;
  content = insertBefore(content, `  ...OFFICE_TOOL_DEFINITIONS,`, gitTools, "git/github tool block");
  content = replaceOnce(
    content,
    `  git_status: "read",\n  git_diff: "read",\n  inspect_office_file: "read",`,
    `  git_status: "read",\n  git_diff: "read",\n  git_log: "read",\n  git_init: "write",\n  git_stage: "write",\n  git_commit: "write",\n  git_create_branch: "write",\n  git_remote_list: "read",\n  git_remote_add: "control",\n  git_pull: "write",\n  git_push: "control",\n  github_repo_create: "control",\n  github_pr_create: "control",\n  github_pr_view: "read",\n  github_pr_checks: "read",\n  inspect_office_file: "read",`,
    "git risks",
  );
  content = replaceOnce(
    content,
    `  apply_patch: "write",\n  lsp: "read",\n  create_word_document: "write",`,
    `  apply_patch: "write",\n  lsp: "read",\n  lsp_install: "control",\n  create_word_document: "write",`,
    "lsp install risk",
  );
  await write("electron/runtime/native-tool-catalog.js", content);
}

// Native executor: merge #46 Git/GitHub execution and add repository bootstrap + LSP install.
{
  let content = await read("electron/runtime/native-tool-executor.js");
  content = replaceOnce(
    content,
    `import { executeBrowserTool, isBrowserToolName } from "../browser-runtime.js";`,
    `import { executeBrowserTool, isBrowserToolName } from "../browser-runtime.js";\nimport {\n  parseGitHubJson,\n  runGitHubCli as defaultRunGitHubCli,\n} from "./github-runtime.js";\nimport { installLanguageServer as defaultInstallLanguageServer } from "./lsp-installer.js";`,
    "executor imports",
  );
  content = insertBefore(
    content,
    `export function createNativeToolExecutor({`,
    `function normalizeGitPath(value) {\n  const path = String(value || "").trim().replace(/\\\\/g, "/").replace(/^\\.\\//, "");\n  if (!path || isAbsolute(path) || path.includes("\\0") || path.split("/").includes("..")) {\n    throw new Error(\`Unsafe Git path: \${path || "unknown"}\`);\n  }\n  return path;\n}\n\nfunction normalizeGitToken(value, label, fallback = "") {\n  const token = String(value || fallback).trim();\n  if (!token || token.startsWith("-") || !/^[A-Za-z0-9._\\/-]+$/.test(token)) {\n    throw new Error(\`Invalid \${label}.\`);\n  }\n  return token;\n}\n\nfunction normalizeGitRemoteUrl(value) {\n  const url = String(value || "").trim();\n  if (!url || url.length > 2048 || url.startsWith("-") || /[\\0\\r\\n]/.test(url)) {\n    throw new Error("Invalid Git remote URL.");\n  }\n  return url;\n}\n\nfunction normalizeGitHubRepoName(value) {\n  const name = String(value || "").trim();\n  if (!name) return "";\n  if (name.startsWith("-") || !/^[A-Za-z0-9_.-]+(?:\\/[A-Za-z0-9_.-]+)?$/.test(name)) {\n    throw new Error("Invalid GitHub repository name.");\n  }\n  return name;\n}\n\n`,
    "executor git helpers",
  );
  content = replaceOnce(
    content,
    `  runGitCommand,\n  limits = {},`,
    `  runGitCommand,\n  runGitHubCli = defaultRunGitHubCli,\n  installLanguageServer = defaultInstallLanguageServer,\n  limits = {},`,
    "executor injected runtimes",
  );
  content = replaceOnce(
    content,
    `    calculateLineChanges,\n    runGitCommand,\n  })) {`,
    `    calculateLineChanges,\n    runGitCommand,\n    runGitHubCli,\n    installLanguageServer,\n  })) {`,
    "executor runtime validation",
  );
  content = insertBefore(
    content,
    `    if (toolName === "run_command") {`,
    `    if (toolName === "lsp_install") {\n      return { modelResult: await installLanguageServer({ language: input.language, signal }) };\n    }\n\n`,
    "lsp install dispatch",
  );

  const workflowDispatch = `\n    if (toolName === "git_log") {\n      const maxCount = Math.max(1, Math.min(100, Number(input.max_count) || 20));\n      const result = await runGitCommand({ args: ["log", "--oneline", "--decorate", "--max-count=" + maxCount], cwd: workspaceRoot, signal });\n      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to read Git log.");\n      return { modelResult: { log: result.stdout.trim(), maxCount } };\n    }\n\n    if (toolName === "git_init") {\n      const existing = await runGitCommand({ args: ["rev-parse", "--is-inside-work-tree"], cwd: workspaceRoot, signal });\n      if (existing.exitCode === 0 && existing.stdout.trim() === "true") {\n        return { modelResult: { initialized: false, alreadyRepository: true } };\n      }\n      const initialBranch = normalizeGitToken(input.initial_branch, "initial branch", "main");\n      let result = await runGitCommand({ args: ["init", "-b", initialBranch], cwd: workspaceRoot, signal });\n      if (result.exitCode !== 0 && /unknown option|usage:/i.test(result.stderr)) {\n        result = await runGitCommand({ args: ["init"], cwd: workspaceRoot, signal });\n        if (result.exitCode === 0) {\n          const rename = await runGitCommand({ args: ["branch", "-M", initialBranch], cwd: workspaceRoot, signal });\n          if (rename.exitCode !== 0) throw new Error(rename.stderr.trim() || "Unable to set the initial Git branch.");\n        }\n      }\n      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to initialize Git repository.");\n      return { modelResult: { initialized: true, alreadyRepository: false, initialBranch, output: result.stdout.trim() || result.stderr.trim() } };\n    }\n\n    if (toolName === "git_stage") {\n      const paths = [...new Set((Array.isArray(input.paths) ? input.paths : []).map(normalizeGitPath))];\n      if (!paths.length) throw new Error("git_stage requires at least one explicit path.");\n      const staged = await runGitCommand({ args: ["add", "--", ...paths], cwd: workspaceRoot, signal });\n      if (staged.exitCode !== 0) throw new Error(staged.stderr.trim() || "Unable to stage Git paths.");\n      const summary = await runGitCommand({ args: ["diff", "--cached", "--name-status"], cwd: workspaceRoot, signal });\n      return { modelResult: { paths, staged: summary.stdout.trim() } };\n    }\n\n    if (toolName === "git_commit") {\n      const message = String(input.message || "").trim();\n      if (!message || message.length > 4_000) throw new Error("Commit message must be between 1 and 4000 characters.");\n      const stagedCheck = await runGitCommand({ args: ["diff", "--cached", "--quiet"], cwd: workspaceRoot, signal });\n      if (stagedCheck.exitCode === 0) throw new Error("No staged changes are available to commit. Use git_stage first.");\n      if (stagedCheck.exitCode !== 1) throw new Error(stagedCheck.stderr.trim() || "Unable to inspect staged changes.");\n      const result = await runGitCommand({ args: ["commit", "-m", message], cwd: workspaceRoot, signal });\n      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Git commit failed.");\n      return { modelResult: { committed: true, message, output: result.stdout.trim() || result.stderr.trim() } };\n    }\n\n    if (toolName === "git_create_branch") {\n      const name = normalizeGitToken(input.name, "branch name");\n      const check = await runGitCommand({ args: ["check-ref-format", "--branch", name], cwd: workspaceRoot, signal });\n      if (check.exitCode !== 0) throw new Error(check.stderr.trim() || "Invalid Git branch name.");\n      const result = await runGitCommand({ args: ["switch", "-c", name], cwd: workspaceRoot, signal });\n      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to create Git branch.");\n      return { modelResult: { created: true, branch: name, output: result.stdout.trim() || result.stderr.trim() } };\n    }\n\n    if (toolName === "git_remote_list") {\n      const result = await runGitCommand({ args: ["remote", "-v"], cwd: workspaceRoot, signal });\n      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to list Git remotes.");\n      return { modelResult: { remotes: result.stdout.trim() } };\n    }\n\n    if (toolName === "git_remote_add") {\n      const remote = normalizeGitToken(input.remote, "remote name");\n      const url = normalizeGitRemoteUrl(input.url);\n      const result = await runGitCommand({ args: ["remote", "add", remote, url], cwd: workspaceRoot, signal });\n      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to add Git remote.");\n      return { modelResult: { added: true, remote, url } };\n    }\n\n    if (toolName === "git_pull") {\n      const status = await runGitCommand({ args: ["status", "--porcelain"], cwd: workspaceRoot, signal });\n      if (status.exitCode !== 0) throw new Error(status.stderr.trim() || "Unable to inspect workspace before pull.");\n      if (status.stdout.trim()) throw new Error("git_pull requires a clean working tree. Commit or stash local changes first.");\n      const strategy = input.strategy === "rebase" ? "rebase" : "ff-only";\n      const args = ["pull", strategy === "rebase" ? "--rebase" : "--ff-only"];\n      if (input.remote) args.push(normalizeGitToken(input.remote, "remote name"));\n      if (input.branch) args.push(normalizeGitToken(input.branch, "branch name"));\n      const result = await runGitCommand({ args, cwd: workspaceRoot, signal });\n      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Git pull failed.");\n      return { modelResult: { pulled: true, strategy, output: result.stdout.trim() || result.stderr.trim() } };\n    }\n\n    if (toolName === "git_push") {\n      const remote = normalizeGitToken(input.remote, "remote name", "origin");\n      let branch = input.branch ? normalizeGitToken(input.branch, "branch name") : "";\n      if (!branch) {\n        const current = await runGitCommand({ args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: workspaceRoot, signal });\n        if (current.exitCode !== 0) throw new Error(current.stderr.trim() || "Unable to resolve current branch.");\n        branch = normalizeGitToken(current.stdout.trim(), "current branch");\n        if (branch === "HEAD") throw new Error("Cannot push from a detached HEAD without an explicit branch.");\n      }\n      const args = ["push", ...(input.set_upstream ? ["--set-upstream"] : []), remote, branch];\n      const result = await runGitCommand({ args, cwd: workspaceRoot, signal });\n      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Git push failed.");\n      return { modelResult: { pushed: true, remote, branch, setUpstream: Boolean(input.set_upstream), output: result.stdout.trim() || result.stderr.trim() } };\n    }\n\n    if (toolName === "github_repo_create") {\n      const inside = await runGitCommand({ args: ["rev-parse", "--is-inside-work-tree"], cwd: workspaceRoot, signal });\n      if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {\n        throw new Error("github_repo_create requires a local Git repository. Use git_init first.");\n      }\n      const name = normalizeGitHubRepoName(input.name);\n      const visibility = ["public", "internal"].includes(input.visibility) ? input.visibility : "private";\n      const remote = normalizeGitToken(input.remote, "remote name", "origin");\n      const description = String(input.description || "").trim();\n      const args = ["repo", "create"];\n      if (name) args.push(name);\n      args.push("--source", ".", `--${visibility}`, "--remote", remote);\n      if (description) args.push("--description", description.slice(0, 500));\n      const result = await runGitHubCli({ args, cwd: workspaceRoot, signal });\n      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "GitHub repository creation failed.");\n      const view = await runGitHubCli({ args: ["repo", "view", "--json", "nameWithOwner,url,visibility,defaultBranchRef"], cwd: workspaceRoot, signal });\n      return {\n        modelResult: {\n          created: true,\n          remote,\n          visibility,\n          repository: view.exitCode === 0 ? parseGitHubJson(view.stdout, "gh repo view") : null,\n          output: result.stdout.trim() || result.stderr.trim(),\n        },\n      };\n    }\n\n    if (toolName === "github_pr_create") {\n      const title = String(input.title || "").trim();\n      const body = String(input.body || "");\n      if (!title || title.length > 240 || body.length > 20_000) throw new Error("Invalid pull request title or body.");\n      const args = ["pr", "create", "--title", title, "--body", body];\n      if (input.base) args.push("--base", normalizeGitToken(input.base, "base branch"));\n      if (input.head) args.push("--head", normalizeGitToken(input.head, "head branch"));\n      if (input.draft) args.push("--draft");\n      const result = await runGitHubCli({ args, cwd: workspaceRoot, signal });\n      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "GitHub pull request creation failed.");\n      return { modelResult: { created: true, title, url: result.stdout.trim(), draft: Boolean(input.draft) } };\n    }\n\n    if (toolName === "github_pr_view") {\n      const args = ["pr", "view"];\n      if (Number.isInteger(input.number) && input.number > 0) args.push(String(input.number));\n      args.push("--json", "number,title,state,url,headRefName,baseRefName,isDraft,mergeable");\n      const result = await runGitHubCli({ args, cwd: workspaceRoot, signal });\n      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to read GitHub pull request.");\n      return { modelResult: { pullRequest: parseGitHubJson(result.stdout, "gh pr view") } };\n    }\n\n    if (toolName === "github_pr_checks") {\n      const args = ["pr", "checks"];\n      if (Number.isInteger(input.number) && input.number > 0) args.push(String(input.number));\n      const result = await runGitHubCli({ args, cwd: workspaceRoot, signal });\n      return { modelResult: { checks: result.stdout.trim(), diagnostics: result.stderr.trim(), exitCode: result.exitCode, passing: result.exitCode === 0 } };\n    }\n\n`;
  content = insertBefore(content, `    throw new Error(\`Unsupported tool: \${toolName}\`);`, workflowDispatch, "git/github executor dispatch");
  await write("electron/runtime/native-tool-executor.js", content);
}

// LSP runtime: prefer managed/toolchain installations and expose real availability in status.
{
  let content = await read("electron/runtime/lsp-runtime.js");
  content = replaceOnce(
    content,
    `import { createHostFallbackEnvironment } from "../sandbox-runtime.js";`,
    `import { createHostFallbackEnvironment } from "../sandbox-runtime.js";\nimport { describeLanguageServers, resolveLanguageServerCommand } from "./lsp-installer.js";`,
    "lsp installer import",
  );
  for (const [language, oldBlock, args] of [
    ["python", `    command: () => ({\n      program: "pyright-langserver",\n      args: ["--stdio"],\n      env: createHostFallbackEnvironment(process.env, "lsp-server"),\n      source: "path",\n    }),`, `["--stdio"]`],
    ["rust", `    command: () => ({\n      program: "rust-analyzer",\n      args: [],\n      env: createHostFallbackEnvironment(process.env, "lsp-server"),\n      source: "path",\n    }),`, `[]`],
    ["go", `    command: () => ({\n      program: "gopls",\n      args: ["serve"],\n      env: createHostFallbackEnvironment(process.env, "lsp-server"),\n      source: "path",\n    }),`, `["serve"]`],
    ["clangd", `    command: () => ({\n      program: "clangd",\n      args: ["--background-index"],\n      env: createHostFallbackEnvironment(process.env, "lsp-server"),\n      source: "path",\n    }),`, `["--background-index"]`],
  ]) {
    content = replaceOnce(content, oldBlock, `    command: () => externalLanguageServerCommand("${language}", ${args}),`, `lsp ${language} command`);
  }
  content = insertBefore(
    content,
    `function createAbortError() {`,
    `function externalLanguageServerCommand(language, args) {\n  const resolved = resolveLanguageServerCommand(language, args);\n  if (!resolved) {\n    throw new Error(\`Language server for \${language} is not installed. Use lsp_install to install it.\`);\n  }\n  return {\n    program: resolved.program,\n    args: resolved.args,\n    env: {\n      ...createHostFallbackEnvironment(process.env, "lsp-server"),\n      ...(resolved.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),\n    },\n    source: resolved.source,\n  };\n}\n\n`,
    "lsp external resolver",
  );
  content = replaceOnce(
    content,
    `          supported: LANGUAGE_SPECS.map((spec) => ({\n            id: spec.id,\n            extensions: [...spec.extensions],\n            bundled: spec.id === "typescript",\n          })),`,
    `          supported: (() => {\n            const availability = new Map(describeLanguageServers().map((item) => [item.id, item]));\n            return LANGUAGE_SPECS.map((spec) => {\n              if (spec.id === "typescript") {\n                return {\n                  id: spec.id,\n                  extensions: [...spec.extensions],\n                  bundled: true,\n                  available: true,\n                  source: "bundled",\n                  installable: false,\n                  installer: null,\n                };\n              }\n              return {\n                id: spec.id,\n                extensions: [...spec.extensions],\n                bundled: false,\n                ...(availability.get(spec.id) || { available: false, installable: true }),\n              };\n            });\n          })(),`,
    "lsp status availability",
  );
  await write("electron/runtime/lsp-runtime.js", content);
}

// Tell the model that it can bootstrap Git itself and install missing LSP servers.
{
  let content = await read("electron/agent-runtime-core.js");
  content = replaceOnce(
    content,
    `        "Use the native lsp tool for semantic diagnostics, definitions, references, hover, and symbols when the file type has a configured language server. After code edits, prefer LSP diagnostics as a fast inner-loop signal, but still use build/tests for final verification.",`,
    `        "Use the native lsp tool for semantic diagnostics, definitions, references, hover, and symbols when the file type has a configured language server. If lsp status reports a missing supported server and semantic analysis is useful, use lsp_install with approval instead of telling the user to install it manually. After code edits, prefer LSP diagnostics as a fast inner-loop signal, but still use build/tests for final verification.",\n        "For Git/GitHub work, use native Git tools end-to-end. If the workspace is not a Git repository, use git_init instead of asking the user to run git init. Local init/stage/commit/branch operations may proceed automatically when policy allows; adding remotes, pulling, pushing, creating GitHub repositories, and creating PRs must respect approval boundaries.",`,
    "agent workflow guidance",
  );
  await write("electron/agent-runtime-core.js", content);
}

// Update package metadata/scripts for the integrated v0.6.5 test branch.
{
  const packageJson = JSON.parse(await read("package.json"));
  packageJson.version = "0.6.5";
  packageJson.engines = { ...(packageJson.engines || {}), node: ">=22.12.0" };
  packageJson.scripts["test:github-workflow"] = "node tests/github-workflow-smoke.mjs";
  packageJson.scripts["test:lsp-installer"] = "node tests/lsp-installer-smoke.mjs";
  await write("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
}

// CI runs both formerly-separate capabilities together on the Node version required by current Electron tooling.
{
  let content = await read(".github/workflows/ci.yml");
  content = content.replace("node-version: 20", "node-version: 22.12.0");
  content = replaceOnce(
    content,
    `      - name: LSP smoke\n        run: npm run test:lsp\n\n      - name: Tool permission smoke`,
    `      - name: LSP smoke\n        run: npm run test:lsp\n\n      - name: LSP installer smoke\n        run: npm run test:lsp-installer\n\n      - name: GitHub workflow smoke\n        run: npm run test:github-workflow\n\n      - name: Tool permission smoke`,
    "integrated CI steps",
  );
  await write(".github/workflows/ci.yml", content);
}

// Update the existing GitHub workflow smoke for autonomous local Git + remote bootstrap.
{
  let content = await read("tests/github-workflow-smoke.mjs");
  content = content.replace(`assert.equal(getToolPermission(workspacePolicy, "git_stage"), "ask");`, `assert.equal(getToolPermission(workspacePolicy, "git_stage"), "allow");`);
  content = content.replace(`assert.equal(getToolPermission(workspacePolicy, "git_commit"), "ask");`, `assert.equal(getToolPermission(workspacePolicy, "git_commit"), "allow");`);
  content = content.replace(
    `assert.equal(getToolPermission(workspacePolicy, "git_pull"), "ask");`,
    `assert.equal(getToolPermission(workspacePolicy, "git_init"), "allow");\nassert.equal(getToolPermission(workspacePolicy, "git_create_branch"), "allow");\nassert.equal(getToolPermission(workspacePolicy, "git_remote_list"), "allow");\nassert.equal(getToolPermission(workspacePolicy, "git_remote_add"), "ask");\nassert.equal(getToolPermission(workspacePolicy, "git_pull"), "ask");`,
  );
  content = content.replace(
    `assert.equal(getToolPermission(workspacePolicy, "github_pr_create"), "ask");`,
    `assert.equal(getToolPermission(workspacePolicy, "github_repo_create"), "ask");\nassert.equal(getToolPermission(workspacePolicy, "github_pr_create"), "ask");`,
  );
  content = content.replace(
    `for (const name of ["git_log", "git_stage", "git_commit", "git_create_branch", "git_pull", "git_push", "github_pr_create", "github_pr_view", "github_pr_checks"]) {`,
    `for (const name of ["git_log", "git_init", "git_stage", "git_commit", "git_create_branch", "git_remote_list", "git_remote_add", "git_pull", "git_push", "github_repo_create", "github_pr_create", "github_pr_view", "github_pr_checks"]) {`,
  );
  content = replaceOnce(
    content,
    `  if (key === "diff --cached --quiet") return { exitCode: 1, stdout: "", stderr: "" };`,
    `  if (key === "rev-parse --is-inside-work-tree") return { exitCode: 0, stdout: "true\\n", stderr: "" };\n  if (key === "diff --cached --quiet") return { exitCode: 1, stdout: "", stderr: "" };\n  if (key === "remote -v") return { exitCode: 0, stdout: "origin\\thttps://example.invalid/repo.git (fetch)\\n", stderr: "" };`,
    "github smoke git bootstrap mocks",
  );
  content = replaceOnce(
    content,
    `  if (args.includes("--json")) {\n    return { exitCode: 0, stdout: JSON.stringify({ number: 45, title: "Test", state: "OPEN", url: "https://example.invalid/pr/45" }), stderr: "" };\n  }\n  if (args[1] === "create") return { exitCode: 0, stdout: "https://example.invalid/pr/46\\n", stderr: "" };`,
    `  if (args[0] === "repo" && args[1] === "view") {\n    return { exitCode: 0, stdout: JSON.stringify({ nameWithOwner: "demo/repo", url: "https://example.invalid/demo/repo", visibility: "PRIVATE" }), stderr: "" };\n  }\n  if (args[0] === "repo" && args[1] === "create") return { exitCode: 0, stdout: "https://example.invalid/demo/repo\\n", stderr: "" };\n  if (args.includes("--json")) {\n    return { exitCode: 0, stdout: JSON.stringify({ number: 45, title: "Test", state: "OPEN", url: "https://example.invalid/pr/45" }), stderr: "" };\n  }\n  if (args[0] === "pr" && args[1] === "create") return { exitCode: 0, stdout: "https://example.invalid/pr/46\\n", stderr: "" };`,
    "github smoke gh mocks",
  );
  content = replaceOnce(
    content,
    `await invoke("git_stage", { paths: ["src/a.js"] });`,
    `const initialized = await invoke("git_init", { initial_branch: "main" });\nassert.equal(initialized.modelResult.alreadyRepository, true);\nconst remotes = await invoke("git_remote_list", {});\nassert.match(remotes.modelResult.remotes, /origin/);\nawait invoke("git_remote_add", { remote: "upstream", url: "https://example.invalid/upstream.git" });\nawait invoke("git_stage", { paths: ["src/a.js"] });`,
    "github smoke local bootstrap invokes",
  );
  content = replaceOnce(
    content,
    `const created = await invoke("github_pr_create", { title: "Test PR", body: "Body", draft: true });`,
    `const repository = await invoke("github_repo_create", { name: "demo/repo", visibility: "private", remote: "origin" });\nassert.equal(repository.modelResult.created, true);\nconst created = await invoke("github_pr_create", { title: "Test PR", body: "Body", draft: true });`,
    "github smoke repo create invoke",
  );
  await write("tests/github-workflow-smoke.mjs", content);
}

await write(
  "tests/lsp-installer-smoke.mjs",
  `import assert from "node:assert/strict";\nimport { mkdtemp, rm } from "node:fs/promises";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\n\nconst home = await mkdtemp(join(tmpdir(), "aporiax-lsp-install-smoke-"));\nprocess.env.APORIAX_LSP_HOME = home;\nconst {\n  describeLanguageServers,\n  getLanguageServerHome,\n  getLanguageServerInstallPlan,\n} = await import("../electron/runtime/lsp-installer.js?smoke=" + Date.now());\n\ntry {\n  assert.equal(getLanguageServerHome(), home);\n  const python = getLanguageServerInstallPlan("python");\n  assert.equal(python.language, "python");\n  assert.equal(python.installer, "npm");\n  assert.equal(python.managed, true);\n  assert.ok(python.args.includes("pyright@latest"));\n\n  const go = getLanguageServerInstallPlan("go");\n  assert.equal(go.installer, "go");\n  assert.equal(go.managed, true);\n  assert.match(go.env.GOBIN, /language|lsp|go|aporiax/i);\n\n  const rust = getLanguageServerInstallPlan("rust");\n  assert.equal(rust.installer, "rustup");\n\n  const clangd = getLanguageServerInstallPlan("clangd");\n  assert.ok(["winget", "brew", "apt-get"].includes(clangd.installer));\n\n  const status = describeLanguageServers();\n  assert.equal(status.length, 4);\n  assert.ok(status.every((item) => item.installable));\n} finally {\n  await rm(home, { recursive: true, force: true });\n}\n\nconsole.log("lsp installer smoke: PASS");\n`,
);

// Make LSP smoke assert that status advertises installability instead of only hard-coded support.
{
  let content = await read("tests/lsp-runtime-smoke.mjs");
  content = replaceOnce(
    content,
    `  assert.ok(initial.supported.some((server) => server.id === "typescript" && server.bundled));`,
    `  assert.ok(initial.supported.some((server) => server.id === "typescript" && server.bundled && server.available));\n  assert.ok(initial.supported.some((server) => server.id === "python" && server.installable));`,
    "lsp status smoke",
  );
  await write("tests/lsp-runtime-smoke.mjs", content);
}

await write(
  "docs/releases/v0.6.5-integrated-workflows.md",
  `# v0.6.5 integrated workflows\n\nThis integration branch replaces the separate GitHub-workflow and LSP test branches with one end-to-end candidate.\n\n## Managed language intelligence\n\n- TypeScript/JavaScript remains bundled.\n- Python can be installed by AporiaX into managed storage with Pyright.\n- Go can be installed into managed storage with gopls.\n- Rust can be installed through rustup.\n- C/C++ clangd can be installed through winget on Windows, Homebrew on macOS, or apt-get on Linux.\n- lsp status reports availability/source/installer, and lsp_install is an explicit approval boundary for network/dependency mutation.\n\n## Complete GitHub Agent workflow\n\nAporiaX can now progress from an ordinary workspace folder to a reviewable GitHub PR without asking the user to manually bootstrap Git:\n\n1. git_init\n2. explicit git_stage\n3. git_commit\n4. git_create_branch\n5. git_remote_list / approved git_remote_add\n6. approved github_repo_create when a remote repository does not exist\n7. approved git_push\n8. approved github_pr_create\n9. github_pr_view / github_pr_checks\n\nLocal repository operations are autonomous under workspace-write policy. External routing and remote writes remain approval-gated. Force push remains intentionally unsupported.\n`,
);

console.log("v0.6.5 integration patch applied");
