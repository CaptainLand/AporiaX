import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer, preview } from "vite";
import { chromium } from "playwright-core";
import JSZip from "jszip";

const baseline = process.env.WORKSPACE_BASELINE === "1";
const production = process.env.WORKSPACE_PRODUCTION === "1";
const zip = new JSZip();
zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/><w:color w:val="246A92"/><w:sz w:val="40"/></w:rPr><w:t>工作区 Word 阅读</w:t></w:r></w:p><w:tbl><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>模块</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>文件预览</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>');
const docx = await zip.generateAsync({ type: "base64" });
const server = production ? await preview({ preview: { host: "127.0.0.1", port: 0 } }) : await createServer({ server: { host: "127.0.0.1", port: 0, open: false, watch: null } });
let browser;
try {
  if (!production) await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, bypassCSP: !production });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ docx, baseline }) => {
    if (!sessionStorage.getItem("workspace-fixture-seeded")) {
      localStorage.clear();
      localStorage.setItem("aporiax.language.v1", "zh-CN");
      localStorage.setItem("aporiax.session-ui.v1", JSON.stringify({ taskId: "workspace-fixture", view: "workspace", workspaceFocusPath: baseline ? "" : "guide.md", welcomeDismissed: true }));
      sessionStorage.setItem("workspace-fixture-seeded", "1");
    }
    const task = { id: "workspace-fixture", title: "文件预览测试", workspacePath: "D:/Fixture", workspaceName: "示例工作区", providerId: "own", modelId: "own-model", effort: "high", messages: [{ id: "turn-1", role: "assistant", status: "completed", content: "文件已保存", changes: [{ path: "guide.md", additions: 2, deletions: 0 }], anchor: { status: "completed", snapshotComplete: true } }], createdAt: new Date().toISOString() };
    const texts = { "guide.md": "# 格式化 Markdown\n\n| 模块 | 状态 |\n| --- | --- |\n| 预览 | 正常 |\n\n```js\nconst ready = true;\n```\n", "app.js": "const answer = 42;\nconsole.log(answer);", "nested/notes.md": "# 子目录文档\n", "slow.md": "# 旧的慢响应\n" };
    const names = ["guide.md", "report.docx", "pixel.png", "app.js", "broken.docx", "slow.md", "nested"];
    const fixture = window.fixture = { calls: [], texts };
    window.desktop = {
      theme: { set: async () => {} }, account: { get: async () => ({ status: "anonymous" }) },
      providers: { list: async () => [{ id: "own", name: "自己的 API", models: [{ id: "own-model", name: "Own model" }] }] },
      tasks: { load: async () => [task], save: async () => {} }, harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
      sandbox: { status: async () => ({ localAvailable: true }) },
      workspace: {
        listTree: async (workspacePath, directory = ".") => ({ entries: (directory === "." ? names : ["nested/notes.md"]).map((path) => ({ path, name: path.split("/").at(-1), type: path === "nested" ? "directory" : "file" })) }),
        readPreview: async (workspacePath, path) => { fixture.calls.push({ action: "preview", path }); if (path === "slow.md") await new Promise((resolve) => setTimeout(resolve, 200)); return path.endsWith("docx") ? { path, binary: true, artifact: { format: "docx", paragraphs: 2, tables: 1 } } : { path, content: texts[path] || "", binary: false }; },
        saveText: async (input) => { fixture.calls.push({ action: "save", ...input }); if (texts[input.requestedPath] !== input.expectedContent) throw new Error("File changed externally"); texts[input.requestedPath] = input.content; return { path: input.requestedPath, content: input.content }; },
        restoreAnchor: async (input) => { fixture.calls.push({ action: "restore", ...input }); return { success: false }; },
      },
      understanding: { projects: async () => [], get: async () => ({ facts: [], revisions: [], settings: {} }) },
      links: { activate: async (input) => { fixture.calls.push(input); return { ok: true }; } },
      workbench: { subscribe: () => () => {}, request: async (input) => {
        fixture.calls.push(input);
        if (input.action === "list") return [];
        if (input.action === "file") return input.path.endsWith("docx") ? { kind: "docx", data: input.path === "broken.docx" ? "YmFk" : docx } : { kind: "image", mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=" };
        if (input.action === "search") return { entries: names.filter((path) => path.includes(input.query)).map((path) => ({ path })) };
        return true;
      } },
    };
  }, { docx, baseline });
  await page.goto(server.resolvedUrls.local[0], { waitUntil: "domcontentloaded" });
  await page.locator(".ax-welcome__enter, .thread-view-tabs").first().waitFor({ timeout: 30000 });
  if (await page.locator(".ax-welcome__enter").isVisible()) await page.locator(".ax-welcome__enter").click();
  await page.locator(".thread-view-tabs").getByRole("button", { name: "工作区", exact: true }).click();
  const panel = page.locator(".thread-view-panel.workspace-panel");
  const file = (path) => panel.locator(".workspace-tree button").filter({ has: page.locator(".workspace-tree-name", { hasText: new RegExp(`^${path.replaceAll(".", "\\.")}$`) }) });
  await file("report.docx").click();
  await mkdir(".tmp/workspace-preview", { recursive: true });
  if (baseline) {
    await panel.locator(".office-artifact-review").waitFor();
    assert.equal(await panel.locator('iframe[title="Word 文档预览"]').count(), 0);
    assert.equal(await panel.locator(".anchor-history").isVisible(), true);
    await page.screenshot({ path: ".tmp/workspace-preview/before.png" });
    console.log("BASELINE: main workspace shows artifact stats instead of styled DOCX; Anchor card always occupies space.");
  } else {
    const frame = panel.frameLocator('iframe[title="Word 文档预览"]');
    await frame.getByText("工作区 Word 阅读", { exact: true }).waitFor();
    assert.equal(await frame.locator("table").count(), 1);
    assert.equal(await frame.getByText("工作区 Word 阅读", { exact: true }).evaluate((el) => getComputedStyle(el).color), "rgb(36, 106, 146)");
    assert.equal(await panel.locator(".office-artifact-review").count(), 0);
    assert.equal(await panel.locator(".anchor-history").count(), 0, "Anchor is hidden by default without a saved preference");
    await panel.getByRole("button", { name: "显示 Anchor 快照", exact: true }).click();
    assert.equal(await panel.locator(".anchor-history").isVisible(), true);
    await panel.getByRole("button", { name: "隐藏 Anchor 快照", exact: true }).click();
    assert.equal(await panel.locator(".anchor-history").count(), 0);
    const toggle = panel.getByRole("button", { name: "显示 Anchor 快照", exact: true });
    const toggleBox = await toggle.boundingBox(), refreshBox = await panel.getByRole("button", { name: "刷新文件", exact: true }).boundingBox();
    assert.ok(toggleBox.width >= 78 && toggleBox.x + toggleBox.width <= refreshBox.x, "Anchor label fits without overlapping refresh");
    await page.screenshot({ path: ".tmp/workspace-preview/word-light.png" });
    await file("guide.md").click();
    await panel.getByRole("heading", { name: "格式化 Markdown", exact: true }).waitFor();
    assert.equal(await panel.locator(".workbench-markdown td").count(), 2);
    assert.ok(await panel.locator(".hljs-keyword").count());
    await panel.getByRole("button", { name: "源码", exact: true }).click();
    await panel.locator(".workbench-code").waitFor();
    await panel.getByRole("button", { name: "阅读", exact: true }).click();
    await file("pixel.png").click();
    await page.waitForFunction(() => document.querySelector('.workspace-panel .workbench-image img')?.naturalWidth > 0);
    await file("broken.docx").click();
    await panel.getByRole("alert").waitFor();
    await file("slow.md").click();
    await file("app.js").click();
    await panel.locator(".workbench-code").getByText("const answer = 42;", { exact: true }).waitFor();
    await page.waitForTimeout(250);
    assert.equal(await panel.getByText("旧的慢响应", { exact: true }).count(), 0);
    await file("nested").click();
    await file("notes.md").click();
    await panel.getByRole("heading", { name: "子目录文档", exact: true }).waitFor();
    await file("guide.md").click();
    await panel.getByRole("button", { name: "在侧栏打开或编辑", exact: true }).click();
    const side = page.locator(".workbench-panel");
    await side.getByRole("heading", { name: "格式化 Markdown", exact: true }).waitFor();
    await side.getByRole("button", { name: "编辑", exact: true }).click();
    await side.getByRole("textbox", { name: "代码编辑器", exact: true }).fill("# 侧栏未保存草稿\n");
    await panel.getByRole("button", { name: "刷新文件", exact: true }).click();
    await panel.getByRole("heading", { name: "格式化 Markdown", exact: true }).waitFor();
    assert.equal(await side.getByRole("textbox", { name: "代码编辑器", exact: true }).inputValue(), "# 侧栏未保存草稿\n", "Main preview refresh must preserve the sidebar draft");
    await side.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => window.fixture.texts["guide.md"].includes("侧栏未保存草稿"));
    await panel.getByRole("button", { name: "刷新文件", exact: true }).click();
    await panel.getByRole("heading", { name: "侧栏未保存草稿", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.fixture.calls.some((call) => call.action === "restore")), false, "Hiding Anchor must not restore or delete snapshots");
    await page.locator(".thread-view-tabs").getByRole("button", { name: "工作区", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "在侧栏打开", exact: true }).click();
    assert.equal(await side.getByRole("button", { name: "显示 Anchor 快照", exact: true }).evaluate((el) => el.scrollWidth <= el.clientWidth), true);
    await side.getByRole("button", { name: "显示 Anchor 快照", exact: true }).click();
    assert.equal(await panel.locator(".anchor-history").isVisible(), true, "Visibility changes are shared between main and sidebar");
    assert.equal(await side.locator(".file-explorer-panel.tree-only").isVisible(), true, "Revealing the initial file must not switch the sidebar away from its workspace tab");
    await panel.getByRole("button", { name: "隐藏 Anchor 快照", exact: true }).click();
    await page.getByRole("textbox", { name: "任务输入", exact: true }).fill("预览时仍可继续聊天");
    await page.locator(".thread-view-tabs").getByRole("button", { name: "对话", exact: true }).click();
    assert.equal(await page.getByRole("textbox", { name: "任务输入", exact: true }).inputValue(), "预览时仍可继续聊天");
    await page.locator(".thread-view-tabs").getByRole("button", { name: "工作区", exact: true }).click();
    await page.reload();
    if (await page.locator(".ax-welcome__enter").isVisible()) await page.locator(".ax-welcome__enter").click();
    await page.locator(".thread-view-tabs").getByRole("button", { name: "工作区", exact: true }).click();
    await panel.getByRole("button", { name: "显示 Anchor 快照", exact: true }).waitFor();
    assert.equal(await panel.locator(".anchor-history").count(), 0, "Anchor visibility survives restarting the UI");
    if (await page.locator(".workbench-panel button[title='收起侧栏']").isVisible()) await page.locator(".workbench-panel button[title='收起侧栏']").click();
    await file("guide.md").click();
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.setViewportSize({ width: 1050, height: 800 });
    await page.screenshot({ path: ".tmp/workspace-preview/markdown-dark.png" });
    assert.equal(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
    console.log(`PASS workspace preview (${production ? "production CSP" : "dev"}): styled DOCX/Markdown/code/image/error, stale-response isolation, nested tree, sidebar editing/draft safety/refresh, Anchor hide/show/shared state/persistence without restore.`);
  }
  assert.deepEqual(errors, []);
} finally { await browser?.close(); if (production) await new Promise((resolve) => server.httpServer.close(resolve)); else await server.close(); }
