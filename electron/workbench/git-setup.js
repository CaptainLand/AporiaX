import { runGitHubCli } from "../runtime/github-runtime.js";

export function networkRemote(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 2048 || /[\s\u0000-\u001f]/.test(text)) throw new Error("请输入有效的 HTTPS 或 SSH 仓库地址，不要包含密码或令牌。");
  if (/^git@[a-z0-9.-]+:[a-z0-9_.\/-]+$/i.test(text) && !text.includes("/../")) return text;
  try {
    const url = new URL(text);
    if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname !== "/") return url.href;
  } catch { /* Invalid URL is reported below. */ }
  throw new Error("只支持不含密码/令牌的 HTTPS 或 git@host:path SSH 地址。");
}

export function remoteName(value = "origin") {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value)) throw new Error("远程名称只能包含字母、数字、点、下划线和短横线。");
  return value;
}

export async function getGitHubAuthStatus({ cwd, signal, run = runGitHubCli } = {}) {
  // Never return raw gh output: it can contain tokens, scopes or credential paths.
  try {
    const result = await run({ cwd, signal, timeoutMs: 20000,
      args: ["auth", "status", "--hostname", "github.com", "--json", "hosts", "--jq", '.hosts["github.com"] | map({login,active,state})'] });
    if (result.exitCode !== 0) return { available: true, authenticated: false, message: "GitHub 未登录、凭据失效或网络不可用，请检查后重试。" };
    const accounts = JSON.parse(result.stdout || "[]");
    const account = Array.isArray(accounts) && accounts.find((item) => item.active === true && item.state === "success");
    const login = account && /^[a-z0-9-]{1,39}$/i.test(account.login) ? account.login : "";
    return { available: true, authenticated: Boolean(login), login, message: login ? "GitHub 已登录" : "请先登录 GitHub。" };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const missing = error?.code === "ENOENT" || /not installed|not available on PATH/i.test(error?.message || "");
    return { available: !missing, authenticated: false, message: missing ? "未安装 GitHub CLI (gh)。安装后重启 AporiaX。" : "无法检查 GitHub 登录状态，请检查网络或更新 gh 后重试。" };
  }
}

export function githubLoginCommand(platform = process.platform) {
  const login = "gh auth login --hostname github.com --git-protocol https --web";
  // Fixed commands only, never interpolate a user/model-provided URL or token.
  return platform === "win32" ? `${login}; if ($LASTEXITCODE -eq 0) { gh auth setup-git --hostname github.com }\r` : `${login} && gh auth setup-git --hostname github.com\n`;
}
