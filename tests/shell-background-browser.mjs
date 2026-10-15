import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
const baseline = process.argv.includes('--baseline');
const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('aporiax.theme.v2', 'light');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'shell-test', welcomeDismissed: true }));
    window.desktop = {
      theme: { set: async () => {} }, account: { get: async () => ({ status: 'anonymous' }) },
      tasks: { load: async () => [{ id: 'shell-test', title: '演示任务', workspaceName: '演示项目', workspacePath: 'D:/Fixture', messages: [] }], save: async () => {} },
      providers: { list: async () => [] },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
      sandbox: { status: async () => ({ localAvailable: true }) },
      workspace: { listTree: async () => ({ entries: [] }) },
      workbench: { subscribe: () => () => {}, request: async () => [] },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.locator('.thread-header').waitFor();
  for (const theme of ['light', 'dark', 'light']) {
    if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) await page.locator('.theme-toggle').click();
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    const colors = await page.evaluate(() => Object.fromEntries(['titlebar', 'sidebar', 'thread-header', 'thread'].map(name => [name, getComputedStyle(document.querySelector('.' + name)).backgroundColor])));
    if (baseline && theme === 'light') assert.notEqual(colors.titlebar, colors.sidebar);
    else assert.equal(colors.titlebar, colors.sidebar);
    assert.equal(colors.sidebar, theme === 'light' ? 'rgb(243, 244, 246)' : 'rgb(20, 22, 26)');
    assert.notEqual(colors.sidebar, colors.thread);
    assert.equal(colors['thread-header'], colors.thread, 'conversation header stays on the working surface');
    const corner = await page.evaluate(() => ({ radius: getComputedStyle(document.querySelector('.main-surface')).borderTopLeftRadius,
      divider: getComputedStyle(document.querySelector('.sidebar')).borderRightWidth,
      clip: getComputedStyle(document.querySelector('.main-surface')).overflow,
      surround: getComputedStyle(document.querySelector('.app-content')).backgroundColor }));
    assert.equal(corner.radius, '24px');
    assert.equal(corner.divider, '0px', 'no sidebar/workspace vertical line');
    assert.equal(corner.clip, 'hidden', 'child pane backgrounds follow the rounded corner');
    assert.equal(corner.surround, colors.sidebar);
    await mkdir('.tmp/qa', { recursive: true });
    await page.screenshot({ path: `.tmp/qa/workspace-rounded-${theme}.png`, clip: { x: 230, y: 18, width: 400, height: 210 } });
    console.log(`${baseline ? 'BASELINE' : 'PASS'} ${theme}: ${JSON.stringify(colors)}`);
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
