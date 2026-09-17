// Online discovery is metadata-only until an explicit install / probe action.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative } from "node:path";
import { parseSkillDocument, SKILL_NAME } from "./harness/skills/registry.js";
import { importUserSkill, inspectSkillDirectory } from "./extension-library.js";
import { withExtensionWriteLock } from "./extension-store-lock.js";

const HOUR = 3600_000;
const HOSTS = new Set(["skills.sh", "www.skills.sh", "registry.modelcontextprotocol.io", "api.github.com", "raw.githubusercontent.com"]);
const REPO = /^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9][a-z0-9_.-]{0,99}$/i;
const SHA = /^[a-f0-9]{40}$/;
const clean = (value, max = 2000) => typeof value === "string" ? value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, max) : "";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitHash = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const pathUrl = (value) => value.split("/").map(encodeURIComponent).join("/");

export function safePackagePath(value) {
  if (typeof value !== "string" || !value || value.length > 600 || value.includes("\\")) throw new Error("Unsafe package path.");
  for (const part of value.split("/")) {
    if (!part || [".", ".."].includes(part) || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) throw new Error("Unsafe package path: " + clean(value));
  }
  return value;
}

export function githubSource(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) throw new Error("仅支持公开的 HTTPS GitHub 仓库或 Skill 文件夹地址。");
  const parts = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "").split("/");
  const repo = parts.slice(0, 2).join("/").replace(/\.git$/, "");
  if (!REPO.test(repo)) throw new Error("Invalid GitHub repository.");
  if (parts.length > 2 && !["tree", "blob"].includes(parts[2])) throw new Error("请使用仓库或 tree 文件夹地址。");
  const ref = parts.length > 2 ? parts[3] : null;
  if (parts.length > 2 && !ref) throw new Error("Missing Git revision.");
  let directory = parts.slice(4).join("/");
  if (parts[2] === "blob" && directory.endsWith("SKILL.md")) directory = directory.split("/").slice(0, -1).join("/");
  if (directory) safePackagePath(directory);
  return { repo, ref, ...(directory ? { directory } : {}) };
}

function sourceLink(value) {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password ? u.href : ""; } catch { return ""; }
}

export function mcpChoices(server) {
  const choices = [];
  const baseId = "mcp-" + createHash("sha256").update(String(server.name)).digest("hex").slice(0, 12);
  for (const remote of (server.remotes || []).slice(0, 8)) {
    let reason = "";
    let url;
    try { url = new URL(remote.url); } catch { reason = "无效远程地址"; }
    if (remote.type !== "streamable-http") reason = "此传输方式需手动配置，当前只支持 Streamable HTTP";
    if (!url || url.protocol !== "https:" || url.username || url.password || /[{}]/.test(remote.url)) reason = "地址包含占位符或不是 HTTPS，需手动填写";
    const headers = {};
    const requirements = [];
    for (const header of (remote.headers || []).slice(0, 30)) {
      const name = clean(header.name, 80);
      if (!/^[A-Za-z0-9_-]+$/.test(name)) { reason = "请求头定义无法自动转换"; continue; }
      const variable = "MCP_" + name.toUpperCase().replace(/-/g, "_");
      if (header.value && !/[{}\r\n]/.test(header.value)) headers[name] = header.value;
      else {
        headers[name] = (name.toLowerCase() === "authorization" ? "Bearer " : "") + "${" + variable + "}";
        requirements.push(variable + ": " + clean(header.description, 300));
      }
    }
    choices.push({ label: "Streamable HTTP · " + clean(remote.url, 200), reason, requirements,
      template: reason ? null : { id: baseId, name: server.title || server.name, transport: "streamable-http", url: remote.url, headers } });
  }
  for (const pkg of (server.packages || []).slice(0, 8)) {
    let reason = "";
    if (pkg.registryType !== "npm" || pkg.transport?.type !== "stdio") reason = "此包类型暂不支持自动配置，请参照来源文档";
    if (pkg.registryBaseUrl && !/^https:\/\/registry\.npmjs\.org\/?$/.test(pkg.registryBaseUrl)) reason = "非标准 npm 源，需手动审阅配置";
    if (!/^(@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/.test(pkg.identifier) || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/i.test(pkg.version)) reason = "缺少固定 npm 包版本";
    if ((pkg.runtimeArguments || []).some((a) => !["-y", "--yes"].includes(a.value))) reason = "含自定义运行参数，需手动审阅";
    const args = ["-y", `${pkg.identifier}@${pkg.version}`];
    for (const arg of pkg.packageArguments || []) {
      if (typeof arg.value !== "string" || /[{}\r\n]/.test(arg.value) || arg.value.length > 2000) { reason = "参数需要手动填写，不能自动连接"; continue; }
      if (arg.type === "named") {
        if (!/^--?[a-z0-9_-]+$/i.test(arg.name)) { reason = "无法识别命名参数"; continue; }
        args.push(arg.name);
      }
      args.push(arg.value);
    }
    const env = {};
    const requirements = ["Node.js / npx（探测时可能从 npm 下载并执行此固定版本）"];
    for (const variable of (pkg.environmentVariables || []).slice(0, 60)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name)) { reason = "不兼容的环境变量名称"; continue; }
      if (variable.isRequired) {
        env[variable.name] = "${" + variable.name + "}";
        requirements.push(variable.name + ": " + clean(variable.description, 300));
      }
      // Optional defaults belong to the server; do not invent credentials or host paths.
    }
    choices.push({ label: `${clean(pkg.identifier)}@${clean(pkg.version)}`, reason, requirements,
      template: reason ? null : { id: baseId, name: server.title || server.name, transport: "stdio", command: "npx", args, env } });
  }
  return choices;
}

