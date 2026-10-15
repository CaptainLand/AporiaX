import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { defaultRoleSettings } from '../shared/professional-roles.js';
import { themeTokens } from '../shared/appearance.js';
const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(roles => {
    localStorage.clear(); localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.theme.v2', new URLSearchParams(location.search).get('theme') || 'light');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'role-entry', welcomeDismissed: true }));
    const task = { id: 'role-entry', title: '演示任务', workspacePath: 'D:/Fixture', workspaceName: '演示工作区', providerId: 'own', modelId: 'fixture', messages: [] };
    window.roleCalls = [];
    window.desktop = {
      theme: { set: async () => {} }, account: { get: async () => ({ status: 'anonymous' }) },
      providers: { list: async () => [{ id: 'own', name: 'Fixture', models: [{ id: 'fixture', name: 'Fixture' }] }] },
      tasks: { load: async () => location.search.includes('empty') ? [] : [task], save: async () => {} },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [], run: async () => { window.roleCalls.push('run'); } },
      agentProfiles: { get: async () => structuredClone(roles), save: async value => { window.roleCalls.push('save'); return value; } },
      sandbox: { status: async () => ({ localAvailable: true }) },
      workspace: { listTree: async () => ({ entries: [] }) },
      core: { skills: async () => ({ skills: [] }), capabilities: async () => ({ capabilities: [] }) },
      workbench: { subscribe: () => () => {}, request: async input => input.action === 'list' ? [] : true },
    };
  }, defaultRoleSettings());
  const open = async () => {
    await page.getByRole('button', { name: '打开 AporiaX 设置', exact: true }).click();
    await page.getByRole('button', { name: '专业角色', exact: true }).click();
    await page.locator('.pr-gallery').waitFor();
  };
  for (const theme of ['light', 'dark', 'custom']) {
    await page.goto(server.resolvedUrls.local[0] + '?theme=' + (theme === 'custom' ? 'dark' : theme));
    if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
    if (theme === 'custom') await page.evaluate(tokens => {
      document.documentElement.dataset.customTheme = 'role-preview';
      for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
    }, themeTokens({ base: 'dark', colors: { accent: '#31c48d', background: '#0a1410', panel: '#12201a', text: '#e6f2e8' } }));
    const composer = page.getByRole('textbox', { name: '任务输入', exact: true });
    await composer.fill('保留我的草稿');
    await open();
    assert.equal(await page.locator('.pr-editor').count(), 0);
    assert.equal(await page.getByRole('textbox', { name: '角色指令', exact: true }).isVisible(), false);
    assert.equal(await page.locator('.pr-robot').count(), 5);
    await page.getByRole('button', { name: '探奇', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '删除角色', exact: true }).count(), 0);
    assert.equal(await page.locator('.pr-advanced').getAttribute('open'), null);
    await page.getByRole('button', { name: '收起角色编辑', exact: true }).click();
    await mkdir('.tmp/qa', { recursive: true });
    await page.screenshot({ path: '.tmp/qa/roles-simple-' + theme + '.png' });
    await page.getByRole('button', { name: '让 AI 设计', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === '保留我的草稿\n@新建专业角色 ');
    assert.equal(await composer.evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('.application-settings-modal').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.roleCalls), []);
    await open();
    await page.getByRole('button', { name: '让 AI 设计', exact: true }).click();
    assert.equal(await composer.inputValue(), '保留我的草稿\n@新建专业角色 ');
    await open();
    await page.getByRole('button', { name: '手动添加', exact: true }).click();
    await page.getByRole('textbox', { name: '名称', exact: true }).fill('未保存角色');
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: '让 AI 设计', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '名称', exact: true }).inputValue(), '未保存角色');
    assert.equal(await page.locator('.application-settings-modal').count(), 1);
    await page.setViewportSize({ width: 680, height: 850 });
    assert.equal(await page.locator('.professional-roles').evaluate(el => el.scrollWidth > el.clientWidth), false);
    assert.equal(await page.locator('.pr-gallery').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.goto(server.resolvedUrls.local[0] + '?empty=1');
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await open();
  assert.equal(await page.getByRole('button', { name: '让 AI 设计', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '手动添加', exact: true }).isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS role creation entry: draft, focus, deduplication, unsaved-change cancellation, disabled empty-task state, themes and compact layout; no model or role writes.');
} finally { await browser.close(); await server.httpServer.close(); }
