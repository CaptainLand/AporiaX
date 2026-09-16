import { createHash, randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { lstat, readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { verifyExistingTarget } from "../runtime/workspace-runtime.js";

const MAX_BYTES = 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function text(bytes) {
  if (bytes.length > MAX_BYTES || bytes.includes(0) || !isUtf8(bytes)) throw new Error("仅支持 1 MiB 内的 UTF-8 文本冲突；二进制、其他编码或大文件请使用外部编辑器。");
  return bytes.toString("utf8");
}
export function createGitConflictTools({ checked, recoveryDirectory }) {
  async function read(root, file) {
    if (!file.conflict) throw new Error("此文件已不处于冲突状态，请刷新。");
    if (!["UU", "AA"].includes(file.x + file.y)) throw new Error("删除/修改、重命名等复杂冲突请在终端处理；此面板不会删除文件。");
    const path = await verifyExistingTarget(root, file.path);
    const lexical = resolve(root, file.path);
    if ((process.platform === "win32" ? lexical.toLowerCase() !== path.toLowerCase() : lexical !== path) || (await lstat(lexical)).isSymbolicLink()) throw new Error("冲突路径包含链接，拒绝写入其他目标。");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error("冲突目标不是受支持的普通文本文件。");
    const working = await readFile(path);
    const stages = await checked(root, ["ls-files", "--unmerged", "-z", "--", file.path]);
    if (!String(stages).trim()) throw new Error("冲突来源已被暂存或移除，请刷新。");
    const result = { base: "", ours: "", theirs: "", working: text(working), path: file.path };
    for (const entry of String(stages).split("\0").filter(Boolean)) {
      const match = entry.match(/^100(?:644|755) ([a-f0-9]{40,64}) ([123])\t/);
      if (!match) throw new Error("冲突包含链接或特殊文件模式，请在终端处理。");
      const bytes = await checked(root, ["cat-file", "blob", match[1]], { encoding: "buffer", maxBuffer: MAX_BYTES + 1 });
      result[["", "base", "ours", "theirs"][Number(match[2])]] = text(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    }
    result.token = hash(Buffer.concat([Buffer.from(String(stages)), working]));
    return result;
  }
  async function apply(root, file, input, assertIdle) {
    assertIdle(root);
    const current = await read(root, file);
    if (!input.token || current.token !== input.token) throw new Error("文件或冲突来源已变化，请重新打开冲突并核对；未覆盖任何内容。");
    if (input.operation === "conflict-resolve") {
      if (/^<{7} |^>{7} /m.test(current.working)) throw new Error("仍有冲突标记，请先编辑并保存合并结果。");
      assertIdle(root);
      await checked(root, ["add", "--", file.path]);
      return {};
    }
    if (typeof input.content !== "string" || Buffer.byteLength(input.content) > MAX_BYTES || input.content.includes("\0")) throw new Error("合并结果必须是 1 MiB 内的文本。");
    if (!recoveryDirectory) throw new Error("未配置冲突备份目录，拒绝覆盖原文件。");
    const path = await verifyExistingTarget(root, file.path);
    const bytes = await readFile(path);
    const backup = join(recoveryDirectory, hash(root).slice(0, 16), randomUUID());
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, "original"), bytes, { flag: "wx" });
    await writeFile(join(backup, "info.json"), JSON.stringify({ root, path: file.path, sha256: hash(bytes), time: new Date().toISOString() }), { flag: "wx" });
    const temporary = join(dirname(path), `.aporiax-merge-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, input.content, { flag: "wx", mode: (await lstat(path)).mode });
      if ((await read(root, file)).token !== current.token) throw new Error("保存前检测到文件变化，已停止覆盖。");
      assertIdle(root);
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    return { backup, conflict: await read(root, file) };
  }
  return { read, apply };
}

export async function readPullRequests({ root, remote, branch, checked, runGitHub }) {
  const url = String(await checked(root, ["remote", "get-url", remote])).trim();
  const match = url.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  if (!match) throw new Error("PR 状态目前仅支持 github.com 的 HTTPS/SSH 远程仓库。");
  if (!branch) throw new Error("请先切换到命名分支。");
  const repository = `${match[1]}/${match[2]}`;
  let result;
  try { result = await runGitHub({ cwd: root, args: ["pr", "list", "--repo", repository, "--head", branch, "--state", "all", "--limit", "20", "--json", "number,title,state,url,isDraft,statusCheckRollup,updatedAt,headRefName"], timeoutMs: 30000 }); }
  catch (error) { throw new Error(/not installed|ENOENT|PATH/i.test(error.message) ? "未安装 GitHub CLI（gh），请先安装并在仓库设置中登录。" : "GitHub CLI 无法启动，请检查本地安装。"); }
  if (result.exitCode !== 0) {
    const message = String(result.stderr || "");
    if (/rate.limit|rate exceeded|429/i.test(message)) throw new Error("GitHub 查询达到限流，请稍后刷新 PR 状态。");
    if (/auth login|not logged|authentication|401|token/i.test(message)) throw new Error("GitHub 尚未登录或授权已失效，请在仓库设置中登录。");
    if (/403|404|not found|could not resolve to a repository|permission/i.test(message)) throw new Error("GitHub 仓库不存在或当前账号无权访问，请检查远程与授权。");
    throw new Error(result.timedOut ? "GitHub 查询超时，请检查网络后重试。" : "无法连接或读取 GitHub PR，请检查网络与远程地址后重试。");
  }
  let items;
  try { items = JSON.parse(result.stdout); } catch { throw new Error("GitHub 返回了无效或被截断的 PR 数据，请稍后重试。"); }
  if (!Array.isArray(items)) throw new Error("GitHub 返回了无效的 PR 列表。");
  return { repository, branch, items: items.slice(0, 20).map((pr) => ({
    number: pr.number, title: String(pr.title || ""), state: pr.state, isDraft: Boolean(pr.isDraft), updatedAt: pr.updatedAt,
    url: pr.url === `https://github.com/${repository}/pull/${pr.number}` ? pr.url : null,
    checks: (pr.statusCheckRollup || []).map((check) => ({ name: check.name || check.context, status: check.conclusion || check.state || check.status })),
  })) };
}
