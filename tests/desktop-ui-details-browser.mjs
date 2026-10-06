import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';

const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1450, height: 850 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.theme.v2', 'light');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'details', welcomeDismissed: true }));
    window.uiCalls = []; window.prFixture = 'normal'; window.copiedSelection = '';
    Object.defineProperty(navigator.clipboard, 'writeText', { value: async text => { if (window.copyFailure) throw new Error('fixture'); window.copiedSelection = text; } });
    const task = { id: 'details', title: '界面细节测试', workspacePath: 'D:/Fixture', workspaceName: 'Fixture', providerId: 'own', modelId: 'test', builderLimit: 2, createdAt: new Date().toISOString(), messages: [{ id: 'answer', role: 'assistant', status: 'completed', content: '这段对话用于引用测试。\n\n[测试链接](https://example.invalid/)\n\n第二段内容。' }] };
    const state = { repository: true, root: 'D:/Fixture', branch: 'main', files: [], remotes: ['origin'], revision: 'fixture', head: 'fixture', ahead: 0, behind: 0 };
    window.desktop = {
      theme: { set: async () => {} },
      providers: { list: async () => [{ id: 'own', name: 'Test', models: [{ id: 'test', name: 'Test' }] }] },
      account: { get: async () => ({ status: 'anonymous' }) },
      tasks: { load: async () => [task], save: async () => {} },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
      sandbox: { status: async () => ({ localAvailable: true }) },
      workspace: {
        listTree: async () => ({ entries: [{ path: 'fixture.js', name: 'fixture.js', type: 'file' }] }),
        readPreview: async () => ({ path: 'fixture.js', content: 'const fixture = true;' }),
      },
      links: { activate: async input => { window.uiCalls.push(input); return { ok: true }; } },
      workbench: { subscribe: () => () => {}, request: async input => {
        window.uiCalls.push(input);
        if (input.action === 'list') return [];
        if (input.action === 'git') {
          if (input.operation === 'pull-requests') {
            await new Promise(resolve => setTimeout(resolve, 120));
            if (window.prFixture === 'error') throw new Error('GitHub 尚未登录或授权已失效，请在仓库设置中登录。');
            return { repository: 'test/fixture', branch: 'main', items: window.prFixture === 'empty' ? [] : [
              { number: 10, title: '完善工作区和对话引用', state: 'OPEN', updatedAt: '2026-10-06T00:00:00Z', url: 'https://github.com/test/fixture/pull/10', checks: [{ name: 'Windows', status: 'FAILURE' }, { name: 'Linux', status: 'SUCCESS' }, { name: 'Build', status: 'IN_PROGRESS' }] },
              { number: 11, title: '草稿测试', state: 'OPEN', isDraft: true, checks: [] },
              { number: 12, title: '已合并测试', state: 'MERGED', checks: [] },
            ] };
          }
          return { ...state, remotes: window.noRemote ? [] : ['origin'] };
        }
        if (input.action === 'new-browser') return { ...input, id: 'browser-fixture', kind: 'browser', title: input.url, url: input.url, owner: 'user' };
        return true;
      } },
      sideChat: { subscribe: () => () => {}, request: async input => { window.uiCalls.push(input); return { messages: [{ id: 'side-answer', role: 'assistant', content: '侧聊选中文字', status: 'completed', createdAt: new Date().toISOString() }] }; } },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.locator('.assistant-message-content').waitFor();
  const composer = page.locator('.composer textarea');
  await composer.fill('保留已有草稿');
  const select = async selector => page.locator(selector).evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: innerWidth - 5, clientY: innerHeight - 5 }));
  });
  const text = '.assistant-message-content p:first-child';
  await select(text);
  const menu = page.getByRole('menu', { name: '选中文字操作' });
  await menu.waitFor();
  const bounds = await menu.boundingBox();
  assert.ok(bounds.x + bounds.width <= 1450 && bounds.y + bounds.height <= 850, 'Menu stays on screen');
  await page.getByRole('menuitem', { name: '添加到对话', exact: true }).click();
  await page.waitForFunction(expected => {
    const input = document.querySelector('.composer textarea');
    return input?.value === expected && document.activeElement === input;
  }, '保留已有草稿\n\n> 这段对话用于引用测试。\n\n');
  assert.equal(await composer.inputValue(), '保留已有草稿\n\n> 这段对话用于引用测试。\n\n');
  assert.equal(await composer.evaluate(el => el === document.activeElement), true);
  await select(text); await page.getByRole('menuitem', { name: '复制选中文字' }).click();
  await page.waitForFunction(() => window.copiedSelection === '这段对话用于引用测试。');
  assert.equal(await page.evaluate(() => window.copiedSelection), '这段对话用于引用测试。');
  await select(text); await page.keyboard.press('Escape'); assert.equal(await menu.count(), 0);
  await select(text); await page.locator('.thread-header').click(); assert.equal(await menu.count(), 0);
  await page.evaluate(() => window.copyFailure = true);
  await select(text); await page.getByRole('menuitem', { name: '复制选中文字' }).click();
  await menu.getByRole('alert').waitFor(); await page.keyboard.press('Escape');
  await page.evaluate(() => { window.copyFailure = false; window.getSelection().removeAllRanges(); });
  await page.locator(text).dispatchEvent('contextmenu'); assert.equal(await menu.count(), 0);
  await select('.assistant-message-content a');
  assert.equal(await page.evaluate(() => window.uiCalls.some(call => call.action === 'menu')), false, 'Selection overrides link menu, not both');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.getByRole('menuitem', { name: '复制选中文字' }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.locator('.assistant-message-content a').dispatchEvent('contextmenu');
  await page.waitForFunction(() => window.uiCalls.some(call => call.action === 'menu'));
  assert.equal(await menu.count(), 0, 'Unselected links keep their original menu');
  await select(text); await page.keyboard.press('Escape');
  await composer.dispatchEvent('contextmenu');
  assert.equal(await menu.count(), 0, 'Composer keeps native edit menu even with a stale conversation selection');
  console.log('PASS main conversation: selected text quoted into existing draft, clipboard/error, link handling, keyboard/outside dismissal, bounded menu; no send.');
  await page.getByRole('button', { name: '打开工作侧栏', exact: true }).click();
  await page.getByRole('button', { name: '打开内容', exact: true }).click();
  await page.getByRole('menuitem', { name: '侧边聊天', exact: true }).click();
  await page.locator('.side-chat-message.assistant p').waitFor();
  const sideDraft = page.getByRole('textbox', { name: '侧聊输入' });
  await sideDraft.fill('侧聊草稿'); await select('.side-chat-message.assistant p');
  await page.getByRole('menuitem', { name: '添加到对话', exact: true }).click();
  await page.waitForFunction(expected =>
    document.querySelector('.side-chat-composer textarea')?.value === expected,
  '侧聊草稿\n\n> 侧聊选中文字\n\n');
  assert.equal(await sideDraft.inputValue(), '侧聊草稿\n\n> 侧聊选中文字\n\n');
  assert.match(await composer.inputValue(), /^保留已有草稿/);
  await page.getByRole('button', { name: '打开内容', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Git', exact: true }).click();
  await page.getByText('工作区干净，没有待提交改动。', { exact: true }).waitFor();
  assert.match(await page.locator('.git-commit').innerText(), /不是给 AI 的任务指令/);
  await page.getByRole('button', { name: 'PR', exact: true }).click();
  await page.locator('.git-pr-card').first().waitFor();
  assert.equal(await page.locator('.git-pr-card').count(), 3);
  assert.equal(await page.locator('.git-pr-check.failed').count(), 1);
  assert.equal(await page.locator('.git-pr-check.passed').count(), 1);
  assert.equal(await page.locator('.git-pr-check.pending').count(), 1);
  await mkdir('.tmp/qa', { recursive: true });
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.theme-toggle').click();
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    await page.locator('.workbench-git').screenshot({ path: `.tmp/qa/git-pr-details-${theme}.png` });
    await page.getByRole('button', { name: '工作区', exact: true }).click();
    await page.locator('.workspace-panel.active .workspace-tree button').first().click();
    await page.locator('.workspace-rich-preview').waitFor();
    const surfaces = await page.evaluate(() => {
      const selectors = ['.thread', '.workspace-panel.active .file-explorer-panel', '.workspace-panel.active .workspace-tree', '.workspace-rich-preview', '.workspace-inline-toolbar', '.workspace-rich-preview .workbench-code'];
      return selectors.map(selector => [selector, getComputedStyle(document.querySelector(selector)).backgroundColor]);
    });
    for (const [selector, color] of surfaces) assert.equal(color, surfaces[0][1], `${theme}: ${selector} shares main work surface`);
    await page.locator('.workspace-panel.active').screenshot({ path: `.tmp/qa/workspace-details-${theme}.png` });
    await page.getByRole('button', { name: '对话', exact: true }).click();
    await select(text); await menu.waitFor(); await page.screenshot({ path: `.tmp/qa/selection-details-${theme}.png` }); await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1000, height: 650 });
  const git = page.locator('.workbench-git');
  assert.equal(await git.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'PR fits narrow pane');
  for (const mode of ['empty', 'error', 'normal']) {
    await page.evaluate(mode => window.prFixture = mode, mode);
    await page.getByRole('button', { name: '刷新 PR', exact: true }).click();
    if (mode === 'empty') await page.getByText('当前分支没有 PR', { exact: true }).waitFor();
    if (mode === 'error') { await git.getByRole('alert').waitFor(); assert.equal(await git.getByRole('button', { name: '重新读取' }).isVisible(), true); }
    if (mode === 'normal') await page.locator('.git-pr-card').first().waitFor();
  }
  await page.evaluate(() => window.noRemote = true);
  await page.getByRole('button', { name: '刷新 Git', exact: true }).click();
  await page.getByText('先连接远程仓库', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '刷新 PR', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.noRemote = false);
  await page.getByRole('button', { name: '刷新 Git', exact: true }).click();
  await page.locator('.git-pr-card').first().waitFor();
  await page.getByRole('button', { name: '打开 PR 详情' }).click();
  await page.waitForFunction(() => window.uiCalls.some(call => call.action === 'navigate'));
  assert.equal(await page.evaluate(() => window.uiCalls.find(call => call.action === 'navigate')?.url), 'https://github.com/test/fixture/pull/10');
  assert.equal(await page.evaluate(() => window.uiCalls.some(call => ['send', 'commit', 'push', 'pull', 'merge'].includes(call.operation || call.action))), false);
  assert.deepEqual(errors, []);
  console.log('PASS side-chat quote/draft isolation; Git commit help; PR states/checks/refresh/empty/error/retry/open/narrow/dark; workspace surfaces; no model or Git mutation; zero page errors.');
} finally { await browser.close(); await server.httpServer.close(); }
