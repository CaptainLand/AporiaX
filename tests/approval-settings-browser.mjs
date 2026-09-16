import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";
const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + "tests/fixtures/approval-settings.html");
  await page.getByRole("button", { name: "沙箱恢复目录", exact: true }).click();
  assert.equal(await page.evaluate(() => window.recoveryOpenCount), 1);
  const group = page.locator('[aria-label="审批模式"]');
  await group.getByRole("button", { name: "全自动", exact: true }).waitFor();
  assert.equal(await group.getByRole("button", { name: "全自动", exact: true }).getAttribute("class"), "active");
  await group.getByRole("button", { name: "手动", exact: true }).click();
  assert.equal(await page.evaluate(() => window.approvalFixture.approvalMode), "manual");
  await group.getByRole("button", { name: "智能", exact: true }).click();
  assert.equal(await page.evaluate(() => window.approvalFixture.approvalMode), "smart-auto");
  await group.getByRole("button", { name: "全自动", exact: true }).click();
  assert.equal(await page.evaluate(() => window.approvalFixture.approvalMode), "full-auto");
  await page.getByText(/无需首次批准/).waitFor();
  const execution = page.locator('[aria-label="命令执行模式"]');
  assert.equal(await execution.getByRole("button", { name: "直接", exact: true }).getAttribute("class"), "active");
  await execution.getByRole("button", { name: "隔离", exact: true }).click();
  assert.equal(await page.evaluate(() => window.approvalFixture.executionMode), "isolated");
  await execution.getByRole("button", { name: "安全", exact: true }).click();
  assert.equal(await page.evaluate(() => window.approvalFixture.executionMode), "safe");
  for (const lang of ["zh-CN", "en"]) {
    for (const theme of ["light", "dark"]) {
      for (const width of [280, 304, 420]) {
        await page.goto(server.resolvedUrls.local[0] + `tests/fixtures/approval-settings.html?width=${width}&lang=${lang}&theme=${theme}`);
        const approval = page.locator('[aria-label="' + (lang === "en" ? "Approval mode" : "审批模式") + '"]');
        await approval.locator("button").first().waitFor();
        const layout = await approval.evaluate((el) => ({
          direction: getComputedStyle(el).flexDirection,
          width: el.getBoundingClientRect().width,
          buttons: [...el.children].map((b) => ({ top: b.getBoundingClientRect().top, width: b.getBoundingClientRect().width, client: b.clientWidth, scroll: b.scrollWidth })),
        }));
        assert.equal(layout.direction, "row");
        assert(layout.width > 200, JSON.stringify(layout));
        assert(layout.buttons.every((b) => b.width > 60 && b.scroll <= b.client + 1 && Math.abs(b.top - layout.buttons[0].top) < 1), JSON.stringify(layout));
        await page.locator(".approval-mode-details summary").click();
        assert(await page.locator(".approval-mode-details p").isVisible());
      }
    }
  }
  for (const mode of ["safe", "isolated", ""]) {
    await page.goto(server.resolvedUrls.local[0] + `tests/fixtures/approval-settings.html?execution=${mode}`);
    await page.locator('[aria-label="命令执行模式"] button.active').waitFor();
    assert.equal(await page.locator('[aria-label="命令执行模式"] button.active').innerText(), mode === "safe" ? "安全" : mode === "isolated" ? "隔离" : "直接");
  }
  await mkdir(".tmp/settings-regression", { recursive: true });
  await page.locator(".sandbox-auto-approval").scrollIntoViewIfNeeded();
  await page.locator(".sandbox-auto-approval").screenshot({ path: ".tmp/settings-regression/approval-fixed.png" });
  assert.deepEqual(errors, []);
  console.log("React settings: default Direct/full-auto, explicit modes preserved, 280/304/420px x Chinese/English x light/dark, horizontal buttons without clipping, risk disclosure and switches, no page errors: PASS");
} finally { await browser?.close(); await server.close(); }
