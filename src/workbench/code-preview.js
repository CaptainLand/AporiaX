// highlight.js may keep a span open across a newline. Balance each visual row
// without re-highlighting individual lines (which loses multiline syntax state).
export function highlightedRows(html) {
  const stack = [];
  return html.split("\n").map((line) => {
    const prefix = stack.join("");
    for (const token of line.match(/<span\b[^>]*>|<\/span>/g) || []) {
      if (token === "</span>") stack.pop();
      else stack.push(token);
    }
    return prefix + line + "</span>".repeat(stack.length);
  });
}
