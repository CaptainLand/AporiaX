import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright-core";
const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + "tests/fixtures/mention-regression.html");
  const input = page.getByRole("textbox", { name: "fixture-input" });
  await page.evaluate(() => {
    window.fixture.originalTree = window.desktop.workspace.listTree;
    window.fixture.originalMcp = window.desktop.core.mcp;
    window.fixture.fileReads = 0; window.fixture.mcpReads = 0;
    window.desktop.workspace.listTree = () => { window.fixture.fileReads++; return new Promise(resolve => { window.fixture.releaseFiles = () => resolve({ entries: [{ type: "file", path: "old.txt" }] }); }); };
    window.desktop.core.mcp = () => { window.fixture.mcpReads++; return new Promise(resolve => { window.fixture.releaseMcp = () => resolve({ servers: [] }); }); };
  });
  await input.fill("@skill:x"); await page.getByRole("option").filter({ hasText: "Fixture skill" }).waitFor({ timeout: 4000 });
  assert.deepEqual(await page.evaluate(() => [window.fixture.fileReads, window.fixture.mcpReads]), [0, 0], "explicit Skill must not scan files or wait for MCP");
  await input.fill("@old"); await page.waitForFunction(() => Boolean(window.fixture.releaseFiles));
  await page.evaluate(() => window.fixture.releaseFiles());
  await page.getByRole("option", { name: "old.txt", exact: true }).waitFor({ timeout: 4000 });
  await page.evaluate(() => {
    window.fixture.releaseMcp?.(); window.desktop.workspace.listTree = window.fixture.originalTree;
    window.desktop.core.mcp = window.fixture.originalMcp; window.dispatchEvent(new Event("focus"));
  });
  await input.fill("@old"); await page.getByRole("option", { name: "old.txt", exact: true }).waitFor();
  await input.evaluate(el => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true })));
  assert.equal(await input.inputValue(), "@old", "IME confirmation must not select a mention");
  assert.equal(await page.evaluate(() => window.fixture.sends), 0);
  await page.evaluate(() => window.fixture.files.push("new.txt"));
  await input.fill("@new"); await page.getByRole("option", { name: "new.txt", exact: true }).waitFor();
  await input.press("Tab"); assert.equal(await input.inputValue(), "@new.txt ");
  await input.fill("@{目录/说"); await page.getByRole("option", { name: "目录/说明.md", exact: true }).waitFor();
  await input.press("Enter"); assert.equal(await input.inputValue(), "@{目录/说明.md} ");
  await page.getByRole("button", { name: "No workspace", exact: true }).click();
  await input.fill("@skill:x"); await page.getByRole("option").filter({ hasText: "Fixture skill" }).waitFor();
  await input.press("Tab"); assert.equal(await input.inputValue(), "@skill:x ");
  await page.evaluate(() => { window.fixture.failSkills = true; window.dispatchEvent(new Event("focus")); });
  await input.fill("@mcp:docs"); await page.getByRole("option").filter({ hasText: "Docs" }).waitFor();
  await input.press("Tab"); assert.equal(await input.inputValue(), "@mcp:docs ");
  await page.evaluate(() => { window.desktop.workbench = { async request(input) {
    if (input.action === "list") return [{ kind: "browser", id: "browser_1", title: "Fixture page" }, { kind: "terminal", id: "terminal_1", title: "Fixture terminal" }];
    return null;
  } }; });
  await input.fill("@browser:"); await page.getByRole("option").filter({ hasText: "Fixture page" }).waitFor();
  await input.press("Tab"); assert.equal(await input.inputValue(), "@browser:browser_1 ");
  await input.fill("@terminal:"); await page.getByRole("option").filter({ hasText: "Fixture terminal" }).waitFor();
  await input.press("Tab"); assert.equal(await input.inputValue(), "@terminal:terminal_1 ");
  // Exercise the actual Composer handler as well, not just the hook.
  const composer = page.locator("textarea").nth(1); await composer.fill("中文输入");
  await composer.evaluate(el => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true })));
  assert.equal(await page.evaluate(() => window.fixture.sends), 0, "Composer must not submit IME Enter");
  assert.equal(await composer.inputValue(), "中文输入");
  assert.deepEqual(errors, []);
  console.log("Browser mentions: slow-source isolation, new-file refresh, Unicode/braces, IME selection + real Composer submit guard, no-workspace Skill, failed Skill catalog isolated from MCP: PASS");
} finally { await browser?.close(); await server.close(); }
