import assert from "node:assert/strict";
import { preview } from "vite";
import { chromium } from "playwright-core";

const server = await preview({ preview: { host: "127.0.0.1", port: 0, open: false } });
let browser;
try {
  const base = server.resolvedUrls.local[0];
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage();
  await page.route("**/*", route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("aporiax.language.v1", "zh-CN");
    localStorage.setItem("aporiax.session-ui.v1", JSON.stringify({ welcomeDismissed: true, taskId: "fixture" }));
    const task = { id: "fixture", title: "重试测试", workspaceName: "测试", workspacePath: "D:/Fixture",
      providerId: "own", modelId: "fixture-model", messages: [] };
    window.fixture = { requests: [], interrupted: [], mode: "temporary" };
    window.desktop = {
      account: { get: async () => ({ status: "anonymous" }) },
      providers: { list: async () => [{ id: "own", name: "Fixture", baseUrl: "https://example.invalid/v1",
        hasApiKey: true, models: [{ id: "fixture-model", name: "Mock model" }] }] },
      tasks: { load: async () => [task], save: async () => {} },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [], activeRuns: async () => [],
        interrupt: async id => { window.fixture.interrupted.push(id); return false; },
        run: async request => {
          window.fixture.requests.push(request);
          return { status: "failed", error: true, content: window.fixture.mode === "temporary" ? "模拟临时限流" : "模拟登录失效",
            ...(window.fixture.mode === "temporary" ? { autoResume: { reason: "rate-limit", retryAfterMs: 0 } } : {}) };
        },
      },
      workspace: { listTree: async () => ({ entries: [] }) },
      workbench: { subscribe: () => () => {}, request: async ({ action }) => action === "list" ? [] : true },
    };
  });
  await page.goto(base);
  await page.locator(".ax-welcome__enter, .thread-view-tabs").first().waitFor();
  if (await page.locator(".ax-welcome__enter").isVisible()) await page.locator(".ax-welcome__enter").click();
  const openSettings = () => page.getByRole("button", { name: "打开 AporiaX 设置" }).click();
  const closeSettings = () => page.getByRole("button", { name: "关闭设置" }).click();
  const toggle = page.getByRole("switch", { name: "启用自动重试" });
  const one = page.getByRole("group", { name: "最多重试次数（不含首次）" }).getByRole("button", { name: "1 次", exact: true });
  const failure = page.getByRole("button", { name: "重试本轮" }).last();
  const pending = page.getByTestId("automatic-retry-pending");
  const requestLog = () => page.evaluate(() => window.fixture.requests);
  const send = async text => {
    await page.getByRole("textbox", { name: "任务输入", exact: true }).fill(text);
    await page.getByRole("button", { name: "发送", exact: true }).click();
  };
  await openSettings();
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  assert.equal(await one.isEnabled(), false);
  await toggle.click();
  await one.click();
  await closeSettings();
  await page.reload();
  if (await page.locator(".ax-welcome__enter").isVisible()) await page.locator(".ax-welcome__enter").click();
  await openSettings();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  assert.equal(await one.getAttribute("aria-pressed"), "true");
  await closeSettings();
  await send("原任务续跑测试");
  await pending.waitFor();
  await page.waitForFunction(() => window.fixture.requests.length === 2);
  await pending.waitFor({ state: "hidden" });
  await failure.waitFor();
  const [initial, retry] = await requestLog();
  assert.equal(retry.recoveryRunId, initial.runId);
  assert.equal(retry.sourceUserId, initial.sourceUserId);
  assert.equal(retry.prompt, initial.prompt);
  assert.equal(retry.retryMode, "continue");
  assert.equal(retry.automaticRetry, true);
  assert.equal(await page.getByText("原任务续跑测试", { exact: true }).count(), 1);
  await page.waitForTimeout(2300);
  assert.equal((await requestLog()).length, 2, "retry limit is enforced");

  await send("取消测试");
  await pending.waitFor();
  await page.getByRole("button", { name: "取消自动重试" }).click();
  await page.waitForTimeout(2300);
  assert.equal((await requestLog()).length, 3);

  await send("手动接管测试");
  await pending.waitFor();
  await failure.click();
  await page.waitForFunction(() => window.fixture.requests.length === 5);
  const log = await requestLog();
  assert.equal(log[4].recoveryRunId, log[3].runId);
  assert.equal(log[4].automaticRetry, undefined);
  await pending.waitFor(); // A new failure in the manually requested turn may schedule its own retry.
  await page.evaluate(() => { window.fixture.mode = "auth"; });
  await send("新消息取消旧重试");
  await pending.waitFor({ state: "hidden" });
  await failure.waitFor();
  await page.waitForTimeout(2300);
  const final = await requestLog();
  assert.equal(final.length, 6);
  assert.equal(final[5].recoveryRunId, undefined);
  assert.deepEqual(await page.evaluate(() => window.fixture.interrupted), []);
  assert.deepEqual(errors, []);
  console.log("PASS browser: settings persistence, capped automatic continuation, cancellation, manual takeover and no blind auth replay.");
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
