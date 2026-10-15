import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.theme.v2', new URLSearchParams(location.search).get('theme') || 'light');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'permissions', welcomeDismissed: true }));
    const task = { id: 'permissions', title: '演示任务', workspaceName: '演示工作区', workspacePath: 'D:/Fixture', providerId: 'own', modelId: 'test', approvalMode: 'manual', executionMode: 'safe', createdAt: new Date().toISOString(), messages: [] };
    window.savedTasks = []; window.permissionCalls = []; let enabled = false;
    window.desktop = {
      theme: { set: async () => {} }, account: { get: async () => ({ status: 'anonymous' }) },
      providers: { list: async () => [{ id: 'own', name: 'Fixture', models: [{ id: 'test', name: 'Fixture model' }] }] },
      tasks: { load: async () => location.search.includes('empty') ? [] : [task], save: async tasks => { window.savedTasks = tasks; } },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
      workspace: { listTree: async () => ({ entries: [] }) },
      workbench: { subscribe: () => () => {}, request: async input => input.action === 'list' ? [] : true },
      sandbox: { status: async () => ({ available: false, localAvailable: true }), prepare: async () => { window.permissionCalls.push('prepare'); return { available: true }; }, openRecovery: async () => { window.permissionCalls.push('recovery'); } },
      control: { subscribe: () => () => {}, request: async request => {
        window.permissionCalls.push(request);
        if (request.action === 'getFileAccess') return { enabled };
        if (request.action === 'setFileAccess') { enabled = request.input.enabled; return { enabled }; }
        throw new Error('Unexpected operation');
      } },
    };
  });
  const open = async () => {
    await page.getByRole('button', { name: '打开 AporiaX 设置', exact: true }).click();
    await page.getByRole('button', { name: '权限与审批', exact: true }).click();
  };
  for (const theme of ['light', 'dark']) {
    await page.goto(server.resolvedUrls.local[0] + '?theme=' + theme);
    if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
    await page.locator('.thread-header').waitFor();
    assert.equal(await page.getByRole('button', { name: '打开任务设置', exact: true }).count(), 0);
    await page.getByRole('button', { name: '更多操作', exact: true }).click();
    assert.equal(await page.getByRole('menuitem', { name: '任务设置', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await open();
    assert.equal(await page.locator('#permission-approval [aria-pressed="true"]').textContent(), '逐次确认');
    assert.equal(await page.locator('#permission-execution [aria-pressed="true"]').textContent(), '安全副本');
    await page.locator('#permission-approval').getByRole('button', { name: '智能确认', exact: true }).click();
    await page.locator('#permission-execution').getByRole('button', { name: '隔离', exact: true }).click();
    await page.waitForFunction(() => window.savedTasks.some(task => task.id === 'permissions' && task.approvalMode === 'smart-auto' && task.executionMode === 'isolated'));
    assert.equal(await page.evaluate(() => window.permissionCalls.filter(c => c.action !== 'getFileAccess').length), 0, 'Changing execution only reads permission status, never prepares Docker or calls models');
    await page.getByRole('button', { name: '准备隔离环境', exact: true }).click();
    await page.getByText('Docker 已就绪', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await open();
    assert.equal(await page.locator('#permission-approval [aria-pressed="true"]').textContent(), '智能确认');
    assert.equal(await page.locator('#permission-execution [aria-pressed="true"]').textContent(), '隔离');
    const toggle = page.getByRole('switch', { name: '允许访问工作区外文件', exact: true });
    await toggle.click();
    assert.equal(await page.evaluate(() => window.permissionCalls.filter(c => c.action === 'setFileAccess').length), 0);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await toggle.click();
    await page.getByRole('button', { name: '我了解风险，开启全局权限', exact: true }).click();
    await page.waitForFunction(() => window.permissionCalls.some(c => c.action === 'setFileAccess' && c.input.enabled && c.input.riskAcknowledged));
    await page.waitForFunction(() => document.querySelector('.permission-file-access [role="switch"]')?.getAttribute('aria-checked') === 'true');
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('.permission-file-access [role="switch"]')?.getAttribute('aria-checked') === 'false');
    assert.ok(await page.evaluate(() => window.permissionCalls.some(c => c.action === 'setFileAccess' && c.input.enabled === false)));
    await page.locator('.permissions-settings').getByRole('button', { name: '打开', exact: true }).click();
    assert.ok(await page.evaluate(() => window.permissionCalls.includes('recovery')));
    assert.equal(await page.locator('.settings-panel').count(), 0);
    await mkdir('.tmp/qa', { recursive: true });
    await page.screenshot({ path: '.tmp/qa/permissions-settings-' + theme + '.png' });
    console.log('PASS ' + theme + ': hidden sidebar, three-choice buttons persist, explicit Docker preparation, inline switch confirms/cancels/enables/disables, recovery folder.');
  }
  await page.goto(server.resolvedUrls.local[0] + '?empty=1');
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await open();
  assert.equal(await page.locator('#permission-approval button:disabled').count(), 3);
  assert.equal(await page.locator('#permission-execution button:disabled').count(), 3);
  await page.waitForFunction(() => document.querySelector('.permission-file-access [role="switch"]')?.disabled === false);
  assert.deepEqual(errors, []);
  console.log('PASS no-task state; no real data, permissions, models or Docker operations used.');
} finally { await browser.close(); await server.httpServer.close(); }
