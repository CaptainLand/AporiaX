import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { build, preview } from "vite";
import { chromium } from "playwright-core";

const label = process.env.EDGE_LABEL || "after";
const output = ".tmp/welcome-edge-check";
await mkdir(output, { recursive: true });
await build({ build: { outDir: output + "/build", emptyOutDir: false,
  rollupOptions: { input: "tests/fixtures/welcome-edge.html" } } });
const server = await preview({ build: { outDir: output + "/build" }, preview: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const metrics = [];
  for (const dpr of [1, 1.25, 2]) {
    const page = await browser.newPage({ viewport: { width: 580, height: 580 }, deviceScaleFactor: dpr });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.resolvedUrls.local[0] + "tests/fixtures/welcome-edge.html" + (label === "before" ? "?baseline" : ""));
    await page.evaluate(() => window.edgeReady);
    await page.screenshot({ path: `${output}/${label}-${dpr}.png`, scale: "css" });
    if (dpr === 1) {
      await page.screenshot({ path: `${output}/${label}-detail.png`, clip: { x: 252, y: 272, width: 140, height: 144 }, scale: "css" });
      await page.screenshot({ path: `${output}/${label}.jpg`, scale: "css", quality: 92 });
    }
    const metric = await page.evaluate(() => {
      const mount = document.querySelector("#sample").paperShaderMount;
      const gl = mount.gl;
      gl.bindTexture(gl.TEXTURE_2D, mount.textures.get("u_image"));
      const filter = gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER);
      return { dpr: devicePixelRatio, width: mount.canvasElement.width, height: mount.canvasElement.height, minPixelRatio: mount.minPixelRatio, mipmaps: mount.mipmaps, filter, glError: gl.getError() };
    });
    metrics.push(metric);
    assert.ok(metric.width * metric.height <= 482000, "pixel budget must not increase");
    assert.equal(metric.minPixelRatio, 1, "no brute-force supersampling");
    assert.equal(metric.filter, label === "before" ? 9729 : 9987, "real GPU minification filter");
    assert.equal(metric.glError, 0);
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.disposeEdge());
    assert.equal(await page.locator("canvas").count(), 0);
    await page.close();
  }
  await writeFile(`${output}/${label}-metrics.json`, JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify({ label, metrics }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
