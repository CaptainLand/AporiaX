// Generate shader data once, not during every desktop startup.
// The source PNG stays unchanged; these are Paper's processed textures, not replacement logos.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(server.resolvedUrls.local[0]);
  const result = await page.evaluate(async () => {
    const gem = await import("/node_modules/@paper-design/shaders/dist/shaders/gem-smoke.js");
    const metal = await import("/node_modules/@paper-design/shaders/dist/shaders/liquid-metal.js");
    const gemOut = await gem.toProcessedGemSmoke("/aporiax-logo-clean.png");
    const metalOut = await metal.toProcessedLiquidMetal("/aporiax-logo-clean.png");
    return {
      gem: Array.from(new Uint8Array(await gemOut.pngBlob.arrayBuffer())),
      metal: Array.from(new Uint8Array(await metalOut.pngBlob.arrayBuffer())),
    };
  });
  await mkdir("src/welcome", { recursive: true });
  await writeFile("src/welcome/logo-gem-texture.png", Buffer.from(result.gem));
  await writeFile("src/welcome/logo-liquid-metal-texture.png", Buffer.from(result.metal));
  const hash = createHash("sha256").update(await readFile("aporiax-logo-clean.png")).digest("hex");
  console.log(JSON.stringify({
    sourceSha256: hash,
    gemBytes: result.gem.length,
    metalBytes: result.metal.length,
    paperVersion: "0.0.80",
  }));
} finally {
  await browser?.close();
  await server.close();
}
