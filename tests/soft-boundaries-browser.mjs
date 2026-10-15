import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { themeTokens } from '../shared/appearance.js';

const baseline = process.argv.includes('--baseline');
const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.clear(); localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.theme.v2', new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'soft-0', welcomeDismissed: true }));
    const messages = Array.from({ length: 12 }, (_, index) => ({ id: `answer-${index}`, role: 'assistant', status: 'completed',
      content: `### 演示步骤 ${index + 1}\n\n${'边缘自然淡化，正文保持清晰。滚动时不改变文字大小与阅读位置。\n\n'.repeat(4)}` }));
    const tasks = Array.from({ length: 48 }, (_, index) => ({ id: `soft-${index}`, title: index === 0 ? '演示长对话' : `演示任务 ${String(index).padStart(2, '0')}`,
      workspacePath: 'D:/Fixture/Office', workspaceName: '演示项目', providerId: 'fixture', modelId: 'fixture', messages: index === 0 ? messages : [] }));
    window.desktop = {
      theme: { set: async () => {} }, account: { get: async () => ({ status: 'authenticated', profile: { displayName: '演示用户' }, quota: { remainingRatio: .82 } }) },
      providers: { list: async () => [{ id: 'fixture', name: '演示模型', models: [{ id: 'fixture', name: '演示模型' }] }] },
      tasks: { load: async () => tasks, save: async () => {} }, harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
      sandbox: { status: async () => ({ localAvailable: true }) }, workspace: { listTree: async () => ({ entries: [] }) },
      workbench: { subscribe: () => () => {}, request: async input => input.action === 'list' ? [] : true },
    };
  });
  await mkdir('.tmp/qa', { recursive: true });
  const metrics = {};
  for (const theme of ['light', 'dark', 'custom']) {
    await page.goto(server.resolvedUrls.local[0] + '?theme=' + theme);
    if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
    await page.locator('.assistant-message').nth(11).waitFor();
    if (theme === 'custom') await page.evaluate(tokens => {
      document.documentElement.dataset.customTheme = 'soft-boundaries';
      for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
    }, themeTokens({ base: 'dark', colors: { accent: '#31c48d', background: '#0a1410', panel: '#12201a', text: '#e6f2e8' } }));
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    metrics[theme] = await page.evaluate(() => Object.fromEntries(['.titlebar', '.thread-header', '.thread-view-tabs', '.thread-body', '.task-list', '.local-account-panel', '.composer'].map(selector => {
      const el = document.querySelector(selector), box = el.getBoundingClientRect();
      return [selector, { x: box.x, y: box.y, width: box.width, height: box.height, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }];
    })));
    const lines = await page.evaluate(() => [getComputedStyle(document.querySelector('.titlebar')).borderBottomColor,
      getComputedStyle(document.querySelector('.thread-header')).borderBottomColor, getComputedStyle(document.querySelector('.thread-view-tabs')).borderBottomColor,
      getComputedStyle(document.querySelector('.local-account-panel')).borderTopColor]);
    if (baseline) {
      assert(lines.every(color => color !== 'rgba(0, 0, 0, 0)'), 'reproduce four visible separators');
      await page.screenshot({ path: `.tmp/qa/soft-boundaries-before-${theme}.png` });
      continue;
    }
    assert.deepEqual(lines, Array(4).fill('rgba(0, 0, 0, 0)'), 'all four separators disappear');
    assert.equal(await page.locator('.thread-view-tabs').evaluate(el => getComputedStyle(el).boxShadow), 'none', 'no residual inset separator in dark themes');
    const checkEdges = async (selector, position, top, bottom) => {
      await page.locator(selector).evaluate((el, value) => { el.scrollTop = value === 'bottom' ? el.scrollHeight : value; }, position);
      await page.waitForFunction(({ selector, top, bottom }) => {
        const shell = document.querySelector(selector).parentElement;
        return shell.dataset.fadeTop === String(top) && shell.dataset.fadeBottom === String(bottom);
      }, { selector, top, bottom });
    };
    for (const selector of ['.thread-body', '.task-list']) {
      const bottomFade = selector === '.task-list';
      await checkEdges(selector, 0, false, bottomFade);
      await checkEdges(selector, 100, true, bottomFade);
      await checkEdges(selector, 'bottom', true, false);
      await checkEdges(selector, 100, true, bottomFade);
      assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el.parentElement, '::before').pointerEvents), 'none');
      assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el.parentElement, '::after').pointerEvents), 'none');
    }
    const marker = await page.locator('.thread-view-tabs button.active').evaluate(el => getComputedStyle(el, '::after').opacity);
    assert.equal(marker, '1', 'active tab short marker is retained');
    const before = metrics[theme];
    await page.screenshot({ path: `.tmp/qa/soft-boundaries-${theme}.png` });
    // Content can still be clicked in the fading strip.
    const lastTask = page.locator('.task-item').last();
    await checkEdges('.task-list', 'bottom', true, false);
    await lastTask.click({ position: { x: 70, y: 27 } });
    assert.equal(await lastTask.getAttribute('aria-current'), 'page');
    await page.waitForFunction(() => document.querySelector('.thread-scroll-surface')?.dataset.fadeTop === 'false' && document.querySelector('.thread-scroll-surface')?.dataset.fadeBottom === 'false');
    await page.getByRole('button', { name: '搜索项目或任务', exact: true }).click();
    const search = page.getByRole('textbox', { name: '搜索项目或任务', exact: true });
    await search.fill('演示任务 47');
    await page.waitForFunction(() => document.querySelector('.task-list-surface')?.dataset.fadeTop === 'false' && document.querySelector('.task-list-surface')?.dataset.fadeBottom === 'false');
    await search.fill('');
    await checkEdges('.task-list', 100, true, true);
    await page.getByRole('button', { name: '演示长对话', exact: true }).click();
    await checkEdges('.thread-body', 100, true, false);
    await page.getByRole('button', { name: '执行记录', exact: true }).first().click();
    await page.waitForFunction(() => document.querySelector('.thread-scroll-surface')?.dataset.fadeTop === 'false' && document.querySelector('.thread-scroll-surface')?.dataset.fadeBottom === 'false');
    await page.getByRole('button', { name: '对话', exact: true }).click();
    await checkEdges('.thread-body', 100, true, false);
    const after = await page.locator('.thread-body').boundingBox();
    assert.deepEqual(after, { x: before['.thread-body'].x, y: before['.thread-body'].y, width: before['.thread-body'].width, height: before['.thread-body'].height });
    console.log(`PASS ${theme}: separators, scroll edges, no-overflow, click-through, view switching and theme colors.`);
  }
  if (baseline) await writeFile('.tmp/qa/soft-boundaries-baseline.json', JSON.stringify(metrics, null, 2));
  else if (process.argv.includes('--compare-baseline')) {
    const previous = JSON.parse(await readFile('.tmp/qa/soft-boundaries-baseline.json', 'utf8'));
    assert.deepEqual(metrics, previous, 'borders and fading do not move or resize panes or scroll content');
  }
  assert.deepEqual(errors, []);
  console.log(baseline ? 'BASELINE four visible lines, layout saved (synthetic data only).' : `PASS soft boundaries${process.argv.includes('--compare-baseline') ? ': before/after layout identical' : ''}; no browser errors.`);
} finally { await browser.close(); await server.httpServer.close(); }
