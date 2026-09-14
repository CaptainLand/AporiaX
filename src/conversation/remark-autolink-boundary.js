import { splitAutolinkBoundary } from "../../electron/link-target.js";

function linkText(node) {
  return (node?.children || [])
    .map((child) => (child.type === "text" ? child.value : linkText(child)))
    .join("");
}

function walk(node) {
  if (!Array.isArray(node?.children)) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    walk(child);
    if (child?.type !== "link") continue;
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
  return (tree) => walk(tree);
}
