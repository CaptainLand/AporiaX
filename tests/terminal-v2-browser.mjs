import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright-core";
const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false, watch: null } });
let browser, page;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + "tests/fixtures/terminal-v2.html");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const activeInput = () => page.waitForFunction(() => document.activeElement?.classList.contains("xterm-helper-textarea"));
  const menu = () => button("终端菜单").click();
  const lineVisible = (text) => page.waitForFunction((text) => {
    const buffer = window.terminal()?.term.buffer.active;
    return buffer && Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString()).some((line) => line.includes(text));
  }, text);
  await button("新建测试终端").click(); await activeInput();
  await lineVisible("PS D:");
  console.log("terminal UI: initial prompt");
  assert.equal(await page.locator(".workbench-xterm").evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(255, 255, 255)");
  assert.equal(await page.locator(".workbench-terminal-state").count(), 0);
  // Reproduce input on an idle/legacy immediate-read transport, including an
  // asynchronous shell echo that arrives after the write IPC has completed.
  await page.waitForTimeout(1050);
  await page.evaluate(() => { window.echoInputs = true; window.echoStart = performance.now(); });
  await page.keyboard.type("responsive");
  await lineVisible("responsive");
  const echoMs = await page.evaluate(() => performance.now() - window.echoStart);
  assert.ok(echoMs < 300, `Legacy echo waited for idle polling: ${echoMs}ms`);
  await page.evaluate(() => { window.echoInputs = false; window.terminal().term.focus(); });
  const cursor = page.locator(".xterm-rows.xterm-focus .xterm-cursor");
  await cursor.waitFor();
  assert.equal(await cursor.evaluate((el) => getComputedStyle(el).animationName), "none");
  assert.equal(await cursor.evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(48, 42, 55)");
  await page.evaluate(() => new Promise((done) => window.terminal().term.write("\x1b[?25l", done)));
  await page.locator(".xterm-cursor").waitFor({ state: "detached" });
  await page.evaluate(() => new Promise((done) => window.terminal().term.write("\x1b[?25h\x1b[?12h", done)));
  await cursor.waitFor();
  assert.equal(await cursor.evaluate((el) => getComputedStyle(el).animationName), "none", "Host blink request must not erase focused cursor");
  console.log(`terminal UI: idle delayed echo ${Math.round(echoMs)}ms, steady cursor, application hide/show respected`);
  await page.evaluate(() => { window.originalTerm = window.terminal(); window.appendOutput("terminal_1", "\r\n" + Array.from({ length: 450 }, (_, i) => `line-${i} 中文 test\r\n`).join("") + "PS D:\\Fixture> "); });
  await lineVisible("line-449");
  await page.evaluate(() => { const term = window.terminal().term; term.scrollToLine(20); term.selectLines(22, 22); window.beforeScroll = term.buffer.active.viewportY; window.beforeSelection = term.getSelection(); });
  await page.evaluate(() => window.wb.open("route"));
  await page.getByText("Changes fixture").waitFor();
  await page.evaluate(() => window.wb.select("terminal_1")); await page.locator(".xterm").waitFor();
  assert.equal(await page.evaluate(() => window.terminal() === window.originalTerm), true);
  assert.equal(await page.evaluate(() => window.terminal().term.getSelection() === window.beforeSelection), true);
  assert.equal(await page.evaluate(() => window.terminal().term.buffer.active.viewportY === window.beforeScroll), true);
  await page.evaluate(() => window.wb.collapse()); await page.locator(".xterm").waitFor({ state: "detached" });
  await page.evaluate(() => window.wb.expand()); await page.locator(".xterm").waitFor();
  assert.equal(await page.evaluate(() => window.terminal() === window.originalTerm), true);
  assert.equal(await page.evaluate(() => window.calls.filter((item) => item.action === "read" && item.id === "terminal_1" && !item.cursor).length), 1);
  await page.evaluate(() => window.terminal().term.focus()); await page.keyboard.press("Control+c");
  await page.waitForFunction(() => window.clipboardText === window.beforeSelection);
  await page.evaluate(() => window.terminal().term.clearSelection()); await page.keyboard.press("Control+c");
  await page.waitForFunction(() => window.calls.some((call) => call.action === "write" && call.data === "\x03"));
  console.log("terminal UI: cache/selection/copy/interrupt");
  await page.evaluate(() => window.terminal().term.scrollToLine(20));
  await button("回到底部").click(); await page.waitForFunction(() => window.terminal().snapshot.atBottom);

  await page.keyboard.press("Control+f"); await page.getByRole("textbox", { name: "搜索终端输出" }).fill("line-150");
  await page.waitForFunction(() => window.terminal().term.getSelection().includes("line-150"));
  await button("下一个匹配").click(); await button("上一个匹配").click(); await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "搜索终端输出" }).waitFor({ state: "detached" });
  await page.evaluate(() => window.clipboardText = "echo single"); await page.keyboard.press("Control+v");
  await page.waitForFunction(() => window.calls.some((call) => call.action === "write" && call.data.includes("echo single")));
  await page.evaluate(() => { window.clipboardText = "echo first\necho second"; window.writesBeforePaste = window.calls.filter((call) => call.action === "write").length; });
  await page.keyboard.press("Control+v"); await page.getByRole("dialog").waitFor();
  assert.equal(await page.evaluate(() => window.calls.filter((call) => call.action === "write").length === window.writesBeforePaste), true);
  await button("取消").click(); await activeInput();
  await page.keyboard.press("Control+v"); await button("确认粘贴").click();
  await page.waitForFunction(() => window.calls.some((call) => call.action === "write" && call.data.replaceAll("\r", "\n").includes("echo first\necho second")));
  // Real DOM capture path: no duplicate xterm paste and no execution before confirmation.
  await page.evaluate(() => { const data = new DataTransfer(); data.setData("text/plain", "alpha\nbeta"); document.querySelector(".xterm-helper-textarea").dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })); });
  await page.getByRole("dialog").waitFor(); await button("取消").click();
  console.log("terminal UI: search and paste");

  await menu(); await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  await page.getByRole("textbox", { name: "终端名称" }).fill("开发服务"); await button("保存名称").click();
  await page.getByRole("tab", { name: "开发服务" }).waitFor();
  await menu(); await button("放大终端字号").click(); assert.equal(await page.evaluate(() => window.terminal().term.options.fontSize), 15);
  await button("深色").click();
  await page.waitForFunction(() => document.querySelector(".terminal-pane").dataset.terminalTheme === "dark");
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.documentElement.dataset.theme = "light");
  assert.equal(await page.locator(".terminal-pane").getAttribute("data-terminal-theme"), "dark");
  await menu(); await button("跟随").click(); await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".terminal-pane").dataset.terminalTheme === "light");
  await page.evaluate(() => { window.terminal().term.clearSelection(); window.terminal().term.scrollToBottom(); });
  await mkdir(".tmp/terminal-v2", { recursive: true });
  await page.screenshot({ path: ".tmp/terminal-v2/light.png" });
  await page.evaluate(() => document.documentElement.dataset.theme = "dark");
  await page.setViewportSize({ width: 850, height: 740 }); await menu();
  await page.screenshot({ path: ".tmp/terminal-v2/dark-narrow.png" });
  assert.equal(await page.locator(".terminal-pane").evaluate((el) => el.scrollWidth <= el.clientWidth), true);
  await page.keyboard.press("Escape");

  // Agent-presented terminals must not steal the chat input; user-created ones do.
  console.log("terminal UI: theme/menu/rename");
  await page.getByRole("textbox", { name: "对话输入" }).focus();
  await page.evaluate(() => { window.wb.setLayout((layout) => ({ ...layout, follow: true })); });
  await page.evaluate(() => window.presentTerminal());
  await page.waitForFunction(() => window.wb.layout.active === "terminal_2");
  assert.equal(await page.getByRole("textbox", { name: "对话输入" }).evaluate((el) => el === document.activeElement), true);
  await button("新建测试终端").click(); await activeInput();
  await page.evaluate(() => { const r = window.resource("terminal_3"); r.output += "\r\n" + Array.from({ length: 2500 }, (_, i) => `tail-${i} ${"x".repeat(70)}\r\n`).join("") + "FINAL_EXIT_MARKER"; r.status = "exited"; r.exitCode = 7; });
  await page.waitForFunction(() => window.terminal().snapshot.drained, null, { timeout: 10000 }); await lineVisible("FINAL_EXIT_MARKER");
  assert.equal(await page.evaluate(() => window.terminal().snapshot.exitCode), 7);
  assert.ok(await page.evaluate(() => window.calls.filter((call) => call.action === "read" && call.id === "terminal_3").length) >= 3);
  await button("新建终端").click(); await activeInput();
  await page.evaluate(() => window.wb.select("terminal_3")); await lineVisible("FINAL_EXIT_MARKER");
  await page.evaluate(async () => { window.failStop = true; await window.wb.close("terminal_3"); });
  assert.equal(await page.evaluate(() => Boolean(window.terminal("terminal_3"))), true);
  await page.evaluate(async () => { window.failStop = false; await window.wb.close("terminal_3"); });
  assert.equal(await page.evaluate(() => Boolean(window.terminal("terminal_3"))), false);
  await page.evaluate(() => { window.wb.select("terminal_4"); window.readFailureTarget = "terminal_4"; window.readFailures = 100; window.terminal("terminal_4").retry(); });
  await page.getByRole("alert").filter({ hasText: "Temporary fixture transport error" }).waitFor();
  await page.evaluate(() => { window.readFailures = 0; window.terminal("terminal_4").retry(); });
  await page.waitForFunction(() => window.terminal("terminal_4").snapshot.readFailure === "");
  await page.evaluate(() => { window.wb.open("route"); window.appendOutput("terminal_4", "\r\nBACKGROUND_OUTPUT"); });
  await page.waitForFunction(() => {
    const buffer = window.terminal("terminal_4").term.buffer.active;
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString()).some((line) => line.includes("BACKGROUND_OUTPUT"));
  });
  await page.evaluate(() => window.wb.select("terminal_4")); await lineVisible("BACKGROUND_OUTPUT");
  const idleReads = await page.evaluate(() => window.calls.filter((call) => call.action === "read").length);
  await page.waitForTimeout(1600);
  assert.ok((await page.evaluate(() => window.calls.filter((call) => call.action === "read").length)) - idleReads < 12, "Idle sessions should use adaptive polling, not 150ms per session");
  assert.deepEqual(errors, []);
  console.log("PASS: terminal v2 actual xterm browser: stable instance/selection/scroll, collapse, no replay, focus intent, copy vs interrupt, search, confirmed clipboard/native paste, rename, themes/font size, narrow layout, full paged exit tail, failed close preserves session, successful close disposes; no page errors.");
} catch (error) {
  if (page) { await mkdir(".tmp/terminal-v2", { recursive: true }); await page.screenshot({ path: ".tmp/terminal-v2/failure.png" }); }
  throw error;
} finally { await browser?.close(); await server.close(); }
