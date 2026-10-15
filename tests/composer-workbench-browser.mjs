import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);
const server = await createServer({
  server: { host: "127.0.0.1", port: 0, open: false, watch: null },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath:
      process.env.TEST_BROWSER ||
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    server.resolvedUrls.local[0] + "tests/fixtures/composer-workbench.html",
  );
  await page.locator(".workbench-collapsed-drop").waitFor();
  assert.equal(await page.locator(".workbench-shell").count(), 0);
  assert.equal(await page.locator(".thread-model-badge").count(), 0);

  // Builder concurrency lives in Professional Roles now (covered by
  // professional-roles-browser.mjs), not in the chat composer.
  assert.equal(await page.getByRole("button", { name: "Builder 数量" }).count(), 0);
  assert.equal(await page.evaluate(() => window.fixtureTask.builderLimit), 2, 'opening the composer does not alter task role limits');

  await page.locator('input[accept*="image/png"]').setInputFiles({
    name: "shot.png",
    mimeType: "image/png",
    buffer: png,
  });
  const chip = page.locator(".composer-attachments figure");
  await chip.waitFor();
  assert.equal(await chip.getAttribute("draggable"), "true");
  const workspace = page.locator(".task-workspace");
  const box = await workspace.boundingBox();
  await chip.dragTo(workspace, {
    targetPosition: { x: box.width - 24, y: Math.round(box.height / 2) },
  });
  assert.equal(await chip.count(), 1);
  await page.locator(".workbench-shell").waitFor();
  await page.locator(".workbench-image img, .workbench-tab").first().waitFor();
  assert.equal(await page.evaluate(() => window.wb.layout.open), true);
  assert.deepEqual(errors, []);
  console.log("composer workbench browser: PASS");
} finally {
  await browser?.close();
  await server.close();
}
