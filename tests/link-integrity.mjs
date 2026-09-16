import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkAutolinkBoundary } from "../src/conversation/remark-autolink-boundary.js";
import { classifyLink, normalizeLocalPath, toWorkspaceRelativePath } from "../electron/link-target.js";
import { localMarkdownLinks } from "../electron/markdown-links.js";
import { checkWorkspaceFileLink } from "../electron/file-link-check.js";
import { validateDeliveryLinks } from "../electron/runtime/delivery-links.js";
import { extractLinkedFiles } from "../electron/workbench/present.js";
import { sanitizeFinalAnswer } from "../electron/runtime/conversation.js";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkAutolinkBoundary);
const parse = (source) => parser.runSync(parser.parse(source), { value: source });
const links = (node) => [ ...(node.type === "link" ? [node] : []), ...(node.children || []).flatMap(links) ];
const filename = "SeaLandX-B站用户资料简介-美化版.docx";
assert.equal(sanitizeFinalAnswer("[报告 🚀](报告🚀.docx)"), "[报告 🚀](报告🚀.docx)");
for (const href of [filename, "D:/市场/" + filename, "file:///D:/市场/" + filename, "https://例子.测试/资料（新版）?词=中文"]) {
  const node = links(parse(`[完整标签](${href})`))[0];
  assert.equal(node.url, href);
  assert.equal(node.children[0].value, "完整标签");
}
const quoted = "https://example.com/说明（中文版）";
assert.equal(links(parse(`<${quoted}>`))[0].url, quoted);
assert.equal(links(parse(`http://localhost:8080/报告.html（仅本机）`))[0].url, "http://localhost:8080/报告.html");
const reference = `[${filename}][doc]\n\n[doc]: <文件夹/${filename}>`;
assert.equal(localMarkdownLinks(reference)[0].target, "文件夹/" + filename);
assert.deepEqual(extractLinkedFiles('[**报告**](<out/my report (1).docx> "title")'), [{ path: "out/my report (1).docx", line: 1 }]);
assert.deepEqual(extractLinkedFiles("[代码](src/a(1).js:24)"), [{ path: "src/a(1).js", line: 24 }]);
assert.equal(localMarkdownLinks('`[伪链接](missing.txt)`\n\n```md\n[x](also-missing.txt)\n```').length, 0);
for (const name of [filename, "报告 #1 %20 100% 🚀.txt", "a%2fb.txt", "50%.md"]) {
  assert.equal(classifyLink(encodeURIComponent(name)).target, name);
  assert.equal(normalizeLocalPath(name), name);
  assert.equal(toWorkspaceRelativePath("D:/项目", "D:/项目/" + name), name);
}
assert.equal(classifyLink("50%.md").target, "50%.md");
assert.equal(classifyLink("%00.txt"), null);
assert.equal(classifyLink("https://example.com/中文").href, new URL("https://example.com/中文").href);

const root = await mkdtemp(join(tmpdir(), "aporia-link-integrity-"));
try {
  for (const name of [filename, "报告 #1 %20 100% 🚀.txt", "a%2fb.txt"]) {
    await writeFile(join(root, name), "fixture");
    const content = `[${name}](${encodeURIComponent(name)})`;
    const link = localMarkdownLinks(content)[0];
    assert.equal((await checkWorkspaceFileLink(root, link.target)).status, "exists");
    assert.equal(await validateDeliveryLinks(content, root), content);
  }
  await mkdir(join(root, "folder"));
  assert.equal((await checkWorkspaceFileLink(root, "folder")).directory, true);
  assert.equal((await checkWorkspaceFileLink(root, "../outside.txt")).status, "outside");
  assert.equal((await checkWorkspaceFileLink(join(root, "unmounted"), "a.txt")).status, "unavailable");
  const content = `[已有](${filename})\n\n[不存在](missing.docx)\n\n[引用][ref]\n\n[ref]: missing.docx\n\n[外部](../other.txt)`;
  const checked = await validateDeliveryLinks(content, root);
  assert.match(checked, /不存在（文件不存在）/);
  assert.match(checked, /引用（文件不存在）/);
  assert.match(checked, /\[外部\]\(\.\.\/other.txt\)/, "no outside workspace auto-read");
  assert.equal(localMarkdownLinks(checked).filter((link) => link.target === "missing.docx").length, 0);
  assert.equal(await validateDeliveryLinks(content, root, "en", async () => { throw new Error("IO failure"); }), content);
} finally { await rm(root, { recursive: true, force: true }); }
console.log("Link integrity: explicit/CJK/emoji/encoded paths, Markdown grammar, bounded advisory delivery checks PASS");
