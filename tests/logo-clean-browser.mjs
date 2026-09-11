import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer, build } from "vite";
import { chromium } from "playwright-core";

const clean = process.env.LOGO_EXPECT_CLEAN === "1";
const output = ".tmp/logo-clean-regression";
const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const response = await page.goto(server.resolvedUrls.local[0] + "aporiax-logo-animated.html");
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => document.querySelector(".flow")?.paperShaderMount?.gl);
  const baseline = await page.locator(".mark").evaluate(element => {
    const rect = element.getBoundingClientRect();
    return {
      mask: getComputedStyle(element).maskImage,
      mode: getComputedStyle(element).maskMode,
      aspect: rect.width / rect.height,
      background: getComputedStyle(document.body).backgroundColor,
    };
  });
  assert.equal(baseline.background, "rgb(247, 249, 252)");
  assert.equal(await page.getByRole("button").count(), 8);
  if (clean) {
    assert.match(baseline.mask, /aporiax-logo-clean/);
    assert.equal(baseline.mode, "alpha");
    assert.ok(Math.abs(baseline.aspect - 1) < 0.002, "square source must not be stretched");
    const source = await page.evaluate(async () => {
      const img = new Image();
      img.src = "./aporiax-logo-clean.png";
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      context.drawImage(img, 0, 0);
      return { width: img.width, height: img.height, cornerAlpha: context.getImageData(0, 0, 1, 1).data[3] };
    });
    assert.deepEqual(source, { width: 1254, height: 1254, cornerAlpha: 0 });
    for (const button of await page.getByRole("button").all()) {
      await button.click();
      assert.equal(await button.getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator(".flow canvas").count(), 1, "effect switching must dispose the old canvas");
    }
    await page.getByRole("button").first().click();
  }
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: output + (clean ? "/after.png" : "/before.png") });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ clean, ...baseline, pageErrors: errors }));
} finally {
  await browser?.close();
  await server.close();
}
if (clean) {
  await build({ build: { outDir: output + "/build", emptyOutDir: false,
    rollupOptions: { input: "aporiax-logo-animated.html" } } });
  console.log("Clean original PNG, alpha mask, correct aspect, eight effects and standalone production build: PASS");
}
