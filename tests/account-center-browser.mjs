import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { measureTextContrast } from './text-contrast.js';
const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 840 }, bypassCSP: true });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ welcomeDismissed: true }));
    const account = { status: 'authenticated', profile: { displayName: '测试账号', email: 'test@example.invalid' }, quota: { remainingRatio: .8 }, models: [{ displayName: 'DeepSeek V4.1 Flash' }], device: { name: '测试电脑', remoteEnabled: false }, capabilities: { remote: { supported: false } }, remoteFiles: { enabled: true } };
    window.centerCalls = 0; window.centerFailure = false;
    window.desktop = {
      theme: { set: async () => {} }, providers: { list: async () => [] },
      account: { get: async () => account, refresh: async () => account, signOut: async () => ({ status: 'anonymous' }), openCenter: async () => { window.centerCalls++; if (window.centerFailure) throw Error('APORIAX_PRIVATE_CONNECTION_FAILED'); return { opened: true }; } },
      tasks: { load: async () => [], save: async () => {} }, harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
      sandbox: { status: async () => ({ localAvailable: true }) },
      workbench: { request: async ({ action }) => action === 'list' ? [] : true, subscribe: () => () => {} },
      sideChat: { request: async () => ({ messages: [] }), subscribe: () => () => {} },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.locator('.local-account-profile').click();
  const center = page.getByRole('button', { name: '账户中心', exact: true });
  await center.waitFor();
  assert.equal(await page.locator('.local-account-remote.is-enabled').count(), 0, 'Unavailable remote access must not look enabled');
  assert.equal(await page.locator('.local-account-remote:disabled').count(), 2);
  await mkdir('.tmp/qa', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const selectors = ['.local-account-popover-head strong', '.local-account-popover-head small', '.local-account-connected', '.local-account-quota-card strong', '.local-account-quota-card > div > span', '.local-account-meta span', '.local-account-remote strong', '.local-account-remote small', '.local-account-local-note', '.local-account-actions button'];
    let min = Infinity;
    for (const selector of selectors) {
      for (const element of await page.locator(selector).all()) {
        const result = await element.evaluate(measureTextContrast); min = Math.min(min, result.ratio);
        assert.ok(result.ratio >= 4.5, `${theme} ${selector}: ${JSON.stringify(result)}`);
      }
    }
    await page.screenshot({ path: `.tmp/qa/account-center-${theme}.png` });
    console.log(`PASS: ${theme} account menu text contrast >= ${min.toFixed(2)}:1, disabled reasons remain readable.`);
  }
  await center.click(); assert.equal(await page.evaluate(() => window.centerCalls), 1);
  await page.evaluate(() => { window.centerFailure = true; });
  await center.click(); await page.getByRole('alert').filter({ hasText: '暂时无法连接私有 Cloud' }).waitFor();
  assert.equal(await center.isEnabled(), true);
  await page.evaluate(() => { window.centerFailure = false; });
  await center.click(); assert.equal(await page.getByRole('alert').count(), 0);
  await page.setViewportSize({ width: 800, height: 600 });
  await center.scrollIntoViewIfNeeded();
  const bounds = await page.locator('.local-account-popover').boundingBox(); assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 600);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  assert.equal(await page.locator('.local-account-web').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: account center click, failure feedback and retry, compact-window scrolling, signed-out state; zero uncaught browser errors.');
} finally { await browser.close(); await server.close(); }
