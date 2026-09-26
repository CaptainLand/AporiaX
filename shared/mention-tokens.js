// One grammar for composer display, file context and extension selection.
// Whitespace / opening punctuation excludes email addresses and inline handles.
export function parseMentionTokens(text) {
  const source = String(text || "");
  const pattern = /(^|[\s（(【\[,，。!?！？;；])(@(?:\{[^}\r\n]+\}(?::\d+(?:-\d+)?)?|"[^"\r\n]+"(?::\d+(?:-\d+)?)?|(?:skill|mcp)(?::|\s+)[a-z0-9][a-z0-9_-]{0,63}|[^\s@{}"，。！？；：,!?;()（）【】\[\]]+))/giu;
  const tokens = [];
  for (const match of source.matchAll(pattern)) {
    const raw = match[2].replace(/[.]+$/u, "");
    let value = raw.slice(1);
    const extension = value.match(/^(skill|mcp)(?::|\s+)([a-z0-9][a-z0-9_-]{0,63})$/i);
    if (extension) {
      const following = source.slice(match.index + match[1].length + raw.length);
      if (following && !/^[\s,，。.!?！？;；:：)）\]】]/u.test(following)) continue;
    }
    const wrapped = value.match(/^(?:\{([^}]+)\}|"([^"]+)")(:\d+(?:-\d+)?)?$/u);
    if (wrapped) value = (wrapped[1] || wrapped[2]) + (wrapped[3] || "");
    const special = value.match(/^(browser|terminal|git):(.+)$/i);
    const kind = extension?.[1].toLowerCase() || special?.[1].toLowerCase() || "file";
    if (kind === "file" && ["skill", "mcp", ".", ""].includes(value.toLowerCase())) continue;
    tokens.push({ kind, value: extension ? extension[2].toLowerCase() : special ? special[2] : value.replace(/\\/g, "/").replace(/^\.\//, ""), raw,
      start: match.index + match[1].length, end: match.index + match[1].length + raw.length });
  }
  return tokens;
}

export function isComposingKey(event) {
  return Boolean(event?.isComposing || event?.nativeEvent?.isComposing || event?.keyCode === 229 || event?.nativeEvent?.keyCode === 229);
}
