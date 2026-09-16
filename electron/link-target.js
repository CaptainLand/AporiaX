// Shared, browser-safe classification. Unknown schemes must never reach shell.openExternal.

// GFM autolinks stop on ASCII space/punctuation, not fullwidth CJK punctuation.
const AUTOLINK_STOP = /[\p{P}\p{Z}]/u;

export function autolinkBoundaryIndex(value) {
  const text = String(value || "");
  for (let i = 0; i < text.length; ) {
    const char = String.fromCodePoint(text.codePointAt(i));
    if ((char.codePointAt(0) || 0) > 0x7f && AUTOLINK_STOP.test(char)) return i;
    i += char.length;
  }
  return -1;
}

export function splitAutolinkBoundary(href, text) {
  const url = String(href || "");
  // Only the Markdown parser may call this for *bare* web autolinks.
  // A local filename, explicit link or Unicode URL must not be guessed apart.
  if (!/^https?:\/\//i.test(url)) return null;
  const label = text == null ? url : String(text);
  const urlIndex = autolinkBoundaryIndex(url);
  if (urlIndex >= 0) {
    const cleanHref = url.slice(0, urlIndex);
    const suffix = url.slice(urlIndex);
    if (!cleanHref) return null;
    if (label.endsWith(suffix)) {
      return { href: cleanHref, label: label.slice(0, label.length - suffix.length), suffix };
    }
    return { href: cleanHref, label, suffix: "" };
  }
  if (!url || !label) return null;
  const bareHref = url.replace(/^https?:\/\//i, "");
  for (const prefix of [url, bareHref]) {
    if (!prefix || !label.startsWith(prefix)) continue;
    const suffix = label.slice(prefix.length);
    if (!suffix || autolinkBoundaryIndex(suffix) !== 0) continue;
    return { href: url, label: prefix, suffix };
  }
  return null;
}

export function normalizeLocalPath(value, { decode = false } = {}) {
  let target = String(value || "").trim();
  if (!target) return "";
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim();
  if (/^file:/i.test(target)) {
    try {
      const url = new URL(target);
      const host = url.hostname || "";
      if (host && host !== "localhost" && !/^[a-zA-Z]$/.test(host)) return "";
      let path = decodeURIComponent(url.pathname || "");
      if (/^[a-zA-Z]$/.test(host)) path = `${host}:${path}`;
      target = path;
    } catch {
      return "";
    }
  } else if (decode) {
    try {
      target = decodeURIComponent(target);
    } catch {
      // A literal percent is a valid filename character, not necessarily an escape.
      if (/%[0-9a-f]{2}/i.test(target)) return "";
    }
  }
  target = target.replaceAll("\\", "/");
  if (/^\/[a-zA-Z]:/.test(target)) target = target.slice(1);
  if (target.startsWith("./")) target = target.slice(2);
  return target;
}

function canonicalLocalPath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function toWorkspaceRelativePath(workspaceRoot, requestedPath) {
  const requested = normalizeLocalPath(requestedPath);
  if (!requested) return "";
  const root = canonicalLocalPath(workspaceRoot);
  if (!root) return requested;
  const trimmed = requested.replace(/\/+$/, "");
  const full = canonicalLocalPath(trimmed);
  if (full === root) return ".";
  if (full.startsWith(`${root}/`)) return trimmed.slice(root.length + 1);
  return requested;
}

export function classifyLink(value) {
  const href = String(value || "").trim();
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return null;
  if (/^https?:\/\//i.test(href)) {
    try { return { kind: "web", href: new URL(href).href }; } catch { return null; }
  }
  if (href.startsWith("#")) return { kind: "anchor", href };
  if (!/^file:/i.test(href) && /^[a-z][a-z\d+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return null;
  let target = href;
  let line = null;
  const suffix = target.match(/(?::(\d+)(?::\d+)?|#L(\d+))$/i);
  if (suffix) { line = Number(suffix[1] || suffix[2]); target = target.slice(0, suffix.index); }
  target = normalizeLocalPath(target, { decode: true });
  if (!target || /[\u0000-\u001f\u007f]/.test(target) || /^[\\/]{2}/.test(target)) return null;
  return { kind: "file", target, line: line > 0 && Number.isSafeInteger(line) ? line : null, href };
}

export function messageLinkUrl(value) {
  return classifyLink(value) ? value : "";
}