export function createExtensionDiscovery({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map();
  const tickets = new Map();
  let activeRequests = 0;
  async function bytes(url, maximum = 4_000_000) {
    if (activeRequests >= 12) throw new Error("在线目录请求较多，请稍后重试。");
    activeRequests++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let response;
    try {
      for (let redirects = 0; redirects < 4; redirects++) {
        const target = new URL(url);
        if (!HOSTS.has(target.hostname) || target.protocol !== "https:" || target.port || target.username || target.password) throw new Error("Blocked download host or redirect.");
        response = await fetchImpl(target.href, { signal: controller.signal, redirect: "manual", headers: { Accept: "application/json, text/plain, */*", "User-Agent": "AporiaX-Extensions" } });
        if ([301, 302, 303, 307, 308].includes(response.status)) { await response.body?.cancel(); url = new URL(response.headers.get("location"), target).href; continue; }
        if (!response.ok) throw new Error(`在线来源 ${target.hostname} 返回 HTTP ${response.status}${[403, 429].includes(response.status) ? "（可能达到匿名限流，请稍后重试）" : ""}`);
        if (Number(response.headers.get("content-length")) > maximum) throw new Error("Download exceeds size limit.");
        const reader = response.body.getReader();
        const chunks = []; let total = 0;
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          total += value.byteLength;
          if (total > maximum) { controller.abort(); throw new Error("Download exceeds size limit."); }
          chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks);
      }
      throw new Error("Too many redirects.");
    } finally { controller.abort(); clearTimeout(timer); activeRequests--; }
  }
  const json = async (url, maximum) => JSON.parse((await bytes(url, maximum)).toString("utf8"));
  function remember(detail, internal = {}) {
    for (const [key, item] of tickets) if (now() - item.created > HOUR) tickets.delete(key);
    if (tickets.size >= 32) tickets.delete(tickets.keys().next().value);
    const ticket = randomUUID(); tickets.set(ticket, { ...internal, detail, created: now() });
    return { ...detail, ticket };
  }

  async function search({ kind = "skill", query = "", cursor = "" } = {}) {
    query = clean(query, 180).trim();
    if (!["skill", "mcp"].includes(kind) || query.length < 2) throw new Error("请输入至少两个字符。");
    if (kind === "skill" && query.startsWith("https://github.com/")) {
      const source = githubSource(query);
      return { entries: [{ kind, title: source.repo, sourceUrl: query, source: source.repo, selector: { kind, ...source } }], source: "GitHub", checkedAt: new Date(now()).toISOString() };
    }
    const key = JSON.stringify([kind, query, cursor]);
    const hit = cache.get(key);
    if (hit && now() - hit.time < HOUR) return { ...hit.value, cached: true };
    let value;
    if (kind === "skill") {
      const data = await json("https://skills.sh/api/search?" + new URLSearchParams({ q: query, limit: "20" }));
      if (!Array.isArray(data.skills)) throw new Error("skills.sh 返回了不兼容的数据，仍可使用 GitHub 地址或本地导入。");
      value = { source: "skills.sh", entries: data.skills.slice(0, 20).filter((s) => REPO.test(s.source)).map((s) => ({
        kind, title: clean(s.name, 180), source: s.source, sourceUrl: `https://github.com/${s.source}`,
        selector: { kind, repo: s.source, slug: clean(s.skillId || s.id?.split("/").at(-1) || s.name, 100) },
      })) };
    } else {
      const data = await json("https://registry.modelcontextprotocol.io/v0.1/servers?" + new URLSearchParams({ search: query, version: "latest", limit: "20", ...(cursor ? { cursor: clean(cursor, 500) } : {}) }));
      if (!Array.isArray(data.servers)) throw new Error("MCP Registry 返回了不兼容的数据。");
      value = { source: "MCP Registry", nextCursor: clean(data.metadata?.nextCursor, 500), entries: data.servers.slice(0, 20).filter((s) => s.server?.name && !["deleted", "deprecated"].includes(s._meta?.["io.modelcontextprotocol.registry/official"]?.status)).map(({ server: s }) => ({
        kind, title: clean(s.title || s.name, 200), description: clean(s.description), source: clean(s.name), version: clean(s.version, 100), sourceUrl: sourceLink(s.repository?.url),
        selector: { kind, name: clean(s.name, 200), version: clean(s.version, 100) },
      })) };
    }
    value.checkedAt = new Date(now()).toISOString();
    if (cache.size >= 40) cache.delete(cache.keys().next().value);
    cache.set(key, { time: now(), value });
    return value;
  }

  async function details(selector = {}) {
    if (selector.kind === "mcp") {
      const name = clean(selector.name, 200), version = clean(selector.version, 100);
      if (!name || !version) throw new Error("Missing server name/version.");
      const endpoint = `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
      const data = await json(endpoint);
      const server = data.server;
      if (!server || server.name !== name || server.version !== version) throw new Error("MCP metadata version changed; search again.");
      if (["deleted", "deprecated"].includes(data._meta?.["io.modelcontextprotocol.registry/official"]?.status)) throw new Error("此版本已被目录撤下或弃用。");
      return remember({ kind: "mcp", title: clean(server.title || name), description: clean(server.description), sourceUrl: sourceLink(server.repository?.url) || endpoint, version,
        license: "未知（目录未提供可验证的许可，请查看来源）", requirements: ["需要可达网络；认证方式以来源文档为准"],
        warning: "公开收录不代表安全审核。探测会启动/连接第三方服务，可能下载依赖；不会调用业务工具。",
        choices: mcpChoices(server), manifest: JSON.stringify(server, null, 2).slice(0, 45_000) });
    }
    if (selector.kind !== "skill" || !REPO.test(selector.repo)) throw new Error("Invalid Skill source.");
    const repo = selector.repo;
    const meta = await json(`https://api.github.com/repos/${repo}`);
    const commit = await json(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(selector.ref || meta.default_branch)}`);
    if (!SHA.test(commit.sha)) throw new Error("Unable to resolve fixed Git commit.");
    const tree = await json(`https://api.github.com/repos/${repo}/git/trees/${commit.sha}?recursive=1`, 6_000_000);
    if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 30_000) throw new Error("仓库目录过大，无法完整审阅；请下载后从本地导入 Skill 文件夹。");
    let candidates = tree.tree.filter((f) => f.type === "blob" && /(^|\/)SKILL\.md$/.test(f.path) && f.mode === "100644");
    const directory = selector.directory ? safePackagePath(selector.directory) : "";
    if (Object.hasOwn(selector, "directory")) candidates = candidates.filter((f) => f.path === (directory ? `${directory}/SKILL.md` : "SKILL.md"));
    else if (selector.slug) candidates = candidates.filter((f) => f.path.split("/").at(-2) === selector.slug || f.path === "SKILL.md");
    if (!candidates.length) throw new Error("未找到对应 SKILL.md；请粘贴具体 GitHub Skill 文件夹地址。");
    if (candidates.length !== 1) return { kind: "skill", title: repo, choices: candidates.slice(0, 100).map((f) => ({ label: f.path, selector: { kind: "skill", repo, ref: commit.sha, directory: f.path.split("/").slice(0, -1).join("/") } })), chooseDirectory: true };
    const prefix = candidates[0].path.slice(0, -"SKILL.md".length);
    const files = tree.tree.filter((f) => f.path.startsWith(prefix) && f.type !== "tree");
    if (files.length > 500 || files.reduce((n, f) => n + (f.size || 0), 0) > 20_000_000) throw new Error("Skill exceeds 500 files / 20 MB.");
    const names = new Set();
    for (const file of files) {
      file.relative = safePackagePath(file.path.slice(prefix.length));
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 20_000_000) throw new Error("Invalid package file size.");
      if (!["100644", "100755"].includes(file.mode) || file.type !== "blob" || !SHA.test(file.sha)) throw new Error("不支持包含符号链接或子模块的 Skill。");
      if ([".aporiax-package.json", ".aporiax-source.json"].includes(file.relative.toLowerCase())) throw new Error("上游包含保留的 AporiaX 元数据文件，请从本地审阅后导入。");
      if (names.has(file.relative.toLowerCase())) throw new Error("Case-colliding package paths.");
      names.add(file.relative.toLowerCase());
    }
    const raw = async (file, maximum = 2_000_000) => {
      const content = await bytes(`https://raw.githubusercontent.com/${repo}/${commit.sha}/${pathUrl(file.path)}`, maximum);
      if (gitHash(content) !== file.sha) throw new Error("Upstream Git blob integrity mismatch.");
      return content;
    };
    const content = (await raw(files.find((f) => f.relative === "SKILL.md"), 128_000)).toString("utf8");
    const parsed = parseSkillDocument(content, { fallbackName: selector.slug || prefix.split("/").filter(Boolean).at(-1) || repo.split("/").at(-1) });
    const licenseFile = files.find((f) => /^(license|copying)(\.[a-z]+)?$/i.test(f.relative)) || tree.tree.find((f) => f.type === "blob" && /^(license|copying)(\.[a-z]+)?$/i.test(f.path));
    const licenseText = licenseFile ? (await raw(licenseFile, 100_000)).toString("utf8") : "";
    const license = parsed.license || (licenseFile?.path === "LICENSE" && meta.license?.spdx_id) || "未知，请核对许可原文；未声明不代表可自由使用";
    const dependencies = [];
    for (const file of files.filter((f) => /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|package\.json)$/i.test(f.relative)).slice(0, 4)) dependencies.push({ path: file.relative, text: (await raw(file, 100_000)).toString("utf8") });
    const sourceUrl = `https://github.com/${repo}/tree/${commit.sha}${prefix ? "/" + pathUrl(prefix.slice(0, -1)) : ""}`;
    return remember({ kind: "skill", title: parsed.title || parsed.name, name: parsed.name, description: parsed.description, license, licenseText,
      sourceUrl, version: commit.sha, requirements: [parsed.compatibility || "运行环境由上游说明决定", dependencies.length ? "检测到依赖清单，安装不会运行包管理器" : "未检测到标准依赖清单，不代表没有外部依赖"],
      warning: "第三方 Skill 内容未经安全审核，可能包含脚本和外部调用。安装只校验文件；依赖与实际产出仍需验证。",
      manifest: content, dependencies, files: files.map((f) => f.relative), fileCount: files.length,
      compatibilityWarnings: parsed.compatibilityWarnings || [],
    }, { repo, commit: commit.sha, prefix, files, sourceUrl, license, licenseText, licensePath: licenseFile?.path || "", instructionHash: hash(Buffer.from(content)), installing: false });
  }

  async function install({ userDataDirectory, ticket } = {}) {
    const entry = tickets.get(ticket);
    if (!entry || entry.detail.kind !== "skill" || now() - entry.created >= HOUR) throw new Error("详情已过期，请重新查看后安装。");
    if (entry.installing) throw new Error("此 Skill 正在安装。");
    entry.installing = true;
    let staging;
    try {
      staging = await mkdtemp(join(tmpdir(), "aporiax-online-skill-"));
      let total = 0;
      // Bounded parallel raw downloads, no git clone, archive extraction, or install scripts.
      const queue = [...entry.files];
      let failure;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (queue.length && !failure) {
          const file = queue.shift();
          try {
            const content = await bytes(`https://raw.githubusercontent.com/${entry.repo}/${entry.commit}/${pathUrl(file.path)}`, Math.min(file.size + 1 || 20_000_000, 20_000_000));
            total += content.length;
            if (total > 20_000_000 || gitHash(content) !== file.sha) throw new Error("Skill 下载大小或 Git blob 校验失败。");
            if (file.relative === "SKILL.md" && hash(content) !== entry.instructionHash) throw new Error("Skill instructions changed since review.");
            const target = join(staging, safePackagePath(file.relative));
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, content, { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 });
          } catch (error) { failure ||= error; }
        }
      }));
      if (failure) throw failure;
      const result = await importUserSkill({ userDataDirectory, sourceDirectory: staging, onlineSource: { identity: `github:${entry.repo.toLowerCase()}/${entry.prefix}`, repo: entry.repo, commit: entry.commit, sourceUrl: entry.sourceUrl, license: entry.license, licenseText: entry.licenseText, licensePath: entry.licensePath } });
      return { ...result, verification: await verifyInstalledSkill({ userDataDirectory, name: result.skill.name }) };
    } finally {
      entry.installing = false;
      // Only this call's mkdtemp path can be removed.
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }
  return { search, details, install };
}

