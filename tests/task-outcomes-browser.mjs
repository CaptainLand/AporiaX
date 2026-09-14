import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright-core";
const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage();
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + "tests/fixtures/task-outcomes.html");
  for (const title of ["部分完成", "等待补充信息", "任务受阻", "已交付 · 未验证", "运行失败", "任务已停止"]) {
    await page.locator(".assistant-message-heading strong").filter({ hasText: title }).waitFor();
  }
  assert.equal(await page.locator(".assistant-message").count(), 6);
  assert.equal(await page.getByRole("link", { name: "成果", exact: true }).getAttribute("href"), "https://example.invalid/result");
  assert.deepEqual(errors, []);
  console.log("Task outcomes browser: six real conversation states, unverified delivery, artifact link, no runtime exceptions: PASS");
} finally { await browser?.close(); await server.close(); }
