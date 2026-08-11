import { readFile, writeFile } from "node:fs/promises";

async function edit(path, transform) {
  const before = await readFile(path, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`Patch produced no change: ${path}`);
  await writeFile(path, after, "utf8");
}

function replaceOnce(content, before, after, label) {
  const first = content.indexOf(before);
  if (first < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (content.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Ambiguous patch anchor: ${label}`);
  }
  return content.slice(0, first) + after + content.slice(first + before.length);
}

function replaceExactCount(content, before, after, expected, label) {
  let count = 0;
  let cursor = 0;
  while ((cursor = content.indexOf(before, cursor)) >= 0) {
    count += 1;
    cursor += before.length;
  }
  if (count !== expected) throw new Error(`${label}: expected ${expected} anchors, found ${count}`);
  return content.split(before).join(after);
}

const gitDefinitions = `  {
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
`;

await edit("electron/agent-core.js", (content) => {
  content = replaceOnce(
    content,
    '    git_status: "allow",\n    git_diff: "allow",\n    inspect_office_file: "allow",',
    '    git_status: "allow",\n    git_diff: "allow",\n    git_log: "allow",\n    github_pr_view: "allow",\n    github_pr_checks: "allow",\n    inspect_office_file: "allow",',
    "read-only git/github permissions",
  );
  content = replaceOnce(
    content,
    '    git_status: "allow",\n    git_diff: "allow",\n    write_file: "allow",',
    '    git_status: "allow",\n    git_diff: "allow",\n    git_log: "allow",\n    git_stage: "ask",\n    git_commit: "ask",\n    git_create_branch: "ask",\n    git_pull: "ask",\n    git_push: "ask",\n    github_pr_create: "ask",\n    github_pr_view: "allow",\n    github_pr_checks: "allow",\n    write_file: "allow",',
    "workspace git/github permissions",
  );
  content = replaceOnce(
    content,
    '    git_status: "allow",\n    git_diff: "allow",\n    update_plan: "allow",',
    '    git_status: "allow",\n    git_diff: "allow",\n    git_log: "allow",\n    update_plan: "allow",',
    "builder read git permission",
  );
  return content;
});

await edit("electron/runtime/native-tool-catalog.js", (content) => {
  content = replaceOnce(
    content,
    '  ...OFFICE_TOOL_DEFINITIONS,',
    `${gitDefinitions}  ...OFFICE_TOOL_DEFINITIONS,`,
    "git/github tool definitions",
  );
  content = replaceOnce(
    content,
    '  git_status: "read",\n  git_diff: "read",\n  inspect_office_file: "read",',
    '  git_status: "read",\n  git_diff: "read",\n  git_log: "read",\n  git_stage: "write",\n  git_commit: "write",\n  git_create_branch: "write",\n  git_pull: "write",\n  git_push: "control",\n  github_pr_create: "control",\n  github_pr_view: "read",\n  github_pr_checks: "read",\n  inspect_office_file: "read",',
    "git/github tool risks",
  );
  return content;
});

await edit("electron/runtime/native-tool-executor.js", (content) => {
  content = replaceOnce(
    content,
    'import { executeBrowserTool, isBrowserToolName } from "../browser-runtime.js";\n',
    'import { executeBrowserTool, isBrowserToolName } from "../browser-runtime.js";\nimport {\n  parseGitHubJson,\n  runGitHubCli as defaultRunGitHubCli,\n} from "./github-runtime.js";\n',
    "github runtime import",
  );
  content = replaceOnce(
    content,
    'function unifiedPatchPath(filePatch) {\n  const value = filePatch?.newFileName && filePatch.newFileName !== "/dev/null"\n    ? filePatch.newFileName\n    : filePatch?.oldFileName;\n  return String(value || "").replace(/^[ab][\\\\/]/, "").replace(/\\\\/g, "/");\n}\n',
    'function unifiedPatchPath(filePatch) {\n  const value = filePatch?.newFileName && filePatch.newFileName !== "/dev/null"\n    ? filePatch.newFileName\n    : filePatch?.oldFileName;\n  return String(value || "").replace(/^[ab][\\\\/]/, "").replace(/\\\\/g, "/");\n}\n\nfunction normalizeGitPath(value) {\n  const path = String(value || "").trim().replace(/\\\\/g, "/").replace(/^\\.\\//, "");\n  if (!path || isAbsolute(path) || path.includes("\\0") || path.split("/").includes("..")) {\n    throw new Error(`Unsafe Git path: ${path || "unknown"}`);\n  }\n  return path;\n}\n\nfunction normalizeGitToken(value, label, fallback = "") {\n  const token = String(value || fallback).trim();\n  if (!token || token.startsWith("-") || !/^[A-Za-z0-9._\\/-]+$/.test(token)) {\n    throw new Error(`Invalid ${label}.`);\n  }\n  return token;\n}\n',
    "git input helpers",
  );
  content = replaceOnce(
    content,
    '  runGitCommand,\n  limits = {},',
    '  runGitCommand,\n  runGitHubCli = defaultRunGitHubCli,\n  limits = {},',
    "github executor dependency",
  );
  content = replaceOnce(
    content,
    '    runGitCommand,\n  })) {',
    '    runGitCommand,\n    runGitHubCli,\n  })) {',
    "github executor validation",
  );
  const handlers = `
    if (toolName === "git_log") {
      const maxCount = Math.max(1, Math.min(100, Number(input.max_count) || 20));
      const result = await runGitCommand({
        args: ["log", "--oneline", "--decorate", `--max-count=${maxCount}`],
        cwd: workspaceRoot,
        signal,
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to read Git log.");
      return { modelResult: { log: result.stdout.trim(), maxCount } };
    }

    if (toolName === "git_stage") {
      const paths = [...new Set((Array.isArray(input.paths) ? input.paths : []).map(normalizeGitPath))];
      if (!paths.length) throw new Error("git_stage requires at least one explicit path.");
      const staged = await runGitCommand({ args: ["add", "--", ...paths], cwd: workspaceRoot, signal });
      if (staged.exitCode !== 0) throw new Error(staged.stderr.trim() || "Unable to stage Git paths.");
      const summary = await runGitCommand({ args: ["diff", "--cached", "--name-status"], cwd: workspaceRoot, signal });
      return { modelResult: { paths, staged: summary.stdout.trim() } };
    }

    if (toolName === "git_commit") {
      const message = String(input.message || "").trim();
      if (!message || message.length > 4_000) throw new Error("Commit message must be between 1 and 4000 characters.");
      const stagedCheck = await runGitCommand({ args: ["diff", "--cached", "--quiet"], cwd: workspaceRoot, signal });
      if (stagedCheck.exitCode === 0) throw new Error("No staged changes are available to commit. Use git_stage first.");
      if (stagedCheck.exitCode !== 1) throw new Error(stagedCheck.stderr.trim() || "Unable to inspect staged changes.");
      const result = await runGitCommand({ args: ["commit", "-m", message], cwd: workspaceRoot, signal });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Git commit failed.");
      return { modelResult: { committed: true, message, output: result.stdout.trim() || result.stderr.trim() } };
    }

    if (toolName === "git_create_branch") {
      const name = normalizeGitToken(input.name, "branch name");
      const check = await runGitCommand({ args: ["check-ref-format", "--branch", name], cwd: workspaceRoot, signal });
      if (check.exitCode !== 0) throw new Error(check.stderr.trim() || "Invalid Git branch name.");
      const result = await runGitCommand({ args: ["switch", "-c", name], cwd: workspaceRoot, signal });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to create Git branch.");
      return { modelResult: { created: true, branch: name, output: result.stdout.trim() || result.stderr.trim() } };
    }

    if (toolName === "git_pull") {
      const status = await runGitCommand({ args: ["status", "--porcelain"], cwd: workspaceRoot, signal });
      if (status.exitCode !== 0) throw new Error(status.stderr.trim() || "Unable to inspect workspace before pull.");
      if (status.stdout.trim()) throw new Error("git_pull requires a clean working tree. Commit or stash local changes first.");
      const strategy = input.strategy === "rebase" ? "rebase" : "ff-only";
      const args = ["pull", strategy === "rebase" ? "--rebase" : "--ff-only"];
      if (input.remote) args.push(normalizeGitToken(input.remote, "remote name"));
      if (input.branch) args.push(normalizeGitToken(input.branch, "branch name"));
      const result = await runGitCommand({ args, cwd: workspaceRoot, signal });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Git pull failed.");
      return { modelResult: { pulled: true, strategy, output: result.stdout.trim() || result.stderr.trim() } };
    }

    if (toolName === "git_push") {
      const remote = normalizeGitToken(input.remote, "remote name", "origin");
      let branch = input.branch ? normalizeGitToken(input.branch, "branch name") : "";
      if (!branch) {
        const current = await runGitCommand({ args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: workspaceRoot, signal });
        if (current.exitCode !== 0) throw new Error(current.stderr.trim() || "Unable to resolve current branch.");
        branch = normalizeGitToken(current.stdout.trim(), "current branch");
        if (branch === "HEAD") throw new Error("Cannot push from a detached HEAD without an explicit branch.");
      }
      const args = ["push", ...(input.set_upstream ? ["--set-upstream"] : []), remote, branch];
      const result = await runGitCommand({ args, cwd: workspaceRoot, signal });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Git push failed.");
      return { modelResult: { pushed: true, remote, branch, setUpstream: Boolean(input.set_upstream), output: result.stdout.trim() || result.stderr.trim() } };
    }

    if (toolName === "github_pr_create") {
      const title = String(input.title || "").trim();
      const body = String(input.body || "");
      if (!title || title.length > 240 || body.length > 20_000) throw new Error("Invalid pull request title or body.");
      const args = ["pr", "create", "--title", title, "--body", body];
      if (input.base) args.push("--base", normalizeGitToken(input.base, "base branch"));
      if (input.head) args.push("--head", normalizeGitToken(input.head, "head branch"));
      if (input.draft) args.push("--draft");
      const result = await runGitHubCli({ args, cwd: workspaceRoot, signal });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "GitHub pull request creation failed.");
      return { modelResult: { created: true, title, url: result.stdout.trim(), draft: Boolean(input.draft) } };
    }

    if (toolName === "github_pr_view") {
      const args = ["pr", "view"];
      if (Number.isInteger(input.number) && input.number > 0) args.push(String(input.number));
      args.push("--json", "number,title,state,url,headRefName,baseRefName,isDraft,mergeable");
      const result = await runGitHubCli({ args, cwd: workspaceRoot, signal });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to read GitHub pull request.");
      return { modelResult: { pullRequest: parseGitHubJson(result.stdout, "gh pr view") } };
    }

    if (toolName === "github_pr_checks") {
      const args = ["pr", "checks"];
      if (Number.isInteger(input.number) && input.number > 0) args.push(String(input.number));
      const result = await runGitHubCli({ args, cwd: workspaceRoot, signal });
      return { modelResult: { checks: result.stdout.trim(), diagnostics: result.stderr.trim(), exitCode: result.exitCode, passing: result.exitCode === 0 } };
    }
`;
  content = replaceOnce(
    content,
    '    throw new Error(`Unsupported tool: ${toolName}`);',
    `${handlers}\n    throw new Error(\`Unsupported tool: \${toolName}\`);`,
    "git/github executor handlers",
  );
  return content;
});

await edit("electron/runtime/tool-permissions.js", (content) => {
  content = replaceOnce(
    content,
    '  const commandPolicy = permissionDecision?.commandPolicy || null;\n  return {',
    '  const commandPolicy = permissionDecision?.commandPolicy || null;\n  const approvalTitles = {\n    git_stage: "暂存 Git 变更",\n    git_commit: "创建 Git Commit",\n    git_create_branch: "创建 Git 分支",\n    git_pull: "拉取远程 Git 变更",\n    git_push: "推送 Git 分支",\n    github_pr_create: "创建 GitHub Pull Request",\n  };\n  return {',
    "approval title map",
  );
  content = replaceOnce(
    content,
    '          : toolName === "read_external_file"\n            ? "读取工作区外文件"\n            : `允许工具：${toolName || "unknown"}`,',
    '          : toolName === "read_external_file"\n            ? "读取工作区外文件"\n            : approvalTitles[toolName] || `允许工具：${toolName || "unknown"}`,',
    "git github approval titles",
  );
  return content;
});

await edit("package.json", (content) =>
  replaceOnce(
    content,
    '    "test:execution-wiring": "node tests/execution-mode-wiring-smoke.mjs",\n    "test:tool-permissions": "node tests/tool-permissions-smoke.mjs",',
    '    "test:execution-wiring": "node tests/execution-mode-wiring-smoke.mjs",\n    "test:github-workflow": "node tests/github-workflow-smoke.mjs",\n    "test:tool-permissions": "node tests/tool-permissions-smoke.mjs",',
    "github workflow test script",
  ),
);

await edit(".github/workflows/ci.yml", (content) =>
  replaceOnce(
    content,
    '      - name: Tool permission smoke\n        run: npm run test:tool-permissions',
    '      - name: GitHub workflow smoke\n        run: npm run test:github-workflow\n\n      - name: Tool permission smoke\n        run: npm run test:tool-permissions',
    "github workflow CI step",
  ),
);

await writeFile(
  "tests/github-workflow-smoke.mjs",
  `import assert from "node:assert/strict";\nimport { createPermissionPolicy, getToolPermission } from "../electron/agent-core.js";\nimport { createNativeToolExecutor } from "../electron/runtime/native-tool-executor.js";\nimport { TOOL_REGISTRY } from "../electron/runtime/native-tool-catalog.js";\n\nconst workspacePolicy = createPermissionPolicy("workspace-write");\nassert.equal(getToolPermission(workspacePolicy, "git_log"), "allow");\nassert.equal(getToolPermission(workspacePolicy, "git_stage"), "ask");\nassert.equal(getToolPermission(workspacePolicy, "git_commit"), "ask");\nassert.equal(getToolPermission(workspacePolicy, "git_pull"), "ask");\nassert.equal(getToolPermission(workspacePolicy, "git_push"), "ask");\nassert.equal(getToolPermission(workspacePolicy, "github_pr_create"), "ask");\nassert.equal(getToolPermission(workspacePolicy, "github_pr_view"), "allow");\nassert.equal(getToolPermission(createPermissionPolicy("builder-write"), "git_push"), "deny");\nfor (const name of ["git_log", "git_stage", "git_commit", "git_create_branch", "git_pull", "git_push", "github_pr_create", "github_pr_view", "github_pr_checks"]) {\n  assert.ok(TOOL_REGISTRY.get(name), \`missing tool: \${name}\`);\n}\n\nconst gitCalls = [];\nconst ghCalls = [];\nconst runGitCommand = async ({ args }) => {\n  gitCalls.push(args);\n  const key = args.join(" ");\n  if (key === "diff --cached --quiet") return { exitCode: 1, stdout: "", stderr: "" };\n  if (key === "status --porcelain") return { exitCode: 0, stdout: "", stderr: "" };\n  if (key === "rev-parse --abbrev-ref HEAD") return { exitCode: 0, stdout: "feature\\n", stderr: "" };\n  if (key.startsWith("check-ref-format")) return { exitCode: 0, stdout: "", stderr: "" };\n  if (key.startsWith("diff --cached --name-status")) return { exitCode: 0, stdout: "M\\tsrc/a.js\\n", stderr: "" };\n  return { exitCode: 0, stdout: "ok\\n", stderr: "" };\n};\nconst runGitHubCli = async ({ args }) => {\n  ghCalls.push(args);\n  if (args.includes("--json")) {\n    return { exitCode: 0, stdout: JSON.stringify({ number: 45, title: "Test", state: "OPEN", url: "https://example.invalid/pr/45" }), stderr: "" };\n  }\n  if (args[1] === "create") return { exitCode: 0, stdout: "https://example.invalid/pr/46\\n", stderr: "" };\n  return { exitCode: 0, stdout: "CI pass\\n", stderr: "" };\n};\n\nconst executor = createNativeToolExecutor({\n  verifyExistingTarget: async (_root, path) => path,\n  verifyWritableTarget: async (_root, path) => path,\n  searchWorkspaceText: async () => ({}),\n  calculateLineChanges: () => ({ additions: 0, deletions: 0 }),\n  runGitCommand,\n  runGitHubCli,\n});\nconst invoke = (toolName, input) => executor({\n  toolCall: { function: { name: toolName } },\n  toolName,\n  input,\n  workspaceRoot: "/workspace",\n  signal: undefined,\n});\n\nawait invoke("git_stage", { paths: ["src/a.js"] });\nawait invoke("git_commit", { message: "test commit" });\nawait invoke("git_create_branch", { name: "feature/test" });\nawait invoke("git_pull", { strategy: "ff-only" });\nconst pushed = await invoke("git_push", { remote: "origin", set_upstream: true });\nassert.equal(pushed.modelResult.branch, "feature");\nconst created = await invoke("github_pr_create", { title: "Test PR", body: "Body", draft: true });\nassert.equal(created.modelResult.created, true);\nconst viewed = await invoke("github_pr_view", { number: 45 });\nassert.equal(viewed.modelResult.pullRequest.number, 45);\nconst checks = await invoke("github_pr_checks", { number: 45 });\nassert.equal(checks.modelResult.passing, true);\nassert.ok(gitCalls.some((args) => args[0] === "push"));\nassert.ok(ghCalls.some((args) => args[0] === "pr" && args[1] === "create"));\n\nconsole.log("github workflow smoke: PASS");\n`,
  "utf8",
);

await edit("docs/releases/v0.6.5.md", (content) =>
  replaceOnce(
    content,
    'The remaining 0.6.5 work should land as reviewable follow-up PRs:\n\n1. add native Git write operations and GitHub branch/commit/push/pull/PR/CI capabilities behind the permission engine;\n2. add a persistent LSP manager with diagnostics, definition, references, hover, document symbols, and workspace symbols;',
    'The Git/GitHub workflow slice adds structured native tools for recent history, explicit staging, commit, branch creation, clean-tree pull, non-force push, PR creation/view, and PR checks. Remote writes stay approval-gated; Builders cannot push or create PRs; GitHub credentials remain inside the user-authenticated gh process rather than entering model context.\n\nThe remaining 0.6.5 work should land as reviewable follow-up PRs:\n\n1. add a persistent LSP manager with diagnostics, definition, references, hover, document symbols, and workspace symbols;',
    "release github slice status",
  ),
);

console.log("v0.6.5 GitHub workflow patch applied");
