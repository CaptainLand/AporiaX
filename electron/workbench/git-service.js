import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getVerifiedWorkspaceRoot, verifyExistingTarget } from "../runtime/workspace-runtime.js";
import { runGitHubCli } from "../runtime/github-runtime.js";
import { getGitHubAuthStatus, networkRemote, remoteName } from "./git-setup.js";
import { createGitConflictTools, readPullRequests } from "./git-conflicts.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const cleanError = (text) => String(text || "Git 操作失败").replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]+)?@/g, "$1[redacted]@").replace(/\b(?:gh[pousr]_[a-zA-Z0-9_]+|github_pat_[a-zA-Z0-9_]+)\b/g, "[redacted]").slice(0, 3000);

export function runWorkbenchGit(cwd, args, { timeout = 30000, maxBuffer = 2 * 1024 * 1024, encoding = "utf8" } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0", GCM_INTERACTIVE: "Never", LC_ALL: "C" });
  return new Promise((done, reject) => {
    execFile("git", ["-c", "color.ui=false", "-c", "core.quotepath=false", ...args], { cwd, env, shell: false, windowsHide: true, timeout, maxBuffer, encoding }, (error, stdout, stderr) => {
      if (error?.code === "ENOENT") return reject(new Error("未找到 Git，请安装 Git 并重新启动 AporiaX。"));
      if (error?.killed || error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new Error("Git 操作超时或输出过大，请缩小范围后重试。操作可能已部分完成，请刷新检查。"));
      done({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

export function parseGitStatus(output) {
  const tokens = output.split("\0"), files = [];
  for (let i = 0; i < tokens.length; i++) {
    const row = tokens[i];
    if (!row || row.startsWith("## ")) continue;
    const x = row[0], y = row[1], path = row.slice(3);
    const originalPath = /[RC]/.test(x + y) ? tokens[++i] : undefined;
    const conflict = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(x + y);
    files.push({ path, originalPath, x, y, conflict, untracked: x === "?", staged: x !== " " && x !== "?", unstaged: y !== " " || x === "?" });
  }
  return files;
}

export function createWorkbenchGitService({ confirmPush = async () => false, confirmOperation = async () => false,
  assertWorkspaceIdle = () => {}, runGit = runWorkbenchGit, runGitHub = runGitHubCli, recoveryDirectory } = {}) {
  const locks = new Map();
  const checked = async (root, args, options) => {
    const result = await runGit(root, args, options);
    if (result.code !== 0) throw new Error(cleanError(result.stderr || result.stdout));
    return result.stdout;
  };
  const conflicts = createGitConflictTools({ checked, recoveryDirectory });
  async function workflow(root) {
    for (const [name, marker] of [["rebase", "rebase-merge"], ["rebase", "rebase-apply"], ["cherry-pick", "CHERRY_PICK_HEAD"], ["revert", "REVERT_HEAD"], ["merge", "MERGE_HEAD"]]) {
      const path = String(await checked(root, ["rev-parse", "--git-path", marker])).trim();
      try { await lstat(resolve(root, path)); return name; } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return null;
  }
  async function snapshot(root) {
    const top = await runGit(root, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) {
      if (/not a git repository/i.test(top.stderr)) {
        const names = (await readdir(root)).sort();
        return { repository: false, root, empty: names.length === 0, revision: digest(names.join("\0")), message: "当前工作区尚未启用 Git。可以初始化本地仓库，或克隆到空工作区。", files: [] };
      }
      throw new Error(cleanError(top.stderr));
    }
    const repositoryRoot = await realpath(top.stdout.trim());
    if (!samePath(repositoryRoot, root)) return { repository: true, readOnly: true, root: repositoryRoot, files: [], message: "当前工作区是仓库的子目录。请将仓库根目录绑定为工作区后管理 Git，避免提交其他目录的改动。" };
    const [status, headResult, branchResult, stagedRaw, remotes, upstreamResult, routing] = await Promise.all([
      checked(root, ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"]),
      runGit(root, ["rev-parse", "--verify", "HEAD"]),
      runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      checked(root, ["diff", "--cached", "--raw", "--no-abbrev", "--no-ext-diff", "--no-textconv", "-z"]),
      checked(root, ["remote"]), runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
      runGit(root, ["config", "--local", "--get-regexp", "^(remote|branch)\\."]),
    ]);
    const head = headResult.code === 0 ? headResult.stdout.trim() : "";
    const branch = branchResult.code === 0 ? branchResult.stdout.trim() : "";
    const operation = await workflow(root);
    const all = parseGitStatus(status), header = status.split("\0")[0];
    return { repository: true, root, branch, head, workflow: operation, detached: !branch, upstream: upstreamResult.code === 0 ? upstreamResult.stdout.trim() : "",
      ahead: Number(header.match(/ahead (\d+)/)?.[1] || 0), behind: Number(header.match(/behind (\d+)/)?.[1] || 0),
      remotes: remotes.trim().split("\n").filter(Boolean), files: all.slice(0, 1000), totalFiles: all.length, truncated: all.length > 1000,
      revision: digest(head + "\0" + branch + "\0" + status + "\0" + stagedRaw + "\0" + routing.stdout + "\0" + operation) };
  }
  function requireRepo(state) {
    if (!state.repository || state.readOnly) throw new Error(state.message);
  }
  function selectedFile(state, requested) {
    const file = state.files.find((item) => item.path === requested);
    if (!file || !file.path || file.path.includes("\0") || file.path.startsWith("/") || file.path.split("/").includes("..")) throw new Error("文件不在当前改动列表中，请刷新后重试。");
    return file;
  }
  async function validBranch(root, value) {
    const name = String(value || "").trim();
    if (!name || name.length > 240 || name.startsWith("-") || name.includes("@{") || /[\u0000-\u001f]/.test(name)) throw new Error("无效的分支名称。");
    await checked(root, ["check-ref-format", "--branch", name]); return name;
  }
  async function pushTarget(root, state, input = {}) {
    if (!state.branch || !state.head) throw new Error("请先在当前分支完成首次提交。");
    if (!state.upstream && !input.remote) throw new Error("尚未设置远程跟踪关系，请选择远程后发布分支。");
    const remote = state.upstream ? (await checked(root, ["config", "--get", `branch.${state.branch}.remote`])).trim() : remoteName(input.remote);
    const ref = state.upstream ? (await checked(root, ["config", "--get", `branch.${state.branch}.merge`])).trim() : "refs/heads/" + await validBranch(root, input.branch || state.branch);
    if (!state.remotes.includes(remote) || !ref.startsWith("refs/heads/")) throw new Error("远程跟踪配置不受支持，请在终端检查。");
    const urls = (await checked(root, ["remote", "get-url", "--push", "--all", remote])).trim();
    if (urls.includes("\n")) throw new Error("此远程配置了多个推送地址，请使用终端明确选择。");
    return { remote, ref, url: urls, first: !state.upstream };
  }
  async function reconfirm(root, current, details) {
    if (!await confirmOperation(details)) return false;
    if ((await snapshot(root)).revision !== current.revision) throw new Error("确认期间仓库状态已变化，请刷新后重试。");
    return true;
  }
  async function mutate(root, input) {
    const current = await snapshot(root);
    if (!input.revision || input.revision !== current.revision) throw new Error("仓库状态已变化，请刷新并重新检查后操作。");
    if (input.operation === "init" || input.operation === "clone") {
      if (current.repository) throw new Error("此目录已属于 Git 仓库，不能重复初始化或克隆。");
      assertWorkspaceIdle(root);
      if (input.operation === "clone") {
        const url = networkRemote(input.url);
        if (!current.empty) throw new Error("克隆要求空工作区。请新建并绑定一个空文件夹；不会覆盖现有文件。");
        await checked(root, ["clone", "--", url, "."], { timeout: 120000 });
      } else {
        const branch = await validBranch(root, input.branch || "main");
        await checked(root, ["init", "-b", branch]);
        if (input.addIgnore === true) {
          try { await writeFile(join(root, ".gitignore"), ".env\n.env.*\n!.env.example\nnode_modules/\ndist/\nrelease/\n.tmp/\n", { flag: "wx" }); }
          catch (error) { if (error.code !== "EEXIST") throw error; }
        }
      }
      return { state: await snapshot(root) };
    }
    requireRepo(current);
    if (["stage", "unstage", "commit"].includes(input.operation)) assertWorkspaceIdle(root);
    if (["conflict-save", "conflict-resolve"].includes(input.operation)) {
      if (current.workflow && current.workflow !== "merge") throw new Error(`当前正在 ${current.workflow}，请在终端继续；侧栏仅支持普通合并冲突。`);
      const result = await conflicts.apply(root, selectedFile(current, input.path), input, assertWorkspaceIdle);
      return { ...result, state: await snapshot(root) };
    }
    if (input.operation === "stage" || input.operation === "unstage") {
      const file = selectedFile(current, input.path);
      if (file.conflict) throw new Error("请先在编辑器或终端解决冲突，侧栏不会自动处理冲突。");
      const paths = [...new Set([file.path, file.originalPath].filter(Boolean))];
      if (input.operation === "stage") await checked(root, ["add", "--", ...paths]);
      else if (!file.staged) throw new Error("此文件尚未暂存。");
      else if (current.head) await checked(root, ["restore", "--staged", "--source=HEAD", "--", ...paths]);
      else await checked(root, ["rm", "--cached", "-f", "--", ...paths]);
    } else if (input.operation === "commit") {
      if (current.workflow && current.workflow !== "merge") throw new Error(`当前正在 ${current.workflow}，请在终端继续该操作，不能作为普通提交结束。`);
      const message = String(input.message || "").trim();
      if (!message || message.length > 4000 || message.includes("\0")) throw new Error("请输入 1–4000 字的提交说明。");
      if (current.detached) throw new Error("当前为 detached HEAD，请先在终端切换到分支。");
      if (!current.files.some((file) => file.staged)) throw new Error("没有已暂存的改动；提交不会自动暂存文件。");
      if (current.files.some((file) => file.conflict) || current.truncated) throw new Error("存在冲突或改动列表过大，请先在终端检查。");
      await checked(root, ["commit", "-m", message], { timeout: 120000 });
    } else if (input.operation === "branch-create" || input.operation === "branch-switch") {
      assertWorkspaceIdle(root);
      const branch = await validBranch(root, input.branch);
      if (!current.head) throw new Error("请先完成首次提交，再创建或切换分支。");
      if (input.operation === "branch-switch") {
        if (current.totalFiles) throw new Error("请先提交或自行保存未提交改动。不会强制切换或自动 stash。");
        await checked(root, ["show-ref", "--verify", "--", "refs/heads/" + branch]);
        await checked(root, ["switch", "--no-guess", "--", branch]);
      } else await checked(root, ["switch", "-c", branch]);
    } else if (input.operation === "remote-save") {
      const remote = remoteName(input.remote), url = networkRemote(input.url);
      if (!await reconfirm(root, current, { title: "关联远程仓库", message: `将 ${remote} 指向此仓库？`, detail: url + "\n仅修改当前仓库的远程地址，不上传代码。" })) return { canceled: true, state: current };
      if (current.remotes.includes(remote)) {
        const pushurl = await runGit(root, ["config", "--get-all", `remote.${remote}.pushurl`]);
        if (pushurl.code === 0) throw new Error("此远程有独立 pushurl，请在终端检查后修改，避免推送到旧地址。");
        await checked(root, ["remote", "set-url", remote, url]);
      } else await checked(root, ["remote", "add", remote, url]);
    } else if (input.operation === "identity-save") {
      const name = String(input.name || "").trim(), email = String(input.email || "").trim();
      if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254 || /[\u0000-\u001f]/.test(name + email)) throw new Error("请输入有效的提交者姓名和邮箱。仅保存到当前仓库。");
      await checked(root, ["config", "--local", "user.name", name]);
      await checked(root, ["config", "--local", "user.email", email]);
    } else if (input.operation === "github-create") {
      const name = String(input.name || "").trim(), visibility = input.visibility === "public" ? "public" : "private";
      if (!/^[a-z0-9][a-z0-9_-]{0,38}\/[a-z0-9_][a-z0-9_.-]{0,99}$/i.test(name)) throw new Error("请输入 GitHub 用户名/仓库名。");
      const remote = remoteName(input.remote);
      if (current.remotes.includes(remote)) throw new Error("此远程名称已存在，请换一个名称，避免覆盖原仓库关联。");
      if (!current.head) throw new Error("请先在本地完成首次提交。");
      const auth = await getGitHubAuthStatus({ cwd: root, run: runGitHub });
      if (!auth.authenticated) throw new Error(auth.message);
      if (!await reconfirm(root, current, { title: "创建 GitHub 仓库", message: `创建${visibility === "public" ? "公开" : "私有"}仓库 ${name}？`, detail: "将在 GitHub 创建远程仓库并关联本地。此步不上传提交；随后点击发布分支。" })) return { canceled: true, state: current };
      const result = await runGitHub({ cwd: root, args: ["repo", "create", name, "--" + visibility, "--source", ".", "--remote", remote], timeoutMs: 120000 });
      if (result.exitCode !== 0) throw new Error("GitHub 创建或关联未完成。请先检查 GitHub 上是否已创建及本地 remote，再决定重试。" + cleanError(result.stderr));
    } else if (input.operation === "pull") {
      assertWorkspaceIdle(root);
      if (current.totalFiles) throw new Error("请先提交或自行保存本地改动，再拉取远程更新。");
      if (!current.upstream) throw new Error("当前分支尚未关联上游。");
      if (!await reconfirm(root, current, { title: "快进拉取", message: `将 ${current.upstream} 的更新应用到本地？`, detail: "只允许快进，不做自动合并或 rebase；分叉时会停止。" })) return { canceled: true, state: current };
      assertWorkspaceIdle(root);
      await checked(root, ["pull", "--ff-only"], { timeout: 120000 });
    } else if (input.operation === "fetch") {
      const remote = current.remotes.includes("origin") ? "origin" : current.remotes[0];
      if (!remote || remote.startsWith("-")) throw new Error("没有可用的远程仓库，请先在终端配置 remote。");
      await checked(root, ["fetch", "--", remote], { timeout: 120000 });
    } else if (input.operation === "push") {
      const target = await pushTarget(root, current, input);
      if (!await confirmPush({ root, branch: current.branch, remote: target.remote, ref: target.ref, url: cleanError(target.url), ahead: current.ahead })) return { canceled: true, state: current };
      const latest = await snapshot(root);
      if (latest.revision !== current.revision || JSON.stringify(await pushTarget(root, latest, input)) !== JSON.stringify(target)) throw new Error("确认期间仓库或推送目标发生变化，请重新检查。");
      await checked(root, ["push", "--porcelain", ...(target.first ? ["--set-upstream"] : []), "--", target.remote, `HEAD:${target.ref}`], { timeout: 120000 });
    } else throw new Error("不支持此 Git 操作。");
    return { state: await snapshot(root) };
  }
  return {
    async request(input) {
      const root = await getVerifiedWorkspaceRoot(input.workspacePath);
      if (input.operation === "status") return snapshot(root);
      if (input.operation === "github-status") return getGitHubAuthStatus({ cwd: root, run: runGitHub });
      if (["conflict-read", "pull-requests"].includes(input.operation)) {
        const state = await snapshot(root); requireRepo(state);
        if (input.operation === "conflict-read") {
          if (state.workflow && state.workflow !== "merge") throw new Error(`当前正在 ${state.workflow}，请在终端解决并继续；侧栏不会代替该操作。`);
          return conflicts.read(root, selectedFile(state, input.path));
        }
        const remote = input.remote || (state.remotes.includes("origin") ? "origin" : state.remotes[0]);
        if (!state.remotes.includes(remote)) throw new Error("请先关联 GitHub 远程仓库。");
        return readPullRequests({ root, remote, branch: state.branch, checked, runGitHub });
      }
      if (input.operation === "settings") {
        const state = await snapshot(root); requireRepo(state);
        const [refs, name, email] = await Promise.all([
          checked(root, ["for-each-ref", "--count=200", "--format=%(refname:short)", "refs/heads"]),
          runGit(root, ["config", "--get", "user.name"]), runGit(root, ["config", "--get", "user.email"]),
        ]);
        const remotes = await Promise.all(state.remotes.map(async (remote) => ({ name: remote,
          url: cleanError((await checked(root, ["remote", "get-url", remote])).trim()),
          pushUrl: cleanError((await checked(root, ["remote", "get-url", "--push", "--all", remote])).trim()) })));
        return { branches: refs.trim().split("\n").filter(Boolean), remotes, name: name.stdout.trim(), email: email.stdout.trim() };
      }
      if (input.operation === "diff" || input.operation === "log") {
        const state = await snapshot(root); requireRepo(state);
        if (input.operation === "log") {
          if (!state.head) return [];
          const log = await checked(root, ["log", "-25", "--format=%H%x00%h%x00%s%x00%an%x00%aI%x00"]);
          const tokens = log.split("\0"), entries = [];
          for (let i = 0; i + 4 < tokens.length; i += 5) entries.push({ hash: tokens[i].trim(), shortHash: tokens[i + 1], subject: tokens[i + 2], author: tokens[i + 3], date: tokens[i + 4] });
          return entries;
        }
        const file = selectedFile(state, input.path);
        if (file.untracked) {
          const path = await verifyExistingTarget(root, file.path), stat = await lstat(path);
          if (!stat.isFile() || stat.size > 200000) return { text: "文件较大或不是普通文件，请在文件侧栏查看。", binary: true };
          const bytes = await readFile(path);
          return bytes.includes(0) ? { text: "二进制文件，请在文件侧栏查看。", binary: true } : { text: bytes.toString("utf8").split("\n").map((line) => "+" + line).join("\n"), untracked: true };
        }
        const diff = await checked(root, ["diff", ...(input.staged ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", ...[file.path, file.originalPath].filter(Boolean)]);
        return { text: diff.slice(0, 200000), truncated: diff.length > 200000 };
      }
      // Serialize our writes by repository, even when two tasks use the same root.
      const key = process.platform === "win32" ? root.toLowerCase() : root;
      const before = locks.get(key) || Promise.resolve();
      const job = before.catch(() => {}).then(() => mutate(root, input));
      locks.set(key, job);
      try { return await job; } finally { if (locks.get(key) === job) locks.delete(key); }
    },
  };
}
