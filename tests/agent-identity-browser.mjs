import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/professional-roles.html');
  const cards = page.locator('.pr-card-title strong');
  await cards.first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.pr-robot img')].length === 5 && [...document.querySelectorAll('.pr-robot img')].every(image => image.complete && image.naturalWidth > 0));
  const saved = await page.evaluate(() => JSON.stringify(window.fixture.saved));
  const robots = await page.locator('.role-robot').evaluateAll(elements => elements.map(el => el.outerHTML));
  assert.deepEqual(await cards.allTextContents(), ['探奇', '察微', '验准', '知序', '搭匠']);
  await page.evaluate(() => window.fixture.language('en'));
  assert.deepEqual(await cards.allTextContents(), ['Scout', 'Sentry', 'Checko', 'Index', 'Forge']);
  assert.deepEqual(await page.locator('.role-robot').evaluateAll(elements => elements.map(el => el.outerHTML)), robots, 'robot assets unchanged by localization');
  await page.getByRole('button', { name: 'Scout', exact: true }).click();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Scout');
  assert.equal(await page.getByRole('button', { name: 'Delete role', exact: true }).count(), 0, 'built-in roles cannot be deleted');
  await page.getByLabel('Name', { exact: true }).fill('Personal specialist');
  await page.evaluate(() => window.fixture.language('zh-CN'));
  assert.equal(await cards.first().innerText(), 'Personal specialist', 'user-assigned names remain unchanged');
  assert.equal(await page.evaluate(() => JSON.stringify(window.fixture.saved)), saved, 'language switching does not write stored role configuration');
  assert.deepEqual(errors, []);
  console.log('PASS role UI: live bilingual names/editor, unchanged robot artwork, custom names and built-in deletion protection; no settings writes.');
} finally { await browser.close(); await server.close(); }
