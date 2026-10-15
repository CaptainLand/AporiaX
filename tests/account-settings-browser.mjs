import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { themeTokens } from '../shared/appearance.js';
const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1240, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.clear(); localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.theme.v2', new URLSearchParams(location.search).get('theme') || 'light');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ welcomeDismissed: true }));
    const now = Date.now();
    const account = { status: 'authenticated', profile: { id: 'test-account', displayName: '演示账户', email: 'demo@example.invalid' }, session: { id: 'fixture-session' }, quota: { remainingRatio: .72, cycleEnd: new Date(now + 86400000 * 3).toISOString() }, device: { name: '演示电脑' } };
    const rows = Array.from({ length: 106 }, (_, i) => ({ requestId: `request-${i}`, startedAt: new Date(now - i * 86400000).toISOString(), settledAt: new Date(now - i * 86400000 + 5000).toISOString(), model: 'Aporia Cloud', deviceName: '演示电脑', billingStatus: i === 3 ? 'pending' : 'settled', billingSource: 'weekly', quotaUsedRatio: i === 3 ? null : (i % 6 + 1) / 200, tokens: i === 3 ? null : { input: 1000 * (i % 6 + 1), output: 200, total: 1000 * (i % 6 + 1) + 200, cachedInput: 500 }, responseTimeMs: 5000 }));
    window.fixture = { calls: [], account, fail: false, delay: false, opened: 0 };
    let signed = true;
    window.desktop = {
      theme: { set: async () => {} }, providers: { list: async () => [] }, tasks: { load: async () => [], save: async () => {} },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
      sandbox: { status: async () => ({ localAvailable: true }) },
      workbench: { subscribe: () => () => {}, request: async ({ action }) => action === 'list' ? [] : true },
      account: {
        get: async () => account, refresh: async () => signed ? account : { status: 'anonymous' },
        signIn: async () => { signed = true; return account; }, signOut: async () => { signed = false; return { status: 'anonymous' }; },
        openCenter: async () => { window.fixture.opened++; },
        getRequestHistory: async ({ accountId, cursor }) => {
          if (accountId !== account.profile.id) throw Error('WRONG_ACCOUNT');
          window.fixture.calls.push(cursor);
          if (window.fixture.delay) await new Promise(resolve => { window.fixture.release = resolve; });
          if (window.fixture.fail) throw Error('ACCOUNT_HISTORY_UNAVAILABLE');
          return { items: cursor ? rows.slice(100) : rows.slice(0, 100), nextCursor: cursor ? null : 'older', sampledAt: new Date(now).toISOString() };
        },
      },
    };
  });
  const open = async theme => {
    await page.goto(server.resolvedUrls.local[0] + '?theme=' + theme);
    if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
    await page.getByRole('button', { name: '打开 AporiaX 设置', exact: true }).click();
    await page.locator('.application-settings-nav').getByRole('button', { name: '账户', exact: true }).click();
    await page.locator('.account-request-row').first().waitFor();
  };
  for (const theme of ['light', 'dark']) {
    await open(theme);
    assert.equal(await page.evaluate(() => window.fixture.calls.length), 1, 'No automatic full-history fetch');
    assert.equal(await page.getByRole('heading', { name: '已加载用量', exact: true }).count(), 1);
    assert.equal(await page.locator('.account-settings-stats strong').first().textContent(), '100');
    assert.equal(await page.locator('.account-request-row[open]').count(), 0);
    await page.getByRole('button', { name: '同步历史', exact: true }).click();
    await page.getByRole('heading', { name: '累计用量', exact: true }).waitFor();
    assert.equal(await page.locator('.account-settings-stats strong').first().textContent(), '106');
    assert.equal(await page.evaluate(() => window.fixture.calls.length), 2);
    await page.locator('.account-request-row summary').first().click();
    assert.match(await page.locator('.account-request-row[open]').innerText(), /未记录/);
    await page.locator('.account-request-row summary').first().click();
    await page.getByRole('combobox', { name: '结算状态', exact: true }).selectOption('pending');
    assert.equal(await page.locator('.account-request-row').count(), 1);
    await page.getByRole('combobox', { name: '结算状态', exact: true }).selectOption('all');
    await page.locator('.account-activity-grid button[data-level="4"]:not(:disabled)').first().click();
    assert.equal(await page.locator('.account-request-row').count(), 1);
    await page.getByRole('button', { name: '清除日期', exact: true }).click();
    if (theme === 'dark') {
      const tokens = themeTokens({ base: 'dark', colors: { accent: '#31c48d', background: '#0a1410', panel: '#12201a', text: '#e6f2e8' } });
      await page.evaluate(tokens => {
        const root = document.documentElement; root.dataset.customTheme = 'fixture';
        for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);
      }, tokens);
      const sample = page.locator('.account-activity-grid button[data-level="4"]').first();
      assert.equal(await sample.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(49, 196, 141)');
      assert.equal(await page.locator('.account-activity-legend i[data-level="4"]').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(49, 196, 141)');
      await sample.hover();
      assert.equal(await sample.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(49, 196, 141)', 'Hover preserves usage color');
      await page.locator('.account-settings-activity').screenshot({ path: '.tmp/qa/account-calendar-custom-theme.png' });
      await page.evaluate(keys => {
        delete document.documentElement.dataset.customTheme;
        for (const key of keys) document.documentElement.style.removeProperty(key);
      }, Object.keys(tokens));
      assert.equal(await sample.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(20, 99, 161)', 'Disabling restores blue heatmap');
    }
    await page.getByRole('combobox', { name: '日历指标', exact: true }).selectOption('quota');
    assert.match(await page.locator('.account-settings-activity').innerText(), /基础额度/);
    await page.getByRole('combobox', { name: '日历指标', exact: true }).selectOption('tokens');
    await page.getByRole('button', { name: '网页账户', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixture.opened), 1);
    await page.locator('.application-settings-content').evaluate(el => el.scrollTop = 0);
    await mkdir('.tmp/qa', { recursive: true });
    await page.screenshot({ path: `.tmp/qa/account-settings-${theme}.png` });
    await page.locator('.account-settings-history').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.tmp/qa/account-settings-history-${theme}.png` });
    if (theme === 'dark') {
      await page.locator('.application-settings-nav').getByRole('button', { name: '通用', exact: true }).click();
      await page.locator('.application-settings-content').evaluate(el => el.scrollTop = 0);
      const surfaces = await page.evaluate(() => [
        ['.application-settings-modal', 'borderTopColor'], ['.application-settings-header', 'borderBottomColor'],
        ['.application-settings-nav', 'borderRightColor'], ['.preference-card', 'borderTopColor'],
        ['.preference-card-heading > span', 'backgroundColor'], ['.language-switch', 'borderTopColor'],
        ['.appearance-options button:not(.active)', 'borderTopColor'],
      ].map(([selector, property]) => ({ selector, color: getComputedStyle(document.querySelector(selector))[property] })));
      for (const surface of surfaces) {
        const channels = surface.color.match(/\d+/g).slice(0, 3).map(Number);
        assert.ok(Math.max(...channels) - Math.min(...channels) <= 8, `${surface.selector} should have a neutral color: ${surface.color}`);
      }
      const selected = await page.locator('.application-settings-nav button.active').evaluate(el => getComputedStyle(el).color);
      const channels = selected.match(/\d+/g).slice(0, 3).map(Number);
      assert.ok(channels[2] > channels[0], 'Selected navigation remains accented');
      await page.screenshot({ path: '.tmp/qa/settings-general-dark-neutral.png' });
      await page.locator('.application-settings-nav').getByRole('button', { name: '账户', exact: true }).click();
      await page.locator('.account-request-row').first().waitFor();
    }
  }
  await page.setViewportSize({ width: 740, height: 800 });
  await page.locator('.application-settings-content').evaluate(el => el.scrollTop = 0);
  const overflow = await page.locator('.account-settings').evaluate(el => el.scrollWidth > el.clientWidth + 1);
  assert.equal(overflow, false, 'Only the calendar scrolls horizontally, not the whole page');
  await page.screenshot({ path: '.tmp/qa/account-settings-narrow.png' });
  await page.getByRole('button', { name: '刷新账户与用量', exact: true }).click();
  await page.getByRole('heading', { name: '已加载用量', exact: true }).waitFor();
  await page.evaluate(() => { window.fixture.delay = true; });
  await page.getByRole('button', { name: '同步历史', exact: true }).click();
  await page.getByRole('button', { name: '停止加载', exact: true }).click();
  await page.evaluate(() => { window.fixture.delay = false; window.fixture.release(); });
  assert.equal(await page.getByRole('heading', { name: '累计用量', exact: true }).count(), 0, 'Canceled result is ignored');
  await page.evaluate(() => { window.fixture.fail = true; });
  await page.getByRole('button', { name: '同步历史', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '暂不支持请求历史' }).waitFor();
  assert.equal(await page.locator('.account-settings-stats strong').first().textContent(), '100', 'Error keeps already loaded records');
  await page.evaluate(() => { window.fixture.fail = false; window.fixture.delay = true; });
  await page.getByRole('button', { name: '同步历史', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('heading', { name: '连接你的 AporiaX 账户', exact: true }).waitFor();
  await page.evaluate(() => { window.fixture.delay = false; window.fixture.release(); });
  assert.equal(await page.locator('.account-request-row').count(), 0, 'No old account records after logout');
  await page.getByRole('button', { name: '登录账户', exact: true }).click();
  await page.locator('.account-request-row').first().waitFor();
  await page.locator('.application-settings-nav').getByRole('button', { name: '通用', exact: true }).click();
  await page.getByText('界面语言', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS settings navigation, light/dark/narrow layouts, bounded explicit sync, truthful totals, details/filters/calendar, web link, stop/error/retry, logout isolation and adjacent General settings.');
} finally { await browser.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
