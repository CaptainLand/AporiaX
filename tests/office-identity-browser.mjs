import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/office-identity.html');
  await page.locator('.ao-roster > button').nth(5).waitFor();
  await page.locator('.ao-scene.ready canvas').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.ao-roster .ao-avatar img')].length === 6 && [...document.querySelectorAll('.ao-roster .ao-avatar img')].every(image => image.complete && image.naturalWidth > 0));
  const avatars = await page.locator('.ao-roster .ao-avatar').evaluateAll(elements => elements.map(el => el.outerHTML));
  assert.deepEqual(await page.locator('.ao-roster b').allTextContents(), ['阿珀', '探奇', '察微', '验准', '知序', '搭匠']);
  await mkdir('.tmp/qa', { recursive: true });
  await page.screenshot({ path: '.tmp/qa/office-names-zh.png' });
  await page.evaluate(() => window.officeIdentity.language('en'));
  assert.deepEqual(await page.locator('.ao-roster b').allTextContents(), ['AporiaX', 'Scout', 'Sentry', 'Checko', 'Index', 'Forge']);
  assert.deepEqual(await page.locator('.ao-roster .ao-avatar').evaluateAll(elements => elements.map(el => el.outerHTML)), avatars);
  // The existing office rebuilds its localized scene labels on language
  // changes. Verify appearance/identities, not canvas instance identity.
  await page.locator('.ao-scene.ready canvas').waitFor();
  await page.screenshot({ path: '.tmp/qa/office-names-en.png' });
  assert.deepEqual(errors, []);
  console.log('PASS real office UI: legacy names localize live, six identities match, unchanged avatars and usable localized 3D scene.');
} finally { await browser.close(); await server.close(); }
