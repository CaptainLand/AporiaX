import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { _electron as electron } from "playwright-core";
const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false, watch: null } });
let application, page;
try {
  await server.listen();
  application = await electron.launch({ executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: [resolve("tests/fixtures/terminal-native-main.cjs")],
    env: { ...process.env, TERMINAL_TEST_URL: server.resolvedUrls.local[0] + "tests/fixtures/terminal-v2.html" } });
  page = await application.firstWindow();
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "新建测试终端", exact: true }).click();
  await page.waitForFunction(() => {
    const buffer = window.terminal()?.term.buffer.active;
    return buffer && buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString().includes(">");
  }, null, { timeout: 25000 });
  await page.waitForTimeout(1000);
  const inspect = () => page.evaluate(() => {
    const term = window.terminal().term, cursor = document.querySelector(".xterm-cursor");
    return { focus: document.activeElement?.className, cursor: cursor?.className || null,
      animation: cursor ? getComputedStyle(cursor).animationName : null,
      cursorColor: cursor ? getComputedStyle(cursor).backgroundColor : null,
      cursorRect: cursor ? { width: cursor.getBoundingClientRect().width, height: cursor.getBoundingClientRect().height } : null,
      line: term.buffer.active.getLine(term.buffer.active.baseY + term.buffer.active.cursorY)?.translateToString(true),
      rows: term.rows, cursorY: term.buffer.active.cursorY };
  });
  console.log("native prompt", JSON.stringify(await inspect()));
  const timings = [];
  for (const char of "echo") {
    await page.waitForTimeout(1050);
    await page.evaluate(() => { window.terminal().term.focus(); window.echoStart = performance.now(); window.echoBefore = window.terminal().term.buffer.active.cursorX; });
    await page.keyboard.type(char);
    await page.waitForFunction(() => window.terminal().term.buffer.active.cursorX !== window.echoBefore, null, { polling: 5 });
    timings.push(await page.evaluate(() => performance.now() - window.echoStart));
  }
  console.log("native typing echo (ms)", JSON.stringify(timings.map(Math.round)));
  console.log("native typed", JSON.stringify(await inspect()));
  await mkdir(".tmp/terminal-v2", { recursive: true });
  // A hidden Electron window is occluded for CDP Page.captureScreenshot. Use
  // Electron's explicit hidden-window capture instead of relying on that path.
  const screenshot = await application.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    return image.toPNG().toString("base64");
  });
  await writeFile(".tmp/terminal-v2/native-cursor.png", Buffer.from(screenshot, "base64"));
  if (!process.env.TERMINAL_BASELINE) {
    assert.ok(timings.every((ms) => ms < 300), "Idle key echo must not wait for the polling interval");
    const result = await inspect();
    assert.ok(result.cursorRect?.width >= 1 && result.cursorRect?.height >= 10, "Native prompt needs a visible cursor cell");
    assert.equal(result.animation, "none", "Focused cursor should not disappear during blinking");
    assert.equal(result.cursorColor, "rgb(48, 42, 55)");
  }
  // Cancel the unfinished echo command; never run a user command or touch a user's terminal.
  await page.keyboard.press("Control+c");
  if (!process.env.TERMINAL_BASELINE) {
    await page.evaluate(() => document.documentElement.dataset.theme = "dark");
    await page.waitForFunction(() => document.querySelector(".xterm-cursor") && getComputedStyle(document.querySelector(".xterm-cursor")).backgroundColor === "rgb(224, 220, 232)");
    await page.evaluate(() => window.wb.open("route"));
    await page.evaluate(() => window.wb.select(window.wb.layout.tabs.find((tab) => tab.kind === "terminal").id));
    await page.locator(".workbench-xterm").click();
    await page.waitForFunction(() => document.querySelector(".xterm-rows.xterm-focus .xterm-cursor"));
    console.log("PASS: native ConPTY → scoped IPC → real xterm echo latency, steady high-contrast cursor in both themes and refocus after tab switch.");
  }
  assert.deepEqual(errors, []);
} finally {
  if (page && !page.isClosed()) await page.evaluate(async () => { for (const resource of await window.wb.request({ action: "list" })) await window.wb.request({ action: "stop", id: resource.id, dispose: true }); });
  await application?.close(); await server.close();
}
