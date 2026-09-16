import { splitAutolinkBoundary } from "../../electron/link-target.js";

function linkText(node) {
  return (node?.children || [])
    .map((child) => (child.type === "text" ? child.value : linkText(child)))
    .join("");
}

function walk(node, source) {
  if (!Array.isArray(node?.children)) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    walk(child, source);
    if (child?.type !== "link") continue;
    const start = child.position?.start?.offset;
    const end = child.position?.end?.offset;
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    // Preserve [label](href), reference links and <explicit URLs> verbatim.
    const original = source.slice(start, end);
    if (!/^(?:https?:\/\/|www\.)/i.test(original)) continue;
    const split = splitAutolinkBoundary(child.url, linkText(child));
    if (!split) continue;
    child.url = split.href;
    if (!split.suffix) continue;
    child.children = [{ type: "text", value: split.label }];
    node.children.splice(i + 1, 0, { type: "text", value: split.suffix });
    i += 1;
  }
}

export function remarkAutolinkBoundary() {
  return (tree, file) => walk(tree, String(file || ""));
}
