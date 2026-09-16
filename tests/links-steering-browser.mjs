import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright-core";

// This smoke test never edits files; do not watch unrelated Android build trees.
const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error("Fixture page error:", error.message); });
  page.on("requestfailed", (request) => console.error("Fixture request failed:", request.url(), request.failure()?.errorText));
  await page.goto(server.resolvedUrls.local[0] + "tests/fixtures/links-steering.html");
  await page.getByRole("link", { name: "便携版", exact: true }).click();
  await page.getByRole("link", { name: "代码", exact: true }).click({ button: "right" });
  await page.getByRole("link", { name: "网页", exact: true }).click();
  await page.getByRole("link", { name: "缺失", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "File does not exist" }).waitFor();
  assert.equal(await page.getByRole("link", { name: /仅本机可访问/ }).count(), 0);
  await page.getByText("（仅本机可访问；8080").waitFor();
  await page.getByRole("link", { name: "http://localhost:8080/todo.html", exact: true }).click();
  const calls = await page.evaluate(() => window.linkCalls);
  assert.equal(calls[0].action, "open");
  assert.equal(calls[1].action, "menu");
  assert.equal(calls[1].workspacePath, "D:/Agent开发");
  assert.equal(calls[1].language, "zh-CN");
  assert.equal(calls[2].href, "https://example.com");
  assert.equal(calls[4].href, "http://localhost:8080/todo.html");
  const filename = "SeaLandX-B站用户资料简介-美化版.docx";
  await page.getByRole("link", { name: filename, exact: true }).click();
  await page.getByRole("link", { name: "报告 🚀", exact: true }).click();
  await page.getByRole("link", { name: "中文网页", exact: true }).click();
  await page.getByRole("link", { name: "引用文件", exact: true }).click();
  const unicodeCalls = (await page.evaluate(() => window.linkCalls)).slice(5);
  assert.equal(decodeURI(unicodeCalls[0].href), filename);
  assert.match(decodeURI(unicodeCalls[1].href), /🚀/);
  assert.equal(decodeURI(unicodeCalls[2].href), "https://example.com/资料（新版）");
  assert.equal(decodeURI(unicodeCalls[3].href), "文件夹/my report (1).docx");
  await page.evaluate(() => window.fixtureInsert());
  await page.getByText("改为便携版", { exact: true }).waitFor();
  // A delta still buffered when guidance is applied must stay in the old segment.
  await page.evaluate(() => {
    window.fixtureEmit({ runId: "r", type: "response.delta", delta: "旧段尾部" });
    window.fixtureEmit({ runId: "r", type: "steering.applied", messageIds: ["s"] });
    window.fixtureEmit({ runId: "r", type: "response.reset", round: 2 });
    window.fixtureEmit({ runId: "r", type: "response.delta", delta: "这是新要求的回复" });
  });
  await page.getByText("这是新要求的回复", { exact: true }).waitFor();
  const messages = await page.evaluate(() => window.fixtureTasks[0].messages);
  assert.deepEqual(messages.map((m) => m.id), ["u", "a-before-s", "s", "a"]);
  assert.ok(messages[1].content.endsWith("旧段尾部"));
  assert.equal(messages[3].content, "这是新要求的回复");
  assert.equal(messages[2].steeringStatus, "applied");
  assert.equal(await page.getByRole("link", { name: "便携版", exact: true }).count(), 1);
  assert.deepEqual(errors, []);
  await page.goto(server.resolvedUrls.local[0] + "tests/fixtures/links-steering.html?workbench");
  await page.getByRole("link", { name: filename, exact: true }).click();
  await page.waitForFunction((name) => window.fixtureWorkbench.layout.tabs.some((tab) => tab.path === name), filename);
  await page.getByRole("link", { name: "缺失", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "文件不存在或已移动" }).waitFor();
  assert.equal(await page.evaluate(() => window.fixtureWorkbench.layout.tabs.some((tab) => tab.path.includes("missing"))), false);
  assert.equal(await page.evaluate(() => window.fixtureWorkbench.openHref("report.txt", { workspacePath: "D:/different-task" })), false);
  await page.getByRole("link", { name: "便携版", exact: true }).click();
  assert.equal((await page.evaluate(() => window.linkCalls)).at(-1).action, "open", "installers use native confirm/open, not a binary text pane");
  assert.deepEqual(errors, []);
  console.log("Browser links, errors, buffered steering chronology: PASS");
} finally {
  await browser?.close();
  await server.close();
}
