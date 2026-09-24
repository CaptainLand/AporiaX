import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { preview } from "vite";
import { chromium } from "playwright-core";
import { USER_GUIDE_URL } from "../src/help/guide-url.js";

const webRoot = resolve(process.env.GUIDE_WEB_ROOT || ".tmp/aporiax-web-guide");
const web = await preview({ root: webRoot, base: "/AporiaX_web/", preview: { port: 0, host: "127.0.0.1", open: false } });
const app = await preview({ preview: { port: 0, host: "127.0.0.1", open: false } });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  await mkdir(".tmp/user-guide", { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const website = web.resolvedUrls.local[0];
  // Home can initialize the pre-existing auth flow. Stub only the Cloud domain;
  // the guide itself must issue no API or external asset requests at all.
  await page.route("https://captainlan.tail0f652a.ts.net/**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"TEST_ANONYMOUS"}' }));
  await page.goto(website);
  const entry = page.locator('.nav-links a[href$="guide/"]');
  await entry.waitFor();
  assert.equal(await entry.getAttribute("href"), "/AporiaX_web/guide/");
  await entry.click();
  await page.getByRole("heading", { name: "AporiaX 使用教程", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/AporiaX_web/guide/");
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.reload();
  assert.equal(await page.locator("script, form, input").count(), 0, "The guide does not collect API keys or run scripts");
  assert.equal(await page.locator("h2[id]").count(), 12);
  const anchorIds = await page.locator("aside nav a").evaluateAll((links) => links.map((link) => link.hash.slice(1)));
  for (const id of anchorIds) {
    await page.locator(`aside a[href="#${id}"]`).click();
    assert.equal(new URL(page.url()).hash, `#${id}`);
    assert.ok(await page.locator(`#${id}`).evaluate((element) => { const y = element.getBoundingClientRect().top; return y >= 65 && y < innerHeight; }), `Visible chapter ${id}`);
  }
  for (const img of await page.locator("article img").all()) {
    await img.scrollIntoViewIfNeeded();
    await img.evaluate(async (element) => { await element.decode(); });
  }
  assert.ok(requests.every((url) => url.startsWith(new URL(website).origin)), "Guide requests are local static assets only");
  const download = page.locator("a[download]");
  const response = await page.request.get(new URL(await download.getAttribute("href"), page.url()).href);
  assert.equal(response.status(), 200);
  assert.equal(await response.text(), await readFile("docs/USER_GUIDE.zh-CN.md", "utf8"));
  await page.goto(`${website}guide/#api-key`);
  await page.reload();
  assert.equal(await page.locator("#api-key").count(), 1, "Direct deep-link refresh resolves");
  await page.screenshot({ path: ".tmp/user-guide/desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${website}guide/`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Mobile has no page-wide horizontal overflow");
  await page.screenshot({ path: ".tmp/user-guide/mobile.png" });
  await page.getByRole("link", { name: "返回官网", exact: true }).click();
  await page.locator(".site-shell").waitFor();
  // Footer remains an entry on layouts that collapse the top navigation.
  assert.equal(await page.locator('.footer a[href$="guide/"]').count(), 1);

  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  desktop.on("pageerror", (error) => errors.push(error.message));
  await desktop.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("aporiax.language.v1", "zh-CN");
    localStorage.setItem("aporiax.session-ui.v1", JSON.stringify({ welcomeDismissed: true }));
    window.guideFixture = { requests: [], fail: false };
    window.desktop = {
      theme: { set: async () => {} },
      providers: { list: async () => [] },
      account: { get: async () => ({ status: "anonymous" }) },
      tasks: { load: async () => [], save: async () => {} },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
      sandbox: { status: async () => ({ localAvailable: true }) },
      links: { activate: async (input) => { window.guideFixture.requests.push(input); if (window.guideFixture.fail) throw new Error("Test open failure"); return { ok: true }; } },
    };
  });
  await desktop.goto(app.resolvedUrls.local[0]);
  if (await desktop.locator(".ax-welcome__enter").isVisible()) await desktop.locator(".ax-welcome__enter").click();
  await desktop.getByRole("button", { name: "打开 AporiaX 设置", exact: true }).click();
  await desktop.getByRole("button", { name: "模型与 API", exact: true }).click();
  await desktop.getByRole("link", { name: "API 添加教程", exact: true }).click();
  await desktop.waitForFunction(() => window.guideFixture.requests.length === 1);
  assert.equal((await desktop.evaluate(() => window.guideFixture.requests))[0].href, `${USER_GUIDE_URL}#api-key`);
  await desktop.getByLabel("API Base URL", { exact: true }).fill("https://example.invalid/v1");
  await desktop.evaluate(() => { window.guideFixture.fail = true; });
  await desktop.getByRole("link", { name: "API 添加教程", exact: true }).click();
  await desktop.locator(".tutorial-link-error").waitFor();
  assert.match(await desktop.locator(".tutorial-link-error").innerText(), /https:\/\/captainland.github.io\/AporiaX_web\/guide/);
  assert.equal(await desktop.getByLabel("API Base URL", { exact: true }).inputValue(), "https://example.invalid/v1", "Opening tutorial must preserve API form draft");
  await desktop.screenshot({ path: ".tmp/user-guide/api-entry.png" });
  await desktop.getByRole("button", { name: "关于", exact: true }).click();
  await desktop.evaluate(() => { window.guideFixture.fail = false; });
  await desktop.getByRole("link", { name: "使用教程", exact: true }).click();
  await desktop.waitForFunction(() => window.guideFixture.requests.length === 3);
  const calls = await desktop.evaluate(() => window.guideFixture.requests);
  assert.equal(calls[2].href, USER_GUIDE_URL);
  assert.ok(calls.every((call) => Object.keys(call).sort().join() === "action,href,language"), "Tutorial URLs contain no provider, key, task or workspace data");
  await desktop.screenshot({ path: ".tmp/user-guide/about-entry.png" });
  assert.deepEqual(errors, []);
  console.log("PASS: real Aporia Web home/footer → static guide, 12 anchors, deep-link refresh, 5 images, exact Markdown download, 390px layout, no guide API calls; production desktop API/About entries, preserved draft, explicit open error, no sensitive link data.");
} finally {
  await browser?.close();
  await Promise.all([web, app].map((server) => new Promise((done) => server.httpServer.close(done))));
}
