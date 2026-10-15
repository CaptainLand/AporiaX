import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { themeTokens } from '../shared/appearance.js';

const baseline = process.argv.includes('--baseline');
const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.clear(); localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.theme.v2', new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'side-fade', welcomeDismissed: true }));
    const task = { id: 'side-fade', title: '侧栏界面演示', workspacePath: 'D:/Fixture', workspaceName: '演示项目', providerId: 'fixture', modelId: 'fixture',
      messages: [{ id: 'main-answer', role: 'assistant', status: 'completed', content: '这是合成界面演示，不读取真实工作区。' }] };
    const messages = Array.from({ length: 12 }, (_, index) => ({ id: `side-${index}`, role: 'assistant', status: 'completed', modelId: 'fixture',
      content: `### 侧聊步骤 ${index + 1}\n\n${'顶部文字自然淡化，滚动位置和输入框保持原样。\n\n'.repeat(4)}`, createdAt: '2026-10-15T00:00:00Z' }));
    const listeners = new Set(); window.sideCalls = []; window.emptyTaskHistory = false;
    window.emitSide = message => { for (const fn of listeners) fn({ type: 'message', ...window.lastSideLoad, message }); };
    window.desktop = {
      theme: { set: async () => {} }, account: { get: async () => ({ status: 'anonymous' }) },
      providers: { list: async () => [{ id: 'fixture', name: '演示模型', models: [{ id: 'fixture', name: '演示模型' }] }] },
      tasks: { load: async () => [task], save: async () => {} }, harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
      sandbox: { status: async () => ({ localAvailable: true }) }, workspace: { listTree: async () => ({ entries: [] }) },
      workbench: { subscribe: () => () => {}, request: async input => input.action === 'list' ? [] : true },
      sideChat: { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, request: async input => {
        window.sideCalls.push(input.action); if (input.action === 'load') window.lastSideLoad = input;
        return { messages: input.mode === 'task' && !window.emptyTaskHistory ? messages : [] };
      } },
    };
  });
  await mkdir('.tmp/qa', { recursive: true });
  const metrics = {};
  for (const theme of ['light', 'dark', 'custom']) {
    await page.goto(server.resolvedUrls.local[0] + '?theme=' + theme);
    if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
    await page.getByRole('button', { name: '打开工作侧栏', exact: true }).click();
    await page.getByRole('button', { name: '打开内容', exact: true }).click();
    await page.getByRole('menuitem', { name: '侧边聊天', exact: true }).click();
    await page.locator('.side-chat-message').nth(11).waitFor();
    if (theme === 'custom') await page.evaluate(tokens => {
      document.documentElement.dataset.customTheme = 'side-fade';
      for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
    }, themeTokens({ base: 'dark', colors: { accent: '#31c48d', background: '#0a1410', panel: '#12201a', text: '#e6f2e8' } }));
    await page.evaluate(() => document.fonts.ready);
    metrics[theme] = await page.evaluate(() => Object.fromEntries(['.workbench-chrome', '.side-chat-heading', '.side-chat-messages', '.side-chat-composer', '.thread-body', '.composer', '.workbench-resizer'].map(selector => {
      const el = document.querySelector(selector), rect = el.getBoundingClientRect();
      return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }];
    })));
    const borders = await page.evaluate(() => ['.workbench-chrome', '.side-chat-heading'].map(selector => getComputedStyle(document.querySelector(selector)).borderBottomColor));
    if (baseline) { assert(borders.every(color => color !== 'rgba(0, 0, 0, 0)')); continue; }
    assert.deepEqual(borders, Array(2).fill('rgba(0, 0, 0, 0)'));
    const scroll = page.locator('.side-chat-messages');
    const checkFade = async (position, expected) => {
      await scroll.evaluate((el, value) => { el.scrollTop = value === 'bottom' ? el.scrollHeight : value; }, position);
      await page.waitForFunction(expected => document.querySelector('.side-chat-scroll-surface')?.dataset.fadeTop === String(expected), expected);
      assert.equal(await page.locator('.side-chat-scroll-surface').getAttribute('data-fade-bottom'), 'false');
    };
    await checkFade(0, false); await checkFade(100, true); await checkFade('bottom', true); await checkFade(100, true);
    assert.equal(await page.locator('.side-chat-scroll-surface').evaluate(el => getComputedStyle(el, '::before').height), '18px');
    assert.equal(await page.locator('.side-chat-scroll-surface').evaluate(el => getComputedStyle(el, '::before').pointerEvents), 'none');
    assert.equal(await scroll.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + 8)); }), true);
    await page.screenshot({ path: `.tmp/qa/side-chat-soft-boundaries-${theme}.png` });
    const input = page.getByRole('textbox', { name: '侧聊输入', exact: true });
    await input.fill('保留侧聊草稿');
    await page.getByRole('button', { name: '普通聊天', exact: true }).click();
    await page.getByText('有什么需要我帮你看看？', { exact: true }).waitFor();
    await checkFade(0, false);
    // A new streamed response creates overflow without resizing the pane.
    await page.evaluate(() => window.emitSide({ id: 'new-stream', role: 'assistant', status: 'running', content: '流式演示段落。\n\n'.repeat(80), createdAt: '2026-10-15T00:00:00Z' }));
    await page.locator('.side-chat-message').waitFor(); await checkFade(100, true);
    await page.evaluate(() => window.emitSide({ id: 'new-stream', role: 'assistant', status: 'completed', content: '短回复。', createdAt: '2026-10-15T00:00:00Z' }));
    await checkFade(0, false);
    await page.getByRole('button', { name: '关联当前任务', exact: true }).click();
    await page.locator('.side-chat-message').nth(11).waitFor();
    assert.equal(await input.inputValue(), '保留侧聊草稿');
    const more = page.getByRole('button', { name: '侧聊更多操作', exact: true });
    await more.focus(); await page.keyboard.press('ArrowDown');
    const menu = page.getByRole('menu', { name: '侧聊更多操作', exact: true });
    await menu.waitFor();
    assert.equal(await menu.getByRole('menuitem', { name: '查看任务状态' }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('ArrowDown');
    assert.equal(await menu.getByRole('menuitem', { name: '清空侧聊历史' }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await more.evaluate(el => el === document.activeElement), true);
    await more.click();
    await page.locator('.thread-header').click();
    await menu.waitFor({ state: 'hidden' });
    await page.evaluate(() => { window.emptyTaskHistory = true; });
    await page.getByRole('button', { name: '普通聊天', exact: true }).click();
    await page.getByText('聊点别的，不读取主任务内容。', { exact: true }).waitFor();
    await page.locator('.side-chat').screenshot({ path: `.tmp/qa/side-chat-refined-general-${theme}.png` });
    await page.getByRole('button', { name: '关联当前任务', exact: true }).click();
    await page.getByText('基于当前任务记录，聊进度、错误和下一步。', { exact: true }).waitFor();
    assert.equal(await page.locator('.side-chat-status-trigger').innerText(), '任务已完成');
    assert.equal(await page.locator('.side-chat-companion').count(), 1);
    assert.equal(await page.locator('.side-chat-suggestions button').count(), 3);
    assert.equal(await page.locator('.side-chat-suggestions button').first().evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
    await page.locator('.side-chat-suggestions button').first().click();
    assert.equal(await input.inputValue(), '现在做到哪了？');
    assert.equal(await input.evaluate(el => el === document.activeElement), true);
    await more.click();
    assert.equal(await menu.getByRole('menuitem', { name: '清空侧聊历史' }).isDisabled(), true);
    await menu.getByRole('menuitem', { name: '查看任务状态' }).click();
    await page.getByRole('dialog', { name: '任务状态', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await more.evaluate(el => el === document.activeElement), true, 'dialog restores focus to persistent More button');
    await input.fill('');
    await page.mouse.move(20, 20);
    await page.locator('.workbench-panel').screenshot({ path: `.tmp/qa/side-chat-refined-${theme}.png` });
    // The refined controls fit a narrow pane, and menus do not push content.
    const separator = page.getByRole('separator', { name: '调整侧栏宽度' });
    await separator.focus();
    for (let index = 0; index < 12; index++) await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('.side-chat').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    assert.equal(await page.locator('.side-chat-toolbar').evaluate(el => [...el.children].every(child => child.getBoundingClientRect().right <= el.getBoundingClientRect().right)), true);
    await more.click();
    const popup = await menu.boundingBox(), panel = await page.locator('.side-chat').boundingBox();
    assert.ok(popup.x >= panel.x && popup.x + popup.width <= panel.x + panel.width);
    await page.keyboard.press('Escape');
    await page.locator('.workbench-panel').screenshot({ path: `.tmp/qa/side-chat-refined-compact-${theme}.png` });
    assert.equal(await page.evaluate(() => window.sideCalls.every(action => action === 'load')), true, 'no model requests or handoffs');
    console.log(`PASS ${theme}: invisible right dividers, scroll edges, no overflow, streaming, click-through and draft retention.`);
  }
  if (baseline) await writeFile('.tmp/qa/side-chat-soft-boundaries-baseline.json', JSON.stringify(metrics, null, 2));
  else if (process.argv.includes('--compare-baseline')) assert.deepEqual(metrics, JSON.parse(await readFile('.tmp/qa/side-chat-soft-boundaries-baseline.json', 'utf8')), 'all pane rectangles and scroll ranges are unchanged');
  assert.deepEqual(errors, []);
  console.log(baseline ? 'BASELINE right chrome, conversation and composer geometry saved.' : 'PASS sidebar soft boundaries; no browser errors.');
} finally { await browser.close(); await server.httpServer.close(); }
