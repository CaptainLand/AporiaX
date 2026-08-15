import assert from "node:assert/strict";
import { createPermissionPolicy, getToolPermission } from "../electron/agent-core.js";
import { createNativeToolExecutor } from "../electron/runtime/native-tool-executor.js";
import { TOOL_REGISTRY } from "../electron/runtime/native-tool-catalog.js";

const workspacePolicy = createPermissionPolicy("workspace-write");
assert.equal(getToolPermission(workspacePolicy, "git_log"), "allow");
assert.equal(getToolPermission(workspacePolicy, "git_stage"), "allow");
assert.equal(getToolPermission(workspacePolicy, "git_commit"), "allow");
assert.equal(getToolPermission(workspacePolicy, "git_init"), "allow");
assert.equal(getToolPermission(workspacePolicy, "git_create_branch"), "allow");
assert.equal(getToolPermission(workspacePolicy, "git_remote_list"), "allow");
assert.equal(getToolPermission(workspacePolicy, "git_remote_add"), "allow");
assert.equal(getToolPermission(workspacePolicy, "git_pull"), "allow");
assert.equal(getToolPermission(workspacePolicy, "git_push"), "allow");
assert.equal(getToolPermission(workspacePolicy, "github_repo_create"), "ask");
assert.equal(getToolPermission(workspacePolicy, "github_pr_create"), "allow");
assert.equal(getToolPermission(workspacePolicy, "github_pr_view"), "allow");
assert.equal(getToolPermission(createPermissionPolicy("builder-write"), "git_push"), "deny");
for (const name of ["git_log", "git_init", "git_stage", "git_commit", "git_create_branch", "git_remote_list", "git_remote_add", "git_pull", "git_push", "github_repo_create", "github_pr_create", "github_pr_view", "github_pr_checks"]) {
  assert.ok(TOOL_REGISTRY.get(name), `missing tool: ${name}`);
}

const gitCalls = [];
const ghCalls = [];
const runGitCommand = async ({ args }) => {
  gitCalls.push(args);
  const key = args.join(" ");
  if (key === "rev-parse --is-inside-work-tree") return { exitCode: 0, stdout: "true\n", stderr: "" };
  if (key === "diff --cached --quiet") return { exitCode: 1, stdout: "", stderr: "" };
  if (key === "remote -v") return { exitCode: 0, stdout: "origin\thttps://example.invalid/repo.git (fetch)\n", stderr: "" };
  if (key === "status --porcelain") return { exitCode: 0, stdout: "", stderr: "" };
  if (key === "rev-parse --abbrev-ref HEAD") return { exitCode: 0, stdout: "feature\n", stderr: "" };
  if (key.startsWith("check-ref-format")) return { exitCode: 0, stdout: "", stderr: "" };
  if (key.startsWith("diff --cached --name-status")) return { exitCode: 0, stdout: "M\tsrc/a.js\n", stderr: "" };
  return { exitCode: 0, stdout: "ok\n", stderr: "" };
};
const runGitHubCli = async ({ args }) => {
  ghCalls.push(args);
  if (args[0] === "repo" && args[1] === "view") {
    return { exitCode: 0, stdout: JSON.stringify({ nameWithOwner: "demo/repo", url: "https://example.invalid/demo/repo", visibility: "PRIVATE" }), stderr: "" };
  }
  if (args[0] === "repo" && args[1] === "create") return { exitCode: 0, stdout: "https://example.invalid/demo/repo\n", stderr: "" };
  if (args.includes("--json")) {
    return { exitCode: 0, stdout: JSON.stringify({ number: 45, title: "Test", state: "OPEN", url: "https://example.invalid/pr/45" }), stderr: "" };
  }
  if (args[0] === "pr" && args[1] === "create") return { exitCode: 0, stdout: "https://example.invalid/pr/46\n", stderr: "" };
  return { exitCode: 0, stdout: "CI pass\n", stderr: "" };
};

const executor = createNativeToolExecutor({
  verifyExistingTarget: async (_root, path) => path,
  verifyWritableTarget: async (_root, path) => path,
  searchWorkspaceText: async () => ({}),
  calculateLineChanges: () => ({ additions: 0, deletions: 0 }),
  runGitCommand,
  runGitHubCli,
});
const invoke = (toolName, input) => executor({
  toolCall: { function: { name: toolName } },
  toolName,
  input,
  workspaceRoot: "/workspace",
  signal: undefined,
});

const initialized = await invoke("git_init", { initial_branch: "main" });
assert.equal(initialized.modelResult.alreadyRepository, true);
const remotes = await invoke("git_remote_list", {});
assert.match(remotes.modelResult.remotes, /origin/);
await invoke("git_remote_add", { remote: "upstream", url: "https://example.invalid/upstream.git" });
await invoke("git_stage", { paths: ["src/a.js"] });
await invoke("git_commit", { message: "test commit" });
await invoke("git_create_branch", { name: "feature/test" });
await invoke("git_pull", { strategy: "ff-only" });
const pushed = await invoke("git_push", { remote: "origin", set_upstream: true });
assert.equal(pushed.modelResult.branch, "feature");
const repository = await invoke("github_repo_create", { name: "demo/repo", visibility: "private", remote: "origin" });
assert.equal(repository.modelResult.created, true);
const created = await invoke("github_pr_create", { title: "Test PR", body: "Body", draft: true });
assert.equal(created.modelResult.created, true);
const viewed = await invoke("github_pr_view", { number: 45 });
assert.equal(viewed.modelResult.pullRequest.number, 45);
const checks = await invoke("github_pr_checks", { number: 45 });
assert.equal(checks.modelResult.passing, true);
assert.ok(gitCalls.some((args) => args[0] === "push"));
assert.ok(ghCalls.some((args) => args[0] === "pr" && args[1] === "create"));

console.log("github workflow smoke: PASS");