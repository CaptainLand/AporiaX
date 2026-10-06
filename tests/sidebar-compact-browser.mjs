import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer, preview } from 'vite';
import { chromium } from 'playwright-core';

const baseline = process.argv.includes('--baseline');
const typographyBaseline = process.argv.includes('--typography-baseline');
const production = process.argv.includes('--production');
const server = production ? await preview({ preview: { host: '127.0.0.1', port: 0, open: false } })
  : await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
if (!production) await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1250, height: 800 }, bypassCSP: !production });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.theme.v2', 'light');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: '111', welcomeDismissed: true }));
    const groups = [
      ['市场', ['test', '111', '市场开发']],
      ['冻梨舞萌杯2026后台系统', ['冻梨舞萌杯2026后台系统中的一个很长很长的任务标题', '任务2', 'build']],
      ['Agent开发', ['打包']],
      ['Projects', ['Landx']],
    ];
    const tasks = groups.flatMap(([workspaceName, names]) => names.map((title, i) => ({
      id: title === '111' ? '111' : `${workspaceName}-${i}`, title,
      workspaceName, workspacePath: `D:/Fixture/${workspaceName}`, createdAt: '2026-10-06T00:00:00Z',
      providerId: 'own', modelId: 'test', builderLimit: 2,
      messages: [{ id: `answer-${workspaceName}-${i}`, role: 'assistant', content: `当前任务：${title}`, status: 'completed' }],
    })));
    window.sidebarCalls = [];
    window.desktop = {
      theme: { set: async () => {} },
      providers: { list: async () => [{ id: 'own', name: 'Test', models: [{ id: 'test', name: 'Test' }] }] },
      account: { get: async () => ({ status: 'anonymous' }) },
      tasks: { load: async () => tasks, save: async () => {} },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
      sandbox: { status: async () => ({ localAvailable: true }) },
      selectDirectory: async () => 'D:/Fixture/市场',
      workspace: { listTree: async () => ({ entries: [] }) },
      workbench: { subscribe: () => () => {}, request: async input => { window.sidebarCalls.push(input); return input.action === 'list' ? [] : true; } },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  const sidebar = page.locator('.sidebar');
  await sidebar.locator('.task-item').last().waitFor();
  assert.equal(await sidebar.locator('.sidebar-project').count(), 4);
  assert.equal(await sidebar.locator('.task-item').count(), 8);
  await page.mouse.move(800, 300);
  const metrics = () => page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar');
    const row = document.querySelector('.sidebar-project .task-item');
    const header = document.querySelector('.sidebar-project-toggle');
    const group = document.querySelector('.sidebar-project-tasks');
    const add = document.querySelector('.sidebar-project-add');
    const title = row.querySelector('.task-item-title');
    return {
      rowHeight: row.getBoundingClientRect().height, headerHeight: header.getBoundingClientRect().height,
      taskIcons: row.querySelectorAll('svg').length, headerIcons: header.querySelectorAll('svg').length,
      treeLine: getComputedStyle(group, '::before').content,
      titleWeight: getComputedStyle(title).fontWeight,
      titleSize: getComputedStyle(title).fontSize, headerWeight: getComputedStyle(header.querySelector('span')).fontWeight,
      addOpacity: getComputedStyle(add).opacity, horizontalOverflow: sidebar.scrollWidth > sidebar.clientWidth,
    };
  });
  const sidebarMetrics = await metrics();
  const typography = () => page.evaluate(() => {
    const read = selector => { const css = getComputedStyle(document.querySelector(selector)); return { size: css.fontSize, weight: css.fontWeight }; };
    return { body: read('.assistant-message-content'), heading: read('.sidebar-heading'), newTask: read('.new-task-button span:nth-child(2)'),
      project: read('.sidebar-project-toggle > span'), task: read('.task-item-title') };
  });
  const type = await typography();
  if (baseline) {
    assert.equal(sidebarMetrics.rowHeight, 38); assert.equal(sidebarMetrics.taskIcons, 1);
    assert.equal(sidebarMetrics.headerIcons, 2); assert.equal(sidebarMetrics.headerHeight, 34);
  } else {
    assert.equal(sidebarMetrics.rowHeight, 30); assert.equal(sidebarMetrics.headerHeight, 30);
    assert.equal(sidebarMetrics.taskIcons, 0); assert.equal(sidebarMetrics.headerIcons, 1);
    assert.ok(['none', 'normal'].includes(sidebarMetrics.treeLine));
    assert.equal(sidebarMetrics.headerWeight, '400'); assert.equal(sidebarMetrics.titleWeight, '400');
    assert.equal(sidebarMetrics.addOpacity, '0'); assert.equal(sidebarMetrics.horizontalOverflow, false);
    assert.equal(await sidebar.locator('.sidebar-project-toggle small').count(), 0);
  }
  if (typographyBaseline) {
    assert.equal(type.body.size, '14px'); assert.equal(type.task.size, '13px');
    assert.equal(type.heading.size, '15px'); assert.equal(type.newTask.size, '15px');
  } else if (!baseline) {
    for (const item of ['heading', 'newTask', 'project', 'task']) assert.deepEqual(type[item], type.body, `${item} typography matches ordinary conversation text`);
  }
  assert.equal(await sidebar.locator('.task-list > .section-label').count(), baseline || typographyBaseline ? 1 : 0);
  await mkdir('.tmp/qa', { recursive: true });
  await sidebar.screenshot({ path: `.tmp/qa/sidebar-${baseline ? 'baseline' : production ? 'compact-production' : 'compact'}-light.png` });
  console.log(`${baseline ? 'BASELINE' : 'PASS'} sidebar metrics ${JSON.stringify(sidebarMetrics)}`);
  const market = sidebar.locator('.sidebar-project').filter({ has: page.locator('.sidebar-project-toggle', { hasText: '市场' }) });
  await market.locator('.sidebar-project-toggle').click();
  assert.equal(await market.locator('.task-item').count(), 0);
  if (!baseline) assert.equal(await market.locator('.sidebar-project-toggle').getAttribute('aria-expanded'), 'false');
  await market.locator('.sidebar-project-toggle').click();
  assert.equal(await market.locator('.task-item').count(), 3);
  const target = market.getByRole('button', { name: 'test', exact: true });
  await target.click();
  assert.match(await target.getAttribute('class'), /active/);
  await page.getByText('当前任务：test', { exact: true }).waitFor();
  if (!baseline) assert.equal(await target.getAttribute('aria-current'), 'page');
  await target.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名任务' }).waitFor();
  await page.keyboard.press('Escape'); assert.equal(await page.locator('.sidebar-task-context-menu').count(), 0);
  await sidebar.getByRole('button', { name: '搜索项目或任务' }).click();
  const search = sidebar.getByRole('textbox', { name: '搜索项目或任务' });
  const focusAppearance = async () => {
    await search.focus();
    return search.evaluate(el => {
      const input = getComputedStyle(el), box = getComputedStyle(el.parentElement);
      return { outlineStyle: input.outlineStyle, outlineWidth: input.outlineWidth, inputShadow: input.boxShadow,
        boxShadow: box.boxShadow, borderWidth: box.borderTopWidth, borderColor: box.borderTopColor };
    });
  };
  const lightFocus = await focusAppearance();
  if (typographyBaseline) { assert.notEqual(lightFocus.outlineStyle, 'none'); assert.notEqual(lightFocus.boxShadow, 'none'); }
  else if (!baseline) {
    assert.equal(lightFocus.outlineStyle, 'none'); assert.equal(lightFocus.inputShadow, 'none');
    assert.equal(lightFocus.boxShadow, 'none'); assert.equal(lightFocus.borderWidth, '1px');
    const rgb = lightFocus.borderColor.match(/\d+/g).map(Number); assert.ok(Math.max(...rgb) - Math.min(...rgb) < 10, 'Search focus uses a neutral gray border');
  }
  await search.fill('build'); assert.equal(await sidebar.locator('.task-item').count(), 1);
  assert.equal(await sidebar.locator('.task-item-title').innerText(), 'build');
  await sidebar.getByRole('button', { name: '清空搜索' }).click();
  assert.equal(await sidebar.locator('.task-item').count(), 8);
  await sidebar.getByRole('button', { name: '搜索项目或任务' }).click();
  if (!baseline) {
    await market.locator('.sidebar-project-row').hover();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.sidebar-project-add')).opacity === '1');
    await page.mouse.move(800, 300);
    await market.locator('.sidebar-project-add').focus();
    assert.equal(await market.locator('.sidebar-project-add').evaluate(el => getComputedStyle(el).opacity), '1');
  }
  await market.locator('.sidebar-project-add').click();
  await page.locator('#task-title').waitFor();
  assert.match(await page.locator('#task-project option:checked').innerText(), /^市场/);
  assert.equal(await page.locator('.workspace-picker-copy small').innerText(), 'D:/Fixture/市场');
  await page.keyboard.press('Escape');
  // Dismiss via the ordinary modal cancel button if Escape is not supported.
  if (await page.locator('#task-title').isVisible()) await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('.theme-toggle').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.mouse.move(800, 300);
  await sidebar.screenshot({ path: `.tmp/qa/sidebar-${baseline ? 'baseline' : production ? 'compact-production' : 'compact'}-dark.png` });
  assert.equal((await metrics()).rowHeight, baseline ? 38 : 30);
  if (!baseline) {
    const darkType = await typography();
    if (!typographyBaseline) {
      for (const item of ['heading', 'newTask', 'project', 'task']) assert.deepEqual(darkType[item], darkType.body, `dark ${item} typography parity`);
      await sidebar.getByRole('button', { name: '搜索项目或任务' }).click();
      const darkFocus = await focusAppearance();
      assert.equal(darkFocus.outlineStyle, 'none'); assert.equal(darkFocus.boxShadow, 'none');
      assert.equal(darkFocus.borderWidth, '1px');
      const rgb = darkFocus.borderColor.match(/\d+/g).map(Number); assert.ok(Math.max(...rgb) - Math.min(...rgb) < 10);
      await sidebar.screenshot({ path: `.tmp/qa/sidebar-search-neutral-${production ? 'production-' : ''}dark.png` });
      await sidebar.getByRole('button', { name: '搜索项目或任务' }).click();
    }
    const long = sidebar.locator('.task-item-title').filter({ hasText: '一个很长很长' });
    assert.equal(await long.evaluate(el => getComputedStyle(el).textOverflow), 'ellipsis');
    assert.equal(await long.locator('..').locator('..').getAttribute('title'), await long.innerText());
  }
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.sidebarCalls.some(c => ['send', 'commit', 'push'].includes(c.action || c.operation))), false);
  console.log('PASS project fold/unfold, task switch, right-click/Escape, search/clear, add-task modal, light/dark, no user data or model/Git mutations.');
  console.log(`${typographyBaseline ? 'BASELINE' : 'PASS'} typography ${JSON.stringify(type)}; search focus ${JSON.stringify(lightFocus)}.`);
} finally { await browser.close(); await server.httpServer.close(); }
