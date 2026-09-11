import { classifyLink } from "../link-target.js";
import { onlyStandaloneDeliverables } from "../runtime/delivery-policy.js";

const PREVIEWABLE =
  /\.(?:js|jsx|ts|tsx|mjs|cjs|json|css|scss|less|html?|md|txt|xml|ya?ml|toml|svg|png|jpe?g|webp|gif|docx|py|rs|go|java|c|cc|cpp|h|hpp|cs|vue|svelte|php|rb|sh|ps1|sql)$/i;

export function isPreviewableWorkbenchPath(path) {
  const name = String(path || "")
    .replaceAll("\\", "/")
    .split("/")
    .pop();
  return Boolean(name) && PREVIEWABLE.test(name);
}

function addLinkedFile(files, seen, href) {
  const raw = String(href || "")
    .trim()
    .replace(/^<|>$/g, "");
  const link = classifyLink(raw);
  if (link?.kind !== "file" || !isPreviewableWorkbenchPath(link.target)) return;
  const path = String(link.target).replaceAll("\\", "/");
  const key = path.toLowerCase();
  if (!path || path.includes("..") || seen.has(key)) return;
  seen.add(key);
  files.push({ path, line: link.line || 1 });
}

export function extractLinkedFiles(content) {
  const files = [];
  const seen = new Set();
  const text = String(content || "");
  const markdown = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?\s*\)/g;
  let match;
  while ((match = markdown.exec(text))) addLinkedFile(files, seen, match[1]);
  return files;
}

export function filesToPresent({ content, changes = [], max = 5 } = {}) {
  const limit = Math.max(1, Math.min(8, Number(max) || 5));
  const linked = extractLinkedFiles(content).slice(0, limit);
  if (linked.length) return linked;
  const usable = (changes || []).filter(
    (change) =>
      !change?.deleted &&
      !change?.afterMissing &&
      !change?.reverted &&
      isPreviewableWorkbenchPath(change.path),
  );
  if (!usable.length) return [];
  const standalone = (changes || []).filter((change) => !change?.reverted);
  if (!onlyStandaloneDeliverables(standalone)) return [];
  const seen = new Set();
  const files = [];
  for (const change of usable) {
    const path = String(change.path || "").replaceAll("\\", "/");
    const key = path.toLowerCase();
    if (!path || seen.has(key)) continue;
    seen.add(key);
    files.push({ path, line: 1 });
    if (files.length >= limit) break;
  }
  return files;
}