export async function verifyInstalledSkill({ userDataDirectory, name } = {}) {
  if (!SKILL_NAME.test(String(name || ""))) throw new Error("Invalid Skill name.");
  return withExtensionWriteLock(userDataDirectory, async (userDataDirectory) => {
    const root = resolve(userDataDirectory, "skills", name);
    if (relative(root, await realpath(root)) !== "") throw new Error("Unsafe Skill store path.");
    const current = await inspectSkillDirectory(root);
    const content = await readFile(join(root, "SKILL.md"), "utf8");
    parseSkillDocument(content, { fallbackName: name });
    const manifest = JSON.parse(await readFile(join(root, ".aporiax-package.json"), "utf8"));
    if (manifest.instructionSha256 !== hash(Buffer.from(content))) throw new Error("SKILL.md 已变更，请重新审阅或导入后验证。");
    const files = Object.entries(manifest.files || {}).filter(([path]) => path !== ".aporiax-package.json");
    if (!files.length || files.length > 500) throw new Error("Invalid installed file manifest.");
    const actualNames = Object.keys(current.hashes).filter((path) => path !== ".aporiax-package.json").sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(files.map(([path]) => path).sort())) throw new Error("安装文件列表已变更，请重新审阅或导入后验证。");
    for (const [path, expected] of files) {
      const target = join(root, safePackagePath(path));
      const stats = await lstat(target);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 20_000_000 || relative(target, await realpath(target)) !== "") throw new Error("Unsafe installed Skill file.");
      if (hash(await readFile(target)) !== expected) throw new Error("安装文件已变更: " + path);
    }
    return { status: "structure-and-integrity-passed", fileCount: files.length, checkedAt: new Date().toISOString(), scriptsExecuted: false, dependenciesVerified: false };
  });
}
