import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + "tests/fixtures/composer-workbench.html?reasoning=claude");
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  const effort = page.locator('.segmented-control[aria-label="思考强度"]');
  assert.deepEqual(await effort.locator("button").allTextContents(), ["Low", "Medium", "High", "XHigh", "Max"]);
  assert.equal(await page.locator(".model-menu").evaluate(el => el.scrollWidth > el.clientWidth), false, "five effort levels must fit the existing menu");
  const thinking = page.getByRole("switch", { name: "深度思考" });
  assert.equal(await thinking.isDisabled(), true);
  for (const [label, value] of [["Low", "low"], ["Medium", "medium"], ["High", "high"], ["XHigh", "xhigh"], ["Max", "max"]]) {
    await effort.getByRole("button", { name: label, exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixtureTask.effort), value);
  }
  await page.goto(server.resolvedUrls.local[0] + "tests/fixtures/composer-workbench.html?reasoning=other");
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  assert.equal(await effort.count(), 0, "non-thinking models keep their existing menu");
  await page.getByRole("switch", { name: "深度思考" }).click();
  assert.deepEqual(await effort.locator("button").allTextContents(), ["High", "Max"]);
  // Switching from another model chooses the model-specific default.
  await page.getByRole("button", { name: /Claude Opus 5.5|Opus 5.5/ }).last().click();
  assert.equal(await page.evaluate(() => window.fixtureTask.modelId), "claude-opus-5-5");
  assert.equal(await page.evaluate(() => window.fixtureTask.effort), "medium");
  assert.deepEqual(errors, []);
  console.log("claude reasoning browser: PASS");
} finally { await browser?.close(); await server.close(); }
