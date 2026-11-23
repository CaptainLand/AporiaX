import { localMarkdownLinks, unlinkedInlineCode } from "../markdown-links.js";
import { checkWorkspaceFileLink } from "../file-link-check.js";
import { normalizeLocalPath, toWorkspaceRelativePath } from "../link-target.js";

// Backstop only exact path mentions of work produced in this run. Do not
// reinterpret fenced code, guess paths from a basename, or invent a preview.
export function linkDeliveredFileMentions(content, workspacePath, changes = []) {
  // Reply formatting is advisory; an unusual Markdown input must never
  // replace an otherwise successful final answer with a runtime error.
  try { return formatFileMentions(content, workspacePath, changes); }
  catch { return content; }
}

function formatFileMentions(content, workspacePath, changes) {
  if (!workspacePath || !changes.length) return content;
  const known = new Map();
  const key = value => process.platform === "win32" ? value.toLowerCase() : value;
  for (const change of changes) {
    if (change.deleted || change.afterMissing || change.reverted) continue;
    const path = normalizeLocalPath(change.path);
    if (!path || /[:<>\u0000-\u001f\u007f]/.test(path) || path.startsWith("/") || path.split("/").includes("..")) continue;
    known.set(key(path),path);
  }
  if (!known.size) return content;
  const linked = new Set(localMarkdownLinks(content).map(link => key(toWorkspaceRelativePath(workspacePath, link.target))));
  const replacements = [];
  for (const item of unlinkedInlineCode(content)) {
    const path = known.get(key(toWorkspaceRelativePath(workspacePath, item.value)));
    if (!path || linked.has(key(path))) continue;
    const label = path.replace(/[\\\[\]*_`]/g, "\\$&");
    let href;
    try { href = path.split("/").map(encodeURIComponent).join("/"); }
    catch { continue; }
    replacements.push({ ...item, link: `[${label}](<${href}>)` });
    linked.add(key(path));
  }
  let result = content;
  for (const {start,end,link} of replacements.reverse()) result = result.slice(0,start) + link + result.slice(end);
  return result;
}

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
