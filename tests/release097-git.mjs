import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbenchGitService, runWorkbenchGit } from "../electron/workbench/git-service.js";

const root = await mkdtemp(join(tmpdir(), "aporiax-097-git-"));
const git = async (...args) => { const value = await runWorkbenchGit(root, args); assert.equal(value.code, 0, value.stderr); return value.stdout; };
await git("init", "-b", "main");
await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
await git("config", "commit.gpgsign", "false"); await git("config", "core.hooksPath", join(root, "no-hooks"));
const file = "双方 中文.txt", path = join(root, file);
await writeFile(path, "base\n"); await git("add", "--", file); await git("commit", "-m", "base");
await git("switch", "-c", "feature"); await writeFile(path, "theirs\n"); await git("commit", "-am", "theirs");
await git("switch", "main"); await writeFile(path, "ours\n"); await git("commit", "-am", "ours");
assert.notEqual((await runWorkbenchGit(root, ["merge", "feature"])).code, 0);
let active = false, ghCalls = [], ghOverride = null;
const service = createWorkbenchGitService({ recoveryDirectory: join(root, ".git", "test-recovery"), assertWorkspaceIdle: () => { if (active) throw Error("active task"); },
  runGitHub: async (request) => { ghCalls.push(request); if (ghOverride instanceof Error) throw ghOverride; return ghOverride || { exitCode: 0, stdout: JSON.stringify([{ number: 42, title: "Fixture", state: "OPEN", url: "https://github.com/fixture/repository/pull/42", statusCheckRollup: [{ name: "tests", conclusion: "SUCCESS" }] }]) }; } });
const call = (operation, extra = {}) => service.request({ workspacePath: root, operation, ...extra });
let state = await call("status"), conflict = await call("conflict-read", { path: file });
assert.equal(conflict.ours.trim(), "ours"); assert.equal(conflict.theirs.trim(), "theirs"); assert.equal(conflict.base.trim(), "base");
await assert.rejects(call("conflict-resolve", { path: file, revision: state.revision, token: conflict.token }), /冲突标记/);
const original = await readFile(path, "utf8");
await writeFile(path, "outside edit\n"); state = await call("status");
await assert.rejects(call("conflict-save", { path: file, revision: state.revision, token: conflict.token, content: "lost" }), /已变化/);
assert.equal(await readFile(path, "utf8"), "outside edit\n");
await writeFile(path, original); state = await call("status"); conflict = await call("conflict-read", { path: file });
active = true;
await assert.rejects(call("conflict-save", { path: file, revision: state.revision, token: conflict.token, content: "merged\n" }), /active task/);
active = false;
const saved = await call("conflict-save", { path: file, revision: state.revision, token: conflict.token, content: "merged\n" });
assert.equal(await readFile(join(saved.backup, "original"), "utf8"), original);
assert.equal(saved.state.files.find((entry) => entry.path === file).conflict, true);
const resolved = await call("conflict-resolve", { path: file, revision: saved.state.revision, token: saved.conflict.token });
assert.equal(resolved.state.files.find((entry) => entry.path === file).conflict, false);
await call("commit", { revision: resolved.state.revision, message: "resolve fixture" });
assert.equal((await git("rev-list", "--parents", "-n", "1", "HEAD")).trim().split(" ").length, 3);
await git("remote", "add", "origin", "https://github.com/fixture/repository.git");
const prs = await call("pull-requests"); assert.equal(prs.items[0].checks[0].status, "SUCCESS");
assert.deepEqual(ghCalls[0].args.slice(0, 2), ["pr", "list"]); assert.ok(!ghCalls[0].args.includes("--merge"));
for (const [response, expected] of [
  [new Error("spawn gh ENOENT"), /未安装/],
  [{ exitCode: 1, stderr: "run gh auth login" }, /尚未登录/],
  [{ exitCode: 1, stderr: "HTTP 429 rate limit" }, /限流/],
  [{ exitCode: 1, stderr: "HTTP 403 permission denied" }, /无权访问/],
  [{ exitCode: 1, stderr: "offline" }, /检查网络/],
  [{ exitCode: 1, timedOut: true }, /超时/],
  [{ exitCode: 0, stdout: "not json" }, /无效/],
]) { ghOverride = response; await assert.rejects(call("pull-requests"), expected); }
ghOverride = { exitCode: 0, stdout: "[]" }; assert.equal((await call("pull-requests")).items.length, 0);
await writeFile(path, "a later edit\n"); state = await call("status"); active = true;
await assert.rejects(call("stage", { path: file, revision: state.revision }), /active task/); active = false;
// Read workflow markers only; never try to continue a rebase as a normal commit.
await mkdir(join(root, ".git", "rebase-merge")); state = await call("status"); assert.equal(state.workflow, "rebase");
await assert.rejects(call("commit", { revision: state.revision, message: "must not commit" }), /rebase/);
console.log("PASS 0.9.7 Git: real merge, stale content, idle guard, backup, stage, merge commit, read-only PR");
