// Shared, browser-safe classification. Unknown schemes must never reach shell.openExternal.
export function classifyLink(value) {
  const href = String(value || "").trim();
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return null;
  if (/^https?:\/\//i.test(href)) {
    try { return { kind: "web", href: new URL(href).href }; } catch { return null; }
  }
  if (href.startsWith("#")) return { kind: "anchor", href };
  if (!/^file:\/\//i.test(href) && /^[a-z][a-z\d+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return null;
  let target = href;
  let line = null;
  const suffix = target.match(/(?::(\d+)(?::\d+)?|#L(\d+))$/i);
  if (suffix) { line = Number(suffix[1] || suffix[2]); target = target.slice(0, suffix.index); }
  if (/^file:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      if (url.hostname && url.hostname !== "localhost") return null;
      target = decodeURIComponent(url.pathname);
    } catch { return null; }
  } else {
    try { target = decodeURIComponent(target); } catch { return null; }
  }
  if (/^\/[a-z]:[\\/]/i.test(target)) target = target.slice(1);
  if (!target || /[\u0000-\u001f\u007f]/.test(target) || /^[\\/]{2}/.test(target)) return null;
  return { kind: "file", target, line: line > 0 && Number.isSafeInteger(line) ? line : null, href };
}

export function messageLinkUrl(value) {
  return classifyLink(value) ? value : "";
}
