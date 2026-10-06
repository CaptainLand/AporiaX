import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer, preview } from 'vite';
import { chromium } from 'playwright-core';

const baseline = process.env.PANE_THEME_BASELINE === '1';
const toolbarBaseline = process.env.PANE_TOOLBAR_BASELINE === '1';
const production = process.env.PANE_THEME_PRODUCTION === '1';
const server = production
  ? await preview({ preview: { host: '127.0.0.1', port: 0, open: false } })
  : await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
if (!production) await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 850 }, bypassCSP: !production });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.theme.v2', 'light');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ welcomeDismissed: true }));
    window.paneCalls = [];
    const resources = {};
    const account = { status: 'authenticated', profile: { displayName: '测试账号', email: 'test@example.invalid' }, quota: { remainingRatio: .8 }, models: [{ displayName: 'DeepSeek V4.1 Flash' }] };
    window.desktop = {
      theme: { set: async () => {} },
      providers: { list: async () => [{ id: 'own', name: '测试模型', models: [{ id: 'own-model', name: 'Test model' }] }] },
      account: { get: async () => account, refresh: async () => account, openCenter: async () => ({ opened: true }) },
      tasks: { load: async () => [], save: async () => {} },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
      sandbox: { status: async () => ({ localAvailable: true }) },
      selectDirectory: async () => 'D:/Fixture',
      workspace: {
        listTree: async () => ({ entries: [{ path: 'fixture.js', name: 'fixture.js', kind: 'file', type: 'file' }] }),
        readPreview: async () => ({ content: "const example = 'preview';", path: 'fixture.js' }),
      },
      workbench: { request: async input => {
        window.paneCalls.push(input);
        if (input.action === 'list') return Object.values(resources);
        if (input.action === 'new-browser' || input.action === 'new-terminal') {
          const kind = input.action.slice(4), id = `${kind}-${Object.keys(resources).length}`;
          return resources[id] = { ...input, id, kind, title: kind === 'browser' ? 'about:blank' : 'Terminal', owner: 'user', cwd: 'D:/Fixture', url: 'about:blank', status: 'running' };
        }
        if (input.action === 'read') return { status: 'running', output: '', cursor: input.cursor || 0 };
        if (input.action === 'console') return { entries: [], network: [] };
        if (input.action === 'search') return { entries: [{ path: 'fixture.js' }] };
        if (input.action === 'git') {
          if (input.operation === 'log') return [];
          return { repository: true, root: 'D:/Fixture', branch: 'main', files: [], remotes: [], revision: 'fixture', head: 'fixture', ahead: 0, behind: 0 };
        }
        return true;
      }, subscribe: () => () => {} },
      sideChat: { request: async input => { window.paneCalls.push(input); return { messages: [] }; }, subscribe: () => () => {} },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.locator('.local-account-profile').waitFor();
  await page.getByRole('button', { name: '新建任务', exact: true }).first().click();
  await page.locator('#task-title').fill('左右面板对齐测试');
  await page.locator('.workspace-picker').click();
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await page.getByRole('button', { name: '打开工作侧栏', exact: true }).click();
  await page.locator('.workbench-chrome').waitFor();
  await page.getByRole('button', { name: '打开内容', exact: true }).click();
  await page.getByRole('menuitem', { name: '侧边聊天', exact: true }).click();
  await page.locator('.side-chat-heading').waitFor();
  await page.getByRole('button', { name: '普通聊天', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.side-chat-modes button')?.disabled);
  const draft = page.getByRole('textbox', { name: '侧聊输入', exact: true });
  await draft.fill('仅测试布局，不发送模型请求');
  const layout = () => page.evaluate(() => {
    const read = selector => {
      const element = document.querySelector(selector), bounds = element.getBoundingClientRect(), css = getComputedStyle(element);
      return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height, bg: css.backgroundColor, border: css.borderBottomColor };
    };
    return {
      title: read('.titlebar'), project: read('.sidebar'), main: read('.thread'),
      heading: read('.thread-header'), navigation: read('.thread-view-tabs'),
      shell: read('.workbench-shell'), body: read('.workbench-body'), chrome: read('.workbench-chrome'), modes: read('.side-chat-heading'),
      side: read('.side-chat'), resize: read('.workbench-resizer'),
    };
  });
  const checkAlignment = async theme => {
    const result = await layout();
    if (baseline) {
      assert.notEqual(result.heading.bottom, result.chrome.bottom);
      assert.notEqual(result.navigation.bottom, result.modes.bottom);
      if (theme === 'light') assert.notEqual(result.chrome.bg, result.main.bg);
    } else {
      assert.equal(result.heading.height, 64);
      assert.equal(result.chrome.height, 64);
      assert.equal(result.navigation.height, 44);
      assert.equal(result.modes.height, 44);
      assert.ok(Math.abs(result.heading.bottom - result.chrome.bottom) < 1, 'First divider aligns across the split');
      assert.ok(Math.abs(result.navigation.bottom - result.modes.bottom) < 1, 'Second divider aligns across the split');
      assert.equal(result.heading.border, result.chrome.border);
      assert.equal(result.navigation.border, result.modes.border);
      for (const pane of ['heading', 'navigation', 'shell', 'body', 'chrome', 'modes', 'side']) assert.equal(result[pane].bg, result.main.bg, `${theme}: ${pane} uses the main surface`);
      assert.ok(Math.abs(result.heading.right - result.chrome.x) <= 1, 'No gray gutter separates the panels');
      assert.equal(result.resize.width, 10, 'The drag target remains easy to hit');
      if (theme === 'light') {
        assert.equal(result.main.bg, 'rgb(255, 255, 255)');
        assert.equal(result.project.bg, result.main.bg);
        assert.notEqual(result.title.bg, result.main.bg, 'Only the global titlebar remains subtly gray');
      }
    }
    console.log(`${baseline ? 'BASELINE' : 'PASS'} ${theme}: header dividers ${result.heading.bottom}/${result.chrome.bottom}; navigation dividers ${result.navigation.bottom}/${result.modes.bottom}; main ${result.main.bg}; side header ${result.chrome.bg}.`);
  };
  await mkdir('.tmp/qa', { recursive: true });
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) {
      await page.locator('.theme-toggle').click();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    }
    await checkAlignment(theme);
    await page.getByRole('button', { name: '普通聊天', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.side-chat-modes button[aria-pressed="true"]')?.textContent === '普通聊天');
    await page.getByRole('button', { name: '关联当前任务', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.side-chat-modes button[aria-pressed="true"]')?.textContent === '当前任务');
    assert.equal(await draft.inputValue(), '仅测试布局，不发送模型请求');
    await page.screenshot({ path: `.tmp/qa/pane-alignment-${baseline ? 'baseline-' : production ? 'production-' : ''}${theme}.png` });
  }
  if (!baseline) {
    const separator = page.getByRole('separator', { name: '调整侧栏宽度' });
    const originalWidth = Number(await separator.getAttribute('aria-valuenow'));
    await separator.focus(); await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(width => Number(document.querySelector('.workbench-resizer').getAttribute('aria-valuenow')) > width, originalWidth);
    const box = await separator.boundingBox();
    const beforeDrag = Number(await separator.getAttribute('aria-valuenow'));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
    assert.ok(Number(await separator.getAttribute('aria-valuenow')) > beforeDrag, 'Pointer dragging resizes the sidebar');
    await checkAlignment('dark');
    await page.getByRole('button', { name: '查看任务状态', exact: true }).click();
    await page.getByRole('dialog', { name: '任务状态', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '任务状态', exact: true }).waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
    assert.equal(await page.locator('.workbench-shell').count(), 0);
    await page.getByRole('button', { name: '打开工作侧栏', exact: true }).click();
    await page.locator('.side-chat-heading').waitFor();
    await page.setViewportSize({ width: 1000, height: 650 });
    await page.waitForTimeout(150);
    await checkAlignment('dark');
    const fits = await page.locator('.side-chat-heading').evaluate(el => [...el.children].every(child => child.getBoundingClientRect().right <= el.getBoundingClientRect().right));
    assert.equal(fits, true, 'Controls fit at compact desktop widths');
    assert.equal(await draft.inputValue(), '仅测试布局，不发送模型请求');
    assert.equal(await page.evaluate(() => window.paneCalls.some(call => call.action === 'send')), false, 'Layout checks never send a model request');
  }
  if (!baseline) {
    await page.setViewportSize({ width: 1500, height: 850 });
    const openContent = async name => {
      await page.getByRole('button', { name: '打开内容', exact: true }).click();
      await page.getByRole('menuitem', { name, exact: true }).click();
    };
    const checkToolbar = async (kind, selector, theme) => {
      await page.locator(selector).waitFor();
      const row = await page.locator(selector).evaluate(el => {
        const css = getComputedStyle(el), main = document.querySelector('.thread-view-tabs'), bounds = el.getBoundingClientRect();
        return { height: bounds.height, bottom: bounds.bottom, expected: main.getBoundingClientRect().bottom, border: css.borderBottomColor, expectedBorder: getComputedStyle(main).borderBottomColor };
      });
      if (toolbarBaseline) assert.notEqual(row.bottom, row.expected, `${kind}: reproduce the second-divider mismatch`);
      else {
        assert.equal(row.height, 44, `${kind}: standard toolbar height`);
        assert.ok(Math.abs(row.bottom - row.expected) < 1, `${kind}: second divider aligns (${row.bottom}/${row.expected})`);
        assert.equal(row.border, row.expectedBorder, `${kind}: shared divider color`);
      }
      console.log(`${toolbarBaseline ? 'BASELINE' : 'PASS'} ${theme} ${kind}: second dividers ${row.bottom}/${row.expected}, height ${row.height}px.`);
      await page.screenshot({ path: `.tmp/qa/pane-${kind}-${toolbarBaseline ? 'baseline-' : production ? 'production-' : ''}${theme}.png` });
    };
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) {
        await page.locator('.theme-toggle').click();
        await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      }
      await openContent('Browser');
      await checkToolbar('browser', '.workbench-body > .workbench-file > .workbench-toolbar', theme);
      await page.locator('.workbench-body button[title="刷新"]').click();
      await openContent('终端');
      await page.locator('.xterm').waitFor();
      await checkToolbar('terminal', '.terminal-toolbar', theme);
      await page.getByRole('button', { name: '搜索终端', exact: true }).click();
      await page.getByRole('textbox', { name: '搜索终端输出', exact: true }).press('Escape');
      await checkToolbar('terminal', '.terminal-toolbar', theme);
      await page.getByRole('button', { name: '终端菜单', exact: true }).click();
      const menuBox = await page.locator('.terminal-menu').boundingBox();
      const toolbarBox = await page.locator('.terminal-toolbar').boundingBox();
      if (!toolbarBaseline) assert.ok(menuBox.y >= toolbarBox.y + toolbarBox.height, 'Terminal menu opens below its toolbar');
      await page.keyboard.press('Escape');
      await openContent('文件');
      await checkToolbar('files', '.workbench-body > .workbench-file > .workbench-toolbar', theme);
      await page.getByRole('textbox', { name: '工作区文件搜索', exact: true }).fill('fixture');
      await page.getByRole('button', { name: 'fixture.js', exact: true }).dblclick();
      await checkToolbar('file-preview', '.document-toolbar', theme);
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      await page.getByRole('textbox', { name: '代码编辑器', exact: true }).waitFor();
      await checkToolbar('file-preview', '.document-toolbar', theme);
      await openContent('Git');
      await page.getByText('工作区干净，没有待提交改动。', { exact: true }).waitFor();
      await checkToolbar('git', '.git-heading', theme);
      await page.getByRole('button', { name: '刷新 Git', exact: true }).click();
    }
    if (!toolbarBaseline) {
      await page.setViewportSize({ width: 1000, height: 650 });
      await page.waitForTimeout(150);
      await checkToolbar('git', '.git-heading', 'dark-compact');
      await page.getByRole('tab').filter({ hasText: 'fixture.js' }).click();
      await checkToolbar('file-preview', '.document-toolbar', 'dark-compact');
      await page.getByRole('tab').filter({ hasText: 'about:blank' }).first().click();
      await checkToolbar('browser', '.workbench-body > .workbench-file > .workbench-toolbar', 'dark-compact');
      await page.getByRole('tab').filter({ hasText: 'Terminal' }).first().click();
      await checkToolbar('terminal', '.terminal-toolbar', 'dark-compact');
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS: mode switches and draft retention; no uncaught browser errors.');
} finally { await browser.close(); await server.close(); }
