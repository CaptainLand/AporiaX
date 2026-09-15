import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright-core";
const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + "tests/fixtures/extension-library.html");
  await page.getByRole("button", { name: "配置", exact: true }).click();
  assert.match(await page.locator("textarea").inputValue(), /Bearer \$\{CONTEXT7_API_KEY\}/);
  const enableNew = page.getByRole("switch", { name: "Enable for future tasks" }); assert.equal(await enableNew.isChecked(), false);
  await page.evaluate(() => { window.fixture.fail = true; });
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByRole("status").filter({ hasText: "Cannot save config" }).waitFor();
  assert(await page.getByRole("button", { name: "保存配置" }).isVisible(), "failed saves retain the form and credentials");
  await page.evaluate(() => { window.fixture.fail = false; });
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.waitForFunction(() => window.fixture.saves.length === 1);
  assert.equal(await page.evaluate(() => window.fixture.saves[0].server.headers.Authorization), "Bearer ${CONTEXT7_API_KEY}");
  assert.equal(await page.evaluate(() => window.fixture.saves[0].server.enabled), false);
  await page.getByRole("button", { name: "已安装", exact: true }).click();
  assert(await page.getByText("缺少环境变量: GITHUB_MCP_TOKEN").isVisible());
  assert(await page.getByText("Unsupported MCP transport: legacy-sse").isVisible());
  assert(await page.getByRole("button", { name: "探测", exact: true }).nth(1).isDisabled());
  await page.getByRole("button", { name: "探测", exact: true }).first().click();
  await page.locator(".extension-installed-verification").filter({ hasText: "探测连接已关闭" }).waitFor();
  const toggle = page.getByRole("switch", { name: "后续任务启用 文档服务" }); await toggle.click();
  await page.waitForFunction(() => window.fixture.toggles.length === 1);
  await page.getByRole("button", { name: "回退到上一版" }).click();
  await page.waitForFunction(() => window.fixture.rollbacks.length === 1);
  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 460, height: 900 });
    await page.goto(server.resolvedUrls.local[0] + `tests/fixtures/extension-library.html?theme=${theme}`);
    await page.getByRole("button", { name: "已安装", exact: true }).click();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "settings rows must fit a narrow panel");
  }
  assert.deepEqual(errors, []);
  console.log("Extension settings browser: credentials preserved, failed save retained, disabled defaults, missing-key/error states, probe, toggle, rollback, light/dark narrow layout: PASS");
} finally { await browser?.close(); await server.close(); }
