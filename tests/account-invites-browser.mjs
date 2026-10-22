import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';

const server = await createServer({ configFile: false, cacheDir: '.tmp/account-invites-vite',
  plugins: [react()],
  optimizeDeps: { entries: ['tests/fixtures/account-invites.html'] },
  server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('Page error:', error.message); });
  await page.addInitScript(() => {
    localStorage.setItem('aporiax.language.v1', 'zh-CN');
    const snapshot = { status: 'authenticated', profile: { id: 'fixture', displayName: 'LanDX', email: 'demo@example.invalid', avatarTemplate: 'main', avatarTemplateUpdatedAt: '2026-10-22' },
      quota: { remainingRatio: .75, cycleEnd: new Date(Date.now() + 2 * 86400000).toISOString() },
      invites: { inviteCode: '09E18214F9', successfulInvites: 0, nextRewardPercent: 100, rewardsExhausted: false } };
    window.fixture = { snapshot, copied: [], failCopy: false, opened: 0 };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => {
      if (window.fixture.failCopy) throw Error('fixture-denied');
      window.fixture.copied.push(value);
    } } });
    window.desktop = { account: { get: async () => snapshot, refresh: async () => window.fixture.snapshot,
      signOut: async () => ({ status: 'anonymous' }) } };
  });
  await mkdir('.tmp/qa/account-invites', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/account-invites.html?theme=${theme}`);
    await page.locator('.local-account-profile').click();
    const card = page.getByRole('region', { name: '邀请好友' });
    await card.waitFor();
    assert.match(await card.innerText(), /09E18214F9[\s\S]*第 1 次有效邀请[\s\S]*回补 100%/);
    assert.match(await card.innerText(), /最高恢复至 100%/);
    await card.getByRole('button', { name: '复制邀请码' }).click();
    assert.match(await card.innerText(), /已复制/);
    assert.deepEqual(await page.evaluate(() => window.fixture.copied), ['09E18214F9']);
    await page.evaluate(() => { window.fixture.failCopy = true; });
    await card.getByRole('button', { name: '复制邀请码' }).click();
    await card.getByRole('alert').waitFor();
    assert.match(await card.getByRole('alert').innerText(), /手动复制/);
    await page.evaluate(() => {
      window.fixture.snapshot = { ...window.fixture.snapshot, invites: { ...window.fixture.snapshot.invites, successfulInvites: 1, nextRewardPercent: 50 } };
    });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await card.getByText('回补 50%', { exact: true }).waitFor();
    assert.match(await card.innerText(), /第 2 次有效邀请/);
    for (const ratio of [1.25, .4, 0, 3]) {
      await page.evaluate(ratio => { window.fixture.snapshot = { ...window.fixture.snapshot, quota: { ...window.fixture.snapshot.quota, remainingRatio: ratio } }; }, ratio);
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      const percent = Math.round(ratio * 100), width = Math.min(100, percent);
      await page.locator('.local-account-quota-percent').filter({ hasText: `${percent}%` }).waitFor();
      assert.equal(await page.locator('.local-account-quota-card strong').innerText(), `${percent}%`);
      assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), String(width));
      assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuetext'), `${percent}%`);
      assert.deepEqual(await page.locator('.local-account-quota-track > i').evaluateAll(elements => elements.map(el => el.style.width)), [`${width}%`, `${width}%`]);
    }
    await page.evaluate(() => { window.fixture.failCopy = false; });
    await card.getByRole('button', { name: '复制邀请码' }).click();
    await page.locator('.local-account-popover').screenshot({ path: `.tmp/qa/account-invites/${theme}.png` });
    await page.evaluate(() => {
      window.fixture.snapshot = { ...window.fixture.snapshot, invites: { ...window.fixture.snapshot.invites, successfulInvites: 3, nextRewardPercent: null, rewardsExhausted: true } };
    });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await card.getByText('奖励已领完', { exact: true }).waitFor();
    assert.doesNotMatch(await card.innerText(), /回补 0%|第 4 次/);
    await page.setViewportSize({ width: 300, height: 480 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const bounds = await page.locator('.local-account-popover').boundingBox();
    assert.ok(bounds.y >= 0 && bounds.x >= 0 && bounds.x + bounds.width <= 300, JSON.stringify(bounds));
    await page.evaluate(() => { window.fixture.snapshot = { ...window.fixture.snapshot, invites: null }; });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await card.getByRole('status').waitFor();
    assert.equal(await card.getByRole('button').count(), 0);
    assert.doesNotMatch(await card.innerText(), /09E18214F9|回补 100%/);
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.locator('.local-account-signin').waitFor();
    assert.equal(await page.locator('.local-account-invite-card').count(), 0);
    await page.setViewportSize({ width: 900, height: 720 });
  }
  assert.deepEqual(errors, []);
  console.log('PASS invitation popover: real components, light/dark, copy/failure, refreshed stage, exhausted/unavailable states, narrow viewport and sign-out.');
} finally {
  await browser?.close();
  await server.close();
}
