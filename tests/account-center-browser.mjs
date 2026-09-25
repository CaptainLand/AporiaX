import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { measureTextContrast } from './text-contrast.js';
const avatarsEnabled = process.argv.includes('--avatars-enabled');
const server = await createServer({ define: { 'import.meta.env.VITE_APORIAX_PROFILE_AVATARS': JSON.stringify(String(avatarsEnabled)) }, server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 840 }, bypassCSP: true });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ welcomeDismissed: true }));
    // Even a stale opt-in and a server advertising support must stay offline.
    const account = { status: 'authenticated', profile: { displayName: '测试账号', email: 'test@example.invalid' }, quota: { remainingRatio: .8 }, models: [{ displayName: 'DeepSeek V4.1 Flash' }], device: { name: '测试电脑', remoteEnabled: true }, capabilities: { remote: { supported: true } }, remoteFiles: { enabled: true } };
    window.centerCalls = 0; window.centerFailure = false; window.mobileCalls = 0; window.avatarFixture = account;
    window.desktop = {
      theme: { set: async () => {} }, providers: { list: async () => [] },
      account: { get: async () => account, refresh: async () => account, signOut: async () => ({ status: 'anonymous' }), openCenter: async () => { window.centerCalls++; if (window.centerFailure) throw Error('APORIAX_PRIVATE_CONNECTION_FAILED'); return { opened: true }; }, syncTasks: async () => { window.mobileCalls++; return {}; }, remoteCommands: async () => { window.mobileCalls++; return []; }, claimRemoteCommand: async () => { window.mobileCalls++; } },
      tasks: { load: async () => [], save: async () => {} }, harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
      sandbox: { status: async () => ({ localAvailable: true }) },
      workbench: { request: async ({ action }) => action === 'list' ? [] : true, subscribe: () => () => {} },
      sideChat: { request: async () => ({ messages: [] }), subscribe: () => () => {} },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.locator('.local-account-profile').click();
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#226d96'; ctx.fillRect(0,0,64,64);
    window.avatarFixture.profile.avatarDataUrl = canvas.toDataURL('image/webp');
    window.dispatchEvent(new Event('focus'));
  });
  if (avatarsEnabled) {
    await page.waitForFunction(() => document.querySelectorAll('.local-account-avatar img').length === 2 && [...document.querySelectorAll('.local-account-avatar img')].every(img => img.complete && img.naturalWidth > 0));
  } else {
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    assert.equal(await page.locator('.local-account-avatar img').count(), 0, 'Saved photos must stay hidden');
    assert.equal(await page.locator('.local-account-avatar svg').count(), 2, 'Menu and sidebar retain default account icons');
    assert.ok(await page.evaluate(() => window.avatarFixture.profile.avatarDataUrl), 'Stored photo stays intact');
  }
  const center = page.getByRole('button', { name: '账户中心', exact: true });
  await center.waitFor();
  assert.equal(await page.locator('.local-account-remote').count(), 0, 'Offline mobile controls must not render');
  assert.equal(await page.locator('.local-account-local-note--security').count(), 0);
  assert.doesNotMatch(await page.locator('.local-account-popover').innerText(), /手机|Mobile|Read-only mobile/);
  await page.waitForTimeout(2200); // Covers the initial sync and command timers.
  assert.equal(await page.evaluate(() => window.mobileCalls), 0, 'Offline companion must not poll or prepare uploads');
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
    console.log(`PASS: ${theme} account menu text contrast >= ${min.toFixed(2)}:1, mobile controls hidden.`);
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
  assert.equal(await page.locator('.local-account-avatar img').count(), 0, 'Avatar cleared on logout');
  assert.equal(await page.locator('.local-account-web').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: account center click, failure feedback and retry, compact-window scrolling, signed-out state; zero uncaught browser errors.');
} finally { await browser.close(); await server.close(); }
