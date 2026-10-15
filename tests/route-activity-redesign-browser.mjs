import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { themeTokens } from '../shared/appearance.js';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await mkdir('.tmp/qa', { recursive: true });
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/route-activity.html');
  const timeline = page.locator('.ra-timeline');
  await page.locator('.ra-state').waitFor();
  await page.evaluate(() => window.routeFixture.bulk());
  await page.waitForFunction(() => document.querySelectorAll('.ra-event').length === 3);
  assert.equal(await page.locator('.ra-event.failed').count(), 0, 'old failure is outside the recent preview');
  assert.match(await page.locator('.ra-alert').innerText(), /ENOENT/);
  await page.locator('.ra-alert').click();
  assert.equal(await page.getByRole('button', { name: '收起时间线', exact: true }).getAttribute('aria-expanded'), 'true');
  await page.locator('.ra-event.failed .ra-detail').waitFor();
  assert.equal(await page.locator('.ra-event.failed .ra-detail-button').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '收起时间线', exact: true }).click();
  assert.equal(await page.locator('.ra-history-controls').count(), 0);
  assert.equal(await timeline.locator('.ra-event').count(), 3);
  await page.evaluate(() => window.routeFixture.emit({ type: 'response.activity' }));
  assert.equal(await page.getByRole('button', { name: '展开时间线', exact: true }).getAttribute('aria-expanded'), 'false', 'heartbeat does not expand history');
  const current = await page.locator('.ra-current').boundingBox(), board = await page.locator('.ra-board').boundingBox();
  assert.ok(current.y < board.y, 'ongoing work precedes plan and files');
  await page.evaluate(() => window.routeFixture.emit({ type: 'turn.completed', status: 'partial', summary: '修改已保存，验证尚未完成' }));
  await page.locator('.ra-state').filter({ hasText: '部分完成' }).waitFor();
  assert.equal(await page.locator('.ra-current-row').count(), 0);
  for (const theme of ['light', 'dark', 'custom']) {
    await page.evaluate(({ theme, tokens }) => {
      const root = document.documentElement;
      root.dataset.theme = theme === 'light' ? 'light' : 'dark';
      if (theme === 'custom') {
        root.dataset.customTheme = 'route-refined';
        for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);
      } else { delete root.dataset.customTheme; root.removeAttribute('style'); }
    }, { theme, tokens: themeTokens({ base: 'dark', colors: { accent: '#31c48d', background: '#0a1410', panel: '#12201a', text: '#e6f2e8' } }) });
    const lines = await page.evaluate(() => ['.ra-overview', '.ra-stat', '.ra-agents', '.ra-agent-count', '.ra-card', '.ra-timeline', '.ra-event'].map(selector => {
      const style = getComputedStyle(document.querySelector(selector)); return [selector, style.borderTopWidth, style.borderBottomWidth, style.borderLeftWidth, style.borderRightWidth];
    }));
    for (const [selector, ...widths] of lines) assert.deepEqual(widths, Array(4).fill('0px'), `${theme}: ${selector} has no box or divider lines`);
    assert.equal(await page.locator('.ra-event').first().evaluate(el => getComputedStyle(el, '::before').content), 'none', 'timeline rail is removed');
    assert.equal(await timeline.locator('.ra-event').count(), 3);
    await page.locator('.route-activity').screenshot({ path: `.tmp/qa/route-refined-${theme}.png` });
  }
  await page.setViewportSize({ width: 430, height: 900 });
  assert.equal(await page.locator('.route-activity').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.locator('.ra-heading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.tmp/qa/route-refined-narrow.png' });
  await page.locator('.ra-history').scrollIntoViewIfNeeded();
  const narrowHistory = await page.locator('.ra-history').boundingBox();
  assert.ok(narrowHistory.y >= 0 && narrowHistory.y + narrowHistory.height <= 900, 'narrow history remains reachable within its scroll viewport');
  await page.screenshot({ path: '.tmp/qa/route-refined-narrow-history.png' });
  await page.getByRole('button', { name: '选择任务轮次', exact: true }).click();
  await page.locator('.ra-run-list button').last().click();
  await page.getByText('上一轮：检查项目结构', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '展开时间线', exact: true }).getAttribute('aria-expanded'), 'false');
  assert.equal(await timeline.locator('.ra-event').count(), 1, 'short histories keep all their records');
  assert.deepEqual(await page.evaluate(() => window.routeFixture.calls), [], 'redesign does not execute tools or mutate files');
  assert.deepEqual(errors, []);
  console.log('PASS route redesign: 3-event preview, discoverable older attention, keyboard details, live priority, honest partial state, line-free themes, narrow layout and per-run reset.');
} finally { await browser.close(); await server.close(); }
