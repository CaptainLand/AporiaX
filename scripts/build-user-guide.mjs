import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, process.argv[2] || "output/user-guide");
const markdown = await readFile(join(root, "docs/USER_GUIDE.zh-CN.md"), "utf8");
const assets = ["route.png", "workspace.png", "sidebar-documents.png", "sidebar-browser.png", "understanding.png"];
const toc = [];
const ids = new Set();
const escape = (text) => String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const plain = (node) => node.value || (node.children || []).map(plain).join("");

// Explicit anchors work in GitHub Markdown and become semantic heading IDs here.
function guideHeadings() {
  return (tree) => {
    let pendingId = "";
    for (const node of tree.children) {
      if (node.type === "html" || (node.type === "paragraph" && node.children.every((child) => child.type === "html"))) {
        const match = plain(node).match(/^<a id="([a-z][a-z0-9-]*)"><\/a>$/);
        if (!match) throw new Error("Only explicit guide anchors are permitted in Markdown HTML");
        pendingId = match[1];
      } else if (node.type === "heading" && node.depth === 2) {
        if (!pendingId || ids.has(pendingId)) throw new Error("Missing or duplicate guide anchor");
        ids.add(pendingId);
        node.data = { ...node.data, hProperties: { id: pendingId, tabIndex: -1 } };
        toc.push({ id: pendingId, title: plain(node) });
        pendingId = "";
      }
    }
  };
}

const content = renderToStaticMarkup(React.createElement(ReactMarkdown, {
  remarkPlugins: [remarkGfm, guideHeadings],
  skipHtml: true,
  components: {
    a: ({ href, children }) => {
      if (!href || (!href.startsWith("#") && !href.startsWith("https://"))) throw new Error("Unexpected tutorial link");
      return React.createElement("a", { href, ...(href.startsWith("https://") ? { target: "_blank", rel: "noopener noreferrer" } : {}) }, children);
    },
    img: ({ src, alt }) => {
      if (!assets.some((name) => src === `assets/${name}`)) throw new Error(`Unapproved guide image: ${src}`);
      return React.createElement("figure", null,
        React.createElement("a", { href: src, target: "_blank", rel: "noopener noreferrer", title: "查看原图" }, React.createElement("img", { src, alt, loading: "lazy", width: 1996, height: 1108 })),
        React.createElement("figcaption", null, alt));
    },
    // Markdown paragraphs around images must not create invalid <p><figure> nesting.
    p: ({ node, children }) => React.createElement(node.children?.some((child) => child.tagName === "img") ? "div" : "p", null, children),
    table: ({ children }) => React.createElement("div", { className: "table-scroll", tabIndex: 0, role: "region", "aria-label": "可横向滚动的表格" }, React.createElement("table", null, children)),
  },
}, markdown));
for (const match of markdown.matchAll(/\]\(#([a-z0-9-]+)\)/g)) {
  if (!ids.has(match[1])) throw new Error(`Broken guide anchor: ${match[1]}`);
}
const tocMarkup = toc.map(({ id, title }) => `<a href="#${id}">${escape(title)}</a>`).join("\n");
const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="AporiaX 中文使用教程：添加 API Key、开始第一个任务，了解文件侧栏、Git、项目知识、Skill 与 MCP。">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'">
  <title>AporiaX 使用教程 · 从添加 API Key 开始</title>
  <link rel="icon" href="assets/aporiax-icon.png">
  <link rel="stylesheet" href="style.css">
</head>
<body id="top">
  <a class="skip-link" href="#content">跳到正文</a>
  <header class="site-header">
    <a class="brand" href="../"><img src="assets/aporiax-icon.png" width="28" height="28" alt="">AporiaX <span>使用教程</span></a>
    <nav aria-label="站点导航"><a href="../">返回官网</a><a href="https://github.com/CaptainLand/AporiaX/releases/latest" target="_blank" rel="noopener noreferrer">下载应用 ↗</a></nav>
  </header>
  <div class="layout">
    <aside><div class="toc-title">使用指南 <span>1.0.0-preview</span></div><nav aria-label="教程目录">${tocMarkup}</nav><div class="aside-footer"><a href="AporiaX-使用教程.md" download>下载 Markdown 文档 ↓</a><p>可用浏览器打印保存为 PDF。</p></div></aside>
    <main id="content" tabindex="-1"><div class="edition">APORIAX / GETTING STARTED</div><article>${content}</article><footer><a href="#top">回到顶部 ↑</a><a href="../">返回 Aporia Web</a></footer></main>
  </div>
</body>
</html>
`;
await mkdir(join(output, "assets"), { recursive: true });
await writeFile(join(output, "index.html"), page, "utf8");
await writeFile(join(output, "AporiaX-使用教程.md"), markdown, "utf8");
await copyFile(join(root, "docs/guide/site.css"), join(output, "style.css"));
await copyFile(join(root, "public/aporiax-icon.png"), join(output, "assets/aporiax-icon.png"));
for (const name of assets) await copyFile(join(root, "docs/assets", name), join(output, "assets", name));
console.log(`Built ${toc.length} guide chapters in ${output}; only allowlisted public assets copied.`);
