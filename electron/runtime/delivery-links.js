import { localMarkdownLinks } from "../markdown-links.js";
import { checkWorkspaceFileLink } from "../file-link-check.js";

// Advisory and bounded. A broken link must not abort a completed task, trigger
// another model round, run tests, or invent a replacement artifact.
export async function validateDeliveryLinks(content, workspacePath, language = "zh-CN", check = checkWorkspaceFileLink) {
  const original = String(content || "");
  let timer;
  try {
    const links = localMarkdownLinks(original).slice(0, 100);
    if (!links.length) return original;
    const checks = new Map();
    for (const link of links) {
      if (!checks.has(link.target)) checks.set(link.target, Promise.resolve().then(() => check(workspacePath, link.target)).catch(() => ({ status: "unavailable" })));
    }
    const results = await Promise.race([
      Promise.all(links.map(async (link) => ({ ...link, ...(await checks.get(link.target)) }))),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 2000); }),
    ]);
    if (!results) return original;
    let output = original;
    const english = language === "en";
    for (const link of results.filter((link) => link.status === "missing").sort((a, b) => b.start - a.start)) {
      const label = (link.label || link.target).replace(/[\\`*_{}\[\]<>]/g, "\\$&");
      output = output.slice(0, link.start) + label + (english ? " (file not found)" : "（文件不存在）") + output.slice(link.end);
    }
    if (output !== original) output += english
      ? "\n\nLink check: the marked files do not exist in this workspace; no replacement files were assumed."
      : "\n\n链接校验：标注的文件在当前工作区不存在，已取消无效链接；未猜测或替换文件。";
    return output;
  } catch { return original; }
  finally { clearTimeout(timer); }
}
