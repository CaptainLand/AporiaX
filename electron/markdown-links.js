import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { classifyLink } from "./link-target.js";

const parser = unified().use(remarkParse).use(remarkGfm);

// Same grammar as the UI; spaces, nested parentheses and references are valid.
export function localMarkdownLinks(content) {
  const tree = parser.parse(String(content || ""));
  const definitions = new Map();
  const walk = (node, visit) => { visit(node); node.children?.forEach((child) => walk(child, visit)); };
  walk(tree, (node) => { if (node.type === "definition") definitions.set(node.identifier, node.url); });
  const result = [];
  const text = (node) => node.value || (node.children || []).map(text).join("");
  walk(tree, (node) => {
    const href = node.type === "link" ? node.url : node.type === "linkReference" ? definitions.get(node.identifier) : null;
    if (!href) return;
    const link = classifyLink(href);
    if (link?.kind === "file") result.push({ ...link, label: text(node), start: node.position.start.offset, end: node.position.end.offset });
  });
  return result;
}
