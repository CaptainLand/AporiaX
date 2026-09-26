import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright-core";
const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + "tests/fixtures/context-extensions.html");
  const curate = page.getByRole("switch", { name: "自动记录", exact: true });
  await curate.waitFor(); assert.equal(await curate.isChecked(), false);
  assert.equal(await page.getByRole("checkbox", { name: "参与任务上下文" }).count(), 0, "removed recall preference must stay removed");
  await curate.check();
  assert.equal(await curate.isChecked(), true); assert(await page.getByText("Saved database knowledge").isVisible());
  await page.evaluate(() => { window.fixture.fail = true; });
  await curate.click(); await page.getByRole("alert").waitFor(); assert.equal(await curate.isChecked(), true, "failed persistence does not falsely change UI state");
  await page.evaluate(() => window.fixture.emit({ type: "mcp.server.failed", serverId: "docs", error: "tools/list denied" }));
  const notices = page.getByLabel("扩展提示"); await notices.locator("summary").click();
  assert(await page.getByText("MCP docs: tools/list denied").isVisible());
  await page.evaluate(() => window.fixture.emit({ type: "mcp.server.connected", serverId: "docs" }));
  assert.equal(await notices.count(), 0, "retry success clears the warning");
  await page.evaluate(() => window.fixture.emit({ type: "skill.unresolved", unresolved: ["third-skill"] }));
  await notices.locator("summary").click(); assert(await page.getByText(/Skill third-skill/).isVisible());
  for (const lang of ["zh-CN", "en"]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(server.resolvedUrls.local[0] + `tests/fixtures/context-extensions.html?lang=${lang}&theme=${theme}`);
    await page.getByRole("switch").first().waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "controls must fit narrow panels");
  }
  assert.deepEqual(errors, []);
  console.log("Browser: current auto-recording toggle, viewable saved facts, persistence failure, MCP failure/recovery and missing Skills visible after completion; Chinese/English light/dark at 360px: PASS");
} finally { await browser?.close(); await server.close(); }
