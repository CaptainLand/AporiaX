import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { build, preview } from "vite";
import { chromium } from "playwright-core";
import { FORCE_WELCOME_EACH_LAUNCH } from "../src/welcome/welcome-flags.js";

const output = ".tmp/welcome-check";
const errors = [];
await build({ build: { outDir: output + "/build", emptyOutDir: false } });
const server = await preview({ build: { outDir: output + "/build" }, preview: { host: "127.0.0.1", port: 0, open: false } });
let browser;
try {
  await mkdir(output, { recursive: true });
  const base = server.resolvedUrls.local[0];
  browser = await chromium.launch({
    executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" || message.type() === "warning") errors.push(message.text()); });
  await page.goto(base);
  await page.locator('.ax-welcome__art[data-effect="animated"]').waitFor();
  await page.locator('.ax-welcome__enter[data-metal="animated"]').waitFor();
  await page.locator('.ax-welcome__mesh[data-effect="animated"]').waitFor();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".ax-welcome__shader")).opacity === "1");
  const logoSlot = async () => page.locator(".ax-welcome__original").evaluate(el => {
    const box = el.getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
  });
  const gemSlot = await logoSlot();
  const paperCss = await page.evaluate(() => ({
    marker: Boolean(document.querySelector("style[data-paper-shader]")),
    inlinePaper: [...document.querySelectorAll("style")].some(el => el.textContent.includes("paper-shaders")),
  }));
  assert.equal(paperCss.marker, false, "Paper must not inject a style marker");
  assert.equal(paperCss.inlinePaper, false, "Paper must not inject inline canvas CSS");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  assert.equal(await page.locator(".ax-welcome").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(247, 249, 252)");
  assert.equal(await page.locator(".ax-welcome__art").evaluate(el => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)", "logo art has no paper card");
  const canvas = await page.locator(".ax-welcome__shader canvas").evaluate(el => ({ width: el.width, height: el.height }));
  assert.ok(canvas.width * canvas.height <= 482000, JSON.stringify(canvas));
  assert.equal(canvas.width, canvas.height);
  assert.equal(await page.locator(".ax-welcome").evaluate(el => el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth), false, "welcome does not scroll");
  await page.getByRole("button", { name: "中文", exact: true }).click();
  assert.equal(await page.locator("#ax-welcome-subtitle").textContent(), "每个答案，都始于一个尚未解开的疑问。");
  await page.screenshot({ path: output + "/light.png", scale: "css" });
  await page.screenshot({ path: output + "/light.jpg", scale: "css", quality: 88 });
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(".ax-welcome__enter").evaluate(el => el === document.activeElement), true, "focus wraps inside welcome");

  // With Paper's internal RAF disabled, only our capped clock advances setFrame.
  const frames = await page.evaluate(async () => {
    const mount = document.querySelector(".ax-welcome__shader").paperShaderMount;
    window.welcomeTestMount = mount;
    const original = mount.setFrame;
    const times = [];
    mount.setFrame = (value) => { times.push(performance.now()); original(value); };
    await new Promise(resolve => setTimeout(resolve, 600));
    mount.setFrame = original;
    return { count: times.length, speed: mount.speed };
  });
  assert.equal(frames.speed, 0);
  assert.ok(frames.count > 0 && frames.count <= 74, JSON.stringify(frames));
  await page.locator(".ax-welcome__art").click({ force: true });
  await page.locator(".ax-welcome__art[data-plate]").waitFor();
  await page.waitForFunction(() => !document.querySelector(".ax-welcome__art[data-image]"));
  const meshSlot = await page.locator(".ax-welcome__plate").evaluate(el => {
    const box = el.getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
  });
  assert.deepEqual(meshSlot, gemSlot, "masked logo plate stays on the original slot");
  assert.deepEqual(await logoSlot(), gemSlot, "original slot does not move when cycling");
  // The new filtering is Gem-only: all eight existing click-to-cycle effects
  // must still render and release the outgoing canvas without moving the logo.
  for (const kind of ["masked", "masked", "masked", "masked", "masked", "image", "image"]) {
    const outgoing = await page.locator(".ax-welcome__shader canvas, .ax-welcome__plate canvas").elementHandle();
    await page.locator(".ax-welcome__art").click({ force: true });
    await page.waitForFunction(old => !old.isConnected, outgoing);
    assert.equal(await page.locator(".ax-welcome__shader canvas, .ax-welcome__plate canvas").count(), 1);
    assert.equal(await page.locator(`.ax-welcome__art[${kind === "image" ? "data-image" : "data-plate"}]`).count(), 1);
    assert.deepEqual(await logoSlot(), gemSlot);
    await outgoing.dispose();
  }
  await page.getByRole("button", { name: "Enter AporiaX", exact: true }).click();
  await page.locator(".ax-welcome").waitFor({ state: "detached" });
  assert.equal(await page.locator(".app-content").count(), 1);
  assert.equal(await page.evaluate(() => window.welcomeTestMount.hasBeenDisposed && window.welcomeTestMount.program === null && window.welcomeTestMount.resizeObserver === null), true);
  await page.reload();
  if (FORCE_WELCOME_EACH_LAUNCH) {
    await page.locator(".ax-welcome").waitFor();
  } else {
    await page.locator(".app-content").waitFor();
    assert.equal(await page.locator(".ax-welcome").count(), 0, "existing dismissed-welcome preference preserved");
  }

  const dark = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await dark.addInitScript(() => localStorage.setItem("aporiax.theme.v2", "dark"));
  await dark.goto(base);
  await dark.locator('.ax-welcome__art[data-effect="animated"]').waitFor();
  await dark.locator('.ax-welcome__enter[data-metal="animated"]').waitFor();
  await dark.waitForFunction(() => getComputedStyle(document.querySelector(".ax-welcome__shader")).opacity === "1");
  assert.equal(await dark.locator(".ax-welcome").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(15, 21, 29)");
  await dark.screenshot({ path: output + "/dark.png" });
  await dark.screenshot({ path: output + "/dark.jpg", quality: 88 });
  await dark.close();

  const reduced = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  await reduced.goto(base);
  await reduced.locator(".ax-welcome__enter").waitFor();
  assert.equal(await reduced.locator(".ax-welcome__shader canvas").count(), 0);
  assert.equal(await reduced.locator(".ax-welcome__mesh canvas").count(), 0);
  assert.equal(await reduced.locator(".ax-welcome__enter-metal canvas").count(), 0);
  assert.equal(await reduced.locator(".ax-welcome__original").evaluate(el => getComputedStyle(el).opacity), "1");
  await reduced.screenshot({ path: output + "/compact.png" });
  for (const size of [{ width: 900, height: 600 }, { width: 760, height: 600 }, { width: 320, height: 568 }]) {
    await reduced.setViewportSize(size);
    const overflow = await reduced.locator(".ax-welcome").evaluate(el => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
    assert.equal(overflow, false, `no overflow at ${JSON.stringify(size)}`);
  }
  await reduced.emulateMedia({ reducedMotion: "no-preference" });
  await reduced.locator('.ax-welcome__art[data-effect="animated"]').waitFor();
  await reduced.emulateMedia({ reducedMotion: "reduce" });
  await reduced.locator(".ax-welcome__shader canvas").waitFor({ state: "detached" });
  await reduced.close();

  const noGl = await browser.newPage();
  await noGl.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      return type === "webgl2" ? null : getContext.call(this, type, ...args);
    };
  });
  await noGl.goto(base);
  await noGl.locator('.ax-welcome__art[data-effect="fallback"]').waitFor();
  assert.equal(await noGl.locator(".ax-welcome__shader canvas").count(), 0);
  await noGl.getByRole("button", { name: "Enter AporiaX", exact: true }).click();
  await noGl.locator(".app-content").waitFor();
  await noGl.close();

  const slow = await browser.newPage();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await slow.route(/\/assets\/(welcome-effects|gem-smoke|mesh-flow|liquid-metal|paper-loop)-[^/]+\.js$/, async route => { await gate; await route.continue(); });
  await slow.goto(base);
  await slow.getByRole("button", { name: "Enter AporiaX", exact: true }).click();
  await slow.locator(".app-content").waitFor();
  release();
  await slow.waitForLoadState("networkidle");
  assert.equal(await slow.locator(".ax-welcome__shader canvas").count(), 0, "late imports cannot remount after exit");
  await slow.close();

  const hidden = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await hidden.goto(base);
  await hidden.locator('.ax-welcome__art[data-effect="animated"]').waitFor();
  const paused = await hidden.evaluate(async () => {
    const mount = document.querySelector(".ax-welcome__shader").paperShaderMount;
    const original = mount.setFrame;
    let count = 0;
    mount.setFrame = (value) => { count += 1; original(value); };
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    const before = count;
    await new Promise(resolve => setTimeout(resolve, 180));
    const duringHidden = count - before;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise(resolve => setTimeout(resolve, 120));
    mount.setFrame = original;
    return { duringHidden, resumed: count > before };
  });
  assert.equal(paused.duringHidden, 0, JSON.stringify(paused));
  assert.equal(paused.resumed, true, JSON.stringify(paused));
  await hidden.close();

  const lost = await browser.newPage();
  await lost.goto(base);
  await lost.locator('.ax-welcome__art[data-effect="animated"]').waitFor();
  await lost.evaluate(() => {
    const canvas = document.querySelector(".ax-welcome__shader canvas");
    canvas.getContext("webgl2").getExtension("WEBGL_lose_context").loseContext();
  });
  await lost.locator('.ax-welcome__art[data-effect="fallback"]').waitFor();
  assert.equal(await lost.locator(".ax-welcome__shader canvas").count(), 0);
  await lost.close();

  assert.deepEqual(errors, []);
  assert.equal(createHash("sha256").update(await readFile("aporiax-logo-clean.png")).digest("hex"),
    "5e4c8c77c1f50f577885b7b07b13dc6d91dcce0bb61c5700eef8849d0acf2a35", "original logo is unchanged");
  console.log(JSON.stringify({ result: "PASS", canvas, frames, checks: ["actual app entry", "default light", "no Paper inline CSS", "saved dark", "localization", "focus", "enter + disposal", "persisted dismissal", "reduced motion", "compact sizes", "WebGL fallback", "late import cancellation", "hidden frame pause", "context lost fallback", "original logo identity"] }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
