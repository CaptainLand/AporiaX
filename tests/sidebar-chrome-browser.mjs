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
    const task = { id: 'chrome-demo', title: '查看工作进度', workspaceName: '演示项目', workspacePath: 'D:/Fixture', providerId: 'demo', modelId: 'demo', messages: [{
      id: 'answer', role: 'assistant', status: 'completed', content: '### 当前结果\n\n已完成界面细节调整，辅助记录不会抢占正文的视觉重点。',
      changes: [{ path: 'src/demo.js', created: true, beforeMissing: true, beforeContent: '', afterContent: 'new', additions: 1, deletions: 0 }],
      witness: { status: 'completed', revision: 1, counters: { activeAgents: 0 }, records: ['turn.started', 'plan.updated', 'response.reset', 'turn.completed'].map((eventType, i) => ({ id: `record-${i}`, eventType, status: 'completed', detail: '已保留本轮行动记录', elapsedMs: i * 20 })) },
    }] };
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
    await page.locator('.witness-panel').waitFor();
    if (!baseline) {
      const colors = await page.evaluate(() => {
        const color = selector => getComputedStyle(document.querySelector(selector)).color;
        const probe = document.createElement('span');
        document.body.append(probe);
        probe.style.color = 'var(--text-2)'; const secondary = getComputedStyle(probe).color;
        probe.style.color = 'var(--text-3)'; const muted = getComputedStyle(probe).color;
        probe.remove();
        return { secondary, muted, heading: color('.witness-heading strong'), current: color('.witness-current strong'), record: color('.witness-record strong'), detail: color('.witness-current p'), title: color('.edited-files-title strong'), file: color('.edited-file-name'), toggle: color('.witness-toggle'), bar: getComputedStyle(document.querySelector('.local-account-profile .local-account-quota-track')).height };
      });
      for (const key of ['heading', 'current', 'record', 'title', 'file', 'toggle']) assert.equal(colors[key], colors.secondary, `${theme}: ${key} uses secondary text`);
      assert.equal(colors.detail, colors.muted);
      assert.equal(colors.bar, '3px');
      assert.match(await page.locator('.local-account-quota-label').innerText(), /^reset /);
      assert.doesNotMatch(await page.locator('.local-account-quota-label').innerText(), /周额度|Weekly|·/);
      assert.equal(await page.locator('.witness-current').isVisible(), true);
      await page.locator('.witness-toggle').click();
      assert.equal(await page.locator('.witness-record').count(), 4);
      await page.locator('.witness-toggle').click();
      assert.equal(await page.locator('.witness-record').count(), 3);
      await page.screenshot({ path: `.tmp/qa/sidebar-chrome/quiet-cards-${theme}.png` });
    }
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
