import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer, preview } from 'vite';
import { chromium } from 'playwright-core';

const baseline = process.argv.includes('--baseline');
const built = process.argv.includes('--built');
const server = built
  ? await preview({ preview: { host: '127.0.0.1', port: 0, open: false } })
  : await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
if (!built) await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  // The dev server injects styles; production bundles use CSP-safe stylesheets.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, bypassCSP: !built });
  page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await mkdir('.tmp/qa/sidebar-chrome', { recursive: true });
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.theme.v2', new URLSearchParams(location.search).get('theme') || 'dark');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ welcomeDismissed: true, taskId: 'chrome-demo' }));
    const task = { id: 'chrome-demo', title: '查看工作进度', workspaceName: '演示项目', workspacePath: 'D:/Fixture', providerId: 'demo', modelId: 'demo', messages: [{ id: 'answer', role: 'assistant', status: 'completed', content: '已准备好。' }] };
    window.desktop = {
      theme: { set: async () => {} },
      providers: { list: async () => [{ id: 'demo', name: 'Demo', models: [{ id: 'demo', name: 'Demo' }] }] },
      tasks: { load: async () => [task, { ...task, id: 'other', title: '整理工作区' }], save: async () => {} },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
      sandbox: { status: async () => ({ localAvailable: true }) },
      account: { get: async () => ({ status: 'authenticated', profile: { id: 'fixture', displayName: '演示用户' }, quota: { remainingRatio: .5, cycleEnd: '2026-10-24T00:00:00Z' }, models: [] }) },
      workbench: { subscribe: () => () => {}, request: async ({ action }) => {
        if (action === 'list') return [];
        if (action === 'new-browser') return { id: 'browser-fixture', kind: 'browser', title: 'about:blank', url: 'about:blank', owner: 'user', status: 'running', taskId: task.id, workspacePath: task.workspacePath };
        return true;
      } },
      sideChat: { subscribe: () => () => {}, request: async () => ({ messages: [] }) },
    };
  });
  for (const theme of baseline ? ['dark'] : ['dark', 'light']) {
    await page.goto(server.resolvedUrls.local[0] + '?theme=' + theme);
    if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
    await page.locator('.local-account-profile').waitFor();
    await page.getByRole('button', { name: '打开工作侧栏', exact: true }).click();
    await page.getByRole('button', { name: '侧边聊天', exact: true }).click();
    await page.locator('.side-chat-modes').waitFor();
    const style = await page.evaluate(() => {
      const css = selector => getComputedStyle(document.querySelector(selector));
      return {
        text: css('.task-item:not(.active) .task-item-title').color,
        active: css('.task-item.active .task-item-title').color,
        name: css('.local-account-profile strong').color,
        tabInset: css('.workbench-chrome').paddingLeft,
        toolbarBg: css('.side-chat-toolbar').backgroundColor,
        toolbarRadius: css('.side-chat-toolbar').borderRadius,
        modeRadius: css('.side-chat-modes').borderRadius,
        height: document.querySelector('.side-chat-heading').getBoundingClientRect().height,
      };
    });
    console.log(theme, style);
    await page.screenshot({ path: `.tmp/qa/sidebar-chrome/${baseline ? 'before' : 'after'}-${theme}.png` });
    if (!baseline) {
      assert.equal(style.tabInset, '16px');
      assert.equal(style.toolbarBg, 'rgba(0, 0, 0, 0)');
      assert.equal(style.modeRadius, '6px');
      assert.equal(style.height, 44);
      assert.notEqual(style.text, style.active);
      assert.equal(style.text, style.name);
      await page.getByRole('button', { name: '普通聊天', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: '普通聊天', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.getByRole('button', { name: '关联当前任务', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: '关联当前任务', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.setViewportSize({ width: 1000, height: 760 });
      const bounds = await page.locator('.side-chat-heading').boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= 1001);
      assert.equal(await page.locator('.side-chat-toolbar').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('button', { name: '关闭标签', exact: true }).click();
      await page.getByRole('button', { name: '浏览器', exact: true }).click();
      await page.locator('.workbench-browser').waitFor();
      assert.equal(await page.locator('.workbench-tab.active .workbench-tab-title').innerText(), 'about:blank');
      assert.equal(await page.locator('.workbench-tab.active .workbench-tab-dot').count(), 0);
      await page.locator('.workbench-chrome').screenshot({ path: `.tmp/qa/sidebar-chrome/browser-${built ? 'built' : 'dev'}-${theme}.png` });
    }
  }
  assert.deepEqual(errors, []);
  console.log(baseline ? 'Baseline captured.' : `PASS ${built ? 'built' : 'dev'} sidebar typography, header inset, compact side-chat controls, mode switching, light/dark/narrow layout and no browser tab dots.`);
} finally { await browser.close(); if (built) await new Promise(resolve => server.httpServer.close(resolve)); else await server.close(); }
