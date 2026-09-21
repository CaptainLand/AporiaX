import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
const server = await preview({ preview: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'route-app', view: 'route', welcomeDismissed: true }));
    window.routeCalls = [];
    const task = { id: 'route-app', title: '执行记录集成测试', workspacePath: 'D:/Fixture', workspaceName: '示例工作区', providerId: 'own', modelId: 'own-model', effort: 'high', messages: [{ id: 'assistant', role: 'assistant', prompt: '制作账户页面', status: 'completed', content: '已交付', selfCheck: { delivery: { status: 'unverified' } }, witness: { status: 'completed', records: [
      { id: 'r1', kind: 'tool', eventType: 'tool.completed', tool: 'write_file', path: 'index.html', status: 'completed', detail: '页面已保存', startedAt: '2026-09-21T08:00:00Z', completedAt: '2026-09-21T08:00:02Z', elapsedMs: 2000 },
      { id: 'r2', kind: 'tool', eventType: 'tool.completed', tool: 'run_command', command: 'npm test', status: 'failed', detail: '测试环境不可用', error: 'ENOENT', exitCode: 1, startedAt: '2026-09-21T08:00:03Z', completedAt: '2026-09-21T08:00:05Z', elapsedMs: 2000 },
    ] } }], createdAt: new Date().toISOString() };
    window.desktop = {
      theme: { set: async () => {} }, account: { get: async () => ({ status: 'anonymous' }) },
      providers: { list: async () => [{ id: 'own', name: '自己的 API', models: [{ id: 'own-model', name: 'Own model' }] }] },
      tasks: { load: async () => [task], save: async () => {} }, harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
      sandbox: { status: async () => ({ localAvailable: true }) },
      workspace: { listTree: async () => ({ entries: [] }), readPreview: async () => ({ path: 'index.html', content: '<h1>Account</h1>', binary: false }) },
      understanding: { projects: async () => [], get: async () => ({ facts: [], revisions: [], settings: {} }) },
      workbench: { subscribe: () => () => {}, request: async (input) => { window.routeCalls.push(input); if (input.action === 'list') return []; if (input.action === 'file-check') return { status: 'present' }; return true; } },
    };
  });
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'domcontentloaded' });
  await page.locator('.ax-welcome__enter, .thread-view-tabs').first().waitFor({ timeout: 30000 });
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  const routeTab = page.locator('.thread-view-tabs').getByRole('button', { name: '执行记录', exact: true });
  await routeTab.click();
  const route = page.locator('.thread-view-panel.route-panel.active');
  await route.locator('.ra-state').filter({ hasText: '已交付 · 未验证' }).waitFor();
  assert.equal(await route.locator('.ra-event').count(), 2);
  assert.equal(await route.locator('.ra-event').first().getAttribute('data-record-id'), 'r2', 'Production view shows newest records first');
  assert.equal(await route.getByText('ENOENT', { exact: true }).isVisible(), true);
  await mkdir('.tmp/route-activity', { recursive: true });
  await page.screenshot({ path: '.tmp/route-activity/app-production.png' });
  await route.locator('.ra-event.failed button').click();
  await page.locator('dialog[open]').getByText('退出码', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await routeTab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '在侧栏打开', exact: true }).click();
  const side = page.locator('.workbench-panel');
  await side.locator('.route-activity').waitFor();
  await side.locator('.ra-event.completed button').click();
  await page.locator('dialog[open]').getByText('页面已保存', { exact: true }).waitFor();
  await page.locator('dialog[open]').getByRole('button', { name: '在侧栏打开文件', exact: true }).click();
  await side.locator('.workbench-code').waitFor();
  assert.ok(await page.evaluate(() => window.routeCalls.some((call) => call.action === 'file-check' && call.path === 'index.html')));
  await page.locator('.thread-view-tabs').getByRole('button', { name: '对话', exact: true }).click();
  await page.locator('.dialogue-panel.active').waitFor();
  assert.deepEqual(errors, []);
  console.log('Route activity production app: PASS (strict CSP, main/sidebar, outcome, details, validated file link, adjacent dialogue).');
} finally { await browser?.close(); await new Promise((resolve) => server.httpServer.close(resolve)); }
