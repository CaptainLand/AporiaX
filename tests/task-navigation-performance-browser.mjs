import assert from "node:assert/strict";
import { preview } from "vite";
import { chromium } from "playwright-core";

const server = await preview({ preview: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1250, height: 850 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("aporiax.language.v1", "zh-CN");
    if (!localStorage.getItem("aporiax.session-ui.v1")) localStorage.setItem("aporiax.session-ui.v1",
      JSON.stringify({ taskId: "long", view: "dialogue", welcomeDismissed: true, stickToBottom: true }));
    const base = { workspacePath: "D:/Fixture", workspaceName: "Fixture", projectId: "workspace:d:/fixture", knowledgeEnabled: true };
    const taskList = [
      { ...base, id: "long", title: "长任务", messages: Array.from({ length: 160 }, (_, i) => ({
        id: "turn-" + i, role: i % 2 ? "assistant" : "user", status: "completed",
        content: `锚点样例${i}号\n\n${i % 5 === 0 ? ("一段较长的示例文本。".repeat(75)) : "简短的示例。"}`,
        ...(i === 45 ? { deliveryDetails: "一个可以展开的细节。" } : {}),
      })) },
      { ...base, id: "short", title: "短任务", messages: [{ id: "short-turn", role: "user", content: "另一个任务的文字。" }] },
    ];
    window.ioCalls = [];
    window.historyWrites = 0;
    window.desktop = {
      theme: { set: async () => {} },
      tasks: { load: async () => taskList, patch: async () => { window.historyWrites++; throw Error("Unexpected task history write"); } },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
      providers: { list: async () => [] },
      account: { get: async () => ({ status: "anonymous" }) },
      workspace: { listTree: async () => { window.ioCalls.push("workspace"); return { entries: [] }; } },
      understanding: { get: async () => { window.ioCalls.push("understanding"); return { facts: [], revisions: [] }; } },
      workbench: { subscribe: () => () => {}, request: async input => input.action === "list" ? [] : true },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  if (await page.locator(".ax-welcome__enter").isVisible()) await page.locator(".ax-welcome__enter").click();
  const tabs = page.locator(".thread-view-tabs");
  const switchTab = name => tabs.getByRole("button", { name, exact: true }).click();
  const switchTask = title => page.locator(`.task-item[title="${title}"]`).click();
  const deferred = page.locator(".defer-offscreen-turns");
  await deferred.waitFor();
  assert.equal(await page.locator(".route-panel, .workspace-panel, .understanding-panel").count(), 0);
  assert.deepEqual(await page.evaluate(() => window.ioCalls), []);
  assert.equal(await deferred.locator("[data-thread-turn]").count(), 160, "every turn stays in the DOM");
  assert.equal(await page.locator('[data-thread-turn="turn-0"]').evaluate(el =>
    el.firstElementChild.checkVisibility({ contentVisibilityAuto: true })), false, "distant content really skips rendering");
  assert.equal(await page.locator('[data-thread-turn="turn-159"]').getAttribute("data-defer-offscreen"), null);

  assert.equal(await page.evaluate(() => window.find("锚点样例45号", false, false, true)), true,
    "native find can reach a distant message");
  await page.evaluate(() => document.getSelection().removeAllRanges());
  const anchor = await page.evaluate(() => {
    const body = document.querySelector(".thread-body");
    const turn = document.querySelector('[data-thread-turn="turn-45"]');
    body.scrollTop += turn.getBoundingClientRect().top - body.getBoundingClientRect().top + 12;
    return turn.dataset.threadTurn;
  });
  const offset = () => page.evaluate(id => {
    const body = document.querySelector(".thread-body");
    const turn = body.querySelector(`[data-thread-turn="${id}"]`);
    return turn.getBoundingClientRect().top - body.getBoundingClientRect().top;
  }, anchor);
  // Wait for scroll anchoring and the per-view memory to sample the viewport.
  const readStableOffset = async () => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return offset();
  };
  const anchorOffset = await readStableOffset();
  assert.ok(Math.abs(anchorOffset) < 35);
  const expectSamePosition = async label => {
    const current = await readStableOffset();
    assert.ok(Math.abs(current - anchorOffset) < 30, `${label}: ${anchorOffset} -> ${current}`);
  };
  await switchTab("执行记录");
  await page.locator(".route-panel.active").waitFor();
  await page.evaluate(() => { window.mountedRoute = document.querySelector(".route-panel"); });
  await switchTab("工作区");
  await page.locator(".workspace-panel.active").waitFor();
  await switchTab("执行记录");
  assert.equal(await page.evaluate(() => window.mountedRoute === document.querySelector(".route-panel")), true,
    "visited panels keep their state within the same task");
  await switchTab("对话");
  await expectSamePosition("restored after tab change");
  await switchTask("短任务");
  await page.getByText("另一个任务的文字。", { exact: true }).waitFor();
  assert.equal(await page.locator(".route-panel, .workspace-panel").count(), 0, "do not visit tabs for the next task");
  await switchTask("长任务");
  await expectSamePosition("restored after task change");

  const selected = await page.evaluate(() => {
    const from = document.querySelector('[data-thread-turn="turn-45"] .markdown-message p').firstChild;
    const to = document.querySelector('[data-thread-turn="turn-47"] .markdown-message p').firstChild;
    const range = document.createRange();
    range.setStart(from, 0);
    range.setEnd(to, to.length);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const text = selection.toString();
    selection.removeAllRanges();
    return text;
  });
  assert.match(selected, /锚点样例45号[\s\S]*锚点样例47号/);
  await page.locator('button[aria-haspopup="menu"]').filter({ has: page.locator(".lucide-ellipsis") }).first().click();
  await page.getByRole("menuitem", { name: "完整渲染对话" }).click();
  assert.equal(await deferred.count(), 0);
  await expectSamePosition("restored after disabling offscreen mode");
  assert.equal(await page.evaluate(() => window.historyWrites), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: lazy per-task panels, actual Chromium offscreen culling, native find, cross-turn selection, stable scroll anchor and fallback.");
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
