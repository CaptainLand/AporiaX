import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { preview } from "vite";

const server = await preview({ preview: { host: "127.0.0.1", port: 0, open: false } });
let browser;
try {
  const base = server.resolvedUrls.local[0];
  browser = await chromium.launch({
    executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 940, height: 700 } });
  await page.route("**/*", route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    localStorage.setItem("aporiax.language.v1", "zh-CN");
    localStorage.setItem("aporiax.theme.v2", "dark");
    localStorage.setItem("aporiax.session-ui.v1", JSON.stringify({ welcomeDismissed: true, taskId: "layout" }));
    window.desktop = {
      account: { get: async () => ({ status: "anonymous" }) },
      providers: { list: async () => [] },
      tasks: { load: async () => [{ id: "layout", title: "Layout", workspaceName: "Fixture", workspacePath: "D:/Fixture", messages: [] }], save: async () => {} },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [], activeRuns: async () => [] },
      workbench: { subscribe: () => () => {}, request: async ({ action }) => action === "list" ? [] : true },
    };
  });
  await page.goto(base);
  await page.locator(".ax-welcome__enter, .thread-view-tabs").first().waitFor();
  if (await page.locator(".ax-welcome__enter").isVisible()) await page.locator(".ax-welcome__enter").click();
  await page.getByRole("button", { name: "打开 AporiaX 设置" }).click();
  const section = page.locator(".application-settings-content.general-section");
  const previewDirectory = process.argv[2] ? resolve(process.argv[2]) : null;
  async function screenshot(name) {
    if (!previewDirectory) return;
    await mkdir(previewDirectory, { recursive: true });
    await section.evaluate(element => { element.scrollTop = 0; });
    await page.locator(".application-settings-modal").screenshot({ path: join(previewDirectory, name), animations: "disabled" });
  }

  async function checkLayout(label) {
    const layout = await section.evaluate(element => {
      const cards = [...element.querySelectorAll(".preference-card")];
      const issues = cards.flatMap((card, index) => {
        const box = card.getBoundingClientRect(), next = cards[index + 1]?.getBoundingClientRect();
        const name = card.querySelector("strong")?.textContent;
        const bad = [];
        if (next && box.bottom > next.top + 1) bad.push(`${name}: card overlap`);
        for (const child of card.querySelectorAll(".preference-card-heading, .appearance-options button, .auto-retry-heading .switch, .auto-retry-limit-label, .auto-retry-counts button")) {
          const bounds = child.getBoundingClientRect();
          if (bounds.top < box.top - 1 || bounds.bottom > box.bottom + 1 || bounds.left < box.left - 1 || bounds.right > box.right + 1) {
            bad.push(`${name}: ${child.textContent} exceeds card (${Math.round(bounds.bottom - box.bottom)}px vertically)`);
          }
        }
        return bad;
      });
      return { issues, scrollable: element.scrollHeight > element.clientHeight, horizontalOverflow: element.scrollWidth - element.clientWidth };
    });
    assert.deepEqual(layout.issues, [], label);
    assert(layout.horizontalOverflow <= 1, label + ": horizontal overflow");
    return layout;
  }

  await checkLayout("940 × 700, dark, Chinese");
  const theme = section.getByRole("group", { name: "外观主题" });
  await theme.getByRole("button", { name: "日间" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await checkLayout("940 × 700, light, Chinese");
  const toggle = section.getByRole("switch", { name: "启用自动重试" });
  const three = section.getByRole("button", { name: "3 次", exact: true });
  assert(await three.isDisabled());
  await screenshot("retry-light-off.png");
  await toggle.click();
  await three.click();
  assert.equal(await three.getAttribute("aria-pressed"), "true");
  await theme.getByRole("button", { name: "夜间" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await screenshot("retry-dark-on.png");
  await theme.getByRole("button", { name: "日间" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await section.getByRole("button", { name: "English", exact: true }).click();
  await page.setViewportSize({ width: 620, height: 520 });
  const compact = await checkLayout("620 × 520, light, English");
  assert(compact.scrollable, "short settings scroll instead of compressing controls");
  await section.getByRole("button", { name: "Dark", exact: true }).click();
  assert.equal(await section.getByRole("switch", { name: "Enable automatic retry" }).getAttribute("aria-checked"), "true");
  const attempts = section.getByRole("group", { name: "Maximum retries (excluding the initial run)" });
  await attempts.getByRole("button", { name: "4 retries", exact: true }).click();
  assert.equal(await attempts.getByRole("button", { name: "4 retries", exact: true }).getAttribute("aria-pressed"), "true");
  await checkLayout("620 × 520, dark, English, retry enabled");
  await section.getByText("Local execution boundary", { exact: true }).scrollIntoViewIfNeeded();
  assert((await section.evaluate(element => element.scrollTop)) > 0);
  console.log("PASS General settings: cards contain the theme and retry controls; light/dark, Chinese/English, compact scroll, and clickable controls.");
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
