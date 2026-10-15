import assert from 'node:assert/strict';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
let browser;
try {
  const base = server.resolvedUrls.local[0];
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  for (const theme of ['light', 'dark']) for (const status of ['completed', 'partial', 'blocked', 'needs_input', 'failed', 'empty', 'runtime-blocked']) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await context.addInitScript(({ theme, status }) => {
      localStorage.clear(); localStorage.setItem('aporiax.language.v1', 'zh-CN'); localStorage.setItem('aporiax.theme.v2', theme);
      localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ welcomeDismissed: true, taskId: 'delivery-demo' }));
      const task = { id: 'delivery-demo', title: '交付结果演示', workspaceName: '演示工作区', workspacePath: 'D:/Demo/Starlight', providerId: 'own', modelId: 'own-model', messages: [] };
      window.resultQA = { calls: 0, saved: [], notifications: [] };
      window.desktop = {
        theme: { set: async () => {} }, account: { get: async () => ({ status: 'anonymous' }) },
        providers: { list: async () => [{ id: 'own', name: '演示 API', baseUrl: 'https://example.invalid/v1', hasApiKey: true, models: [{ id: 'own-model', name: '演示模型', supportsTools: true }] }] },
        tasks: { load: async () => [task], save: async tasks => { window.resultQA.saved = tasks; } },
        notifications: { taskCompleted: async input => { window.resultQA.notifications.push(input); } },
        harness: { onEvent: () => () => {}, recoverableRuns: async () => [], run: async () => {
          window.resultQA.calls++;
          const outcome = ['empty'].includes(status) ? 'completed' : status === 'runtime-blocked' ? 'blocked' : status;
          return { status: outcome, replyDelivered: status !== 'empty' && status !== 'runtime-blocked' && status !== 'failed', error: status === 'failed', content: status === 'empty' ? '' : status === 'failed' ? 'Provider unavailable' : status === 'runtime-blocked' ? 'Context budget exceeded' : '已整理演示结果。\n\n未完成说明：所需外部材料尚未提供，剩余部分需要材料后才能继续。',
            selfCheck: { delivery: { status: 'unverified' } }, witness: { status: outcome, records: [{ id: 'demo-record', kind: 'tool', tool: 'read_file', path: 'demo.md', status: 'completed', detail: '已读取演示资料', elapsedMs: 10 }] }, changes: [], steps: [] };
        } },
        sandbox: { status: async () => ({ localAvailable: true }) },
        workbench: { subscribe: () => () => {}, request: async ({ action }) => action === 'list' ? [] : true },
        sideChat: { subscribe: () => () => {}, request: async () => ({ messages: [] }) },
      };
    }, { theme, status });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('.ax-welcome__enter, .thread-view-tabs').first().waitFor();
    if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
    await page.getByRole('textbox', { name: '任务输入', exact: true }).fill('请整理演示资料。');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => window.resultQA.calls === 1);
    await page.getByRole('button', { name: '停止当前任务', exact: true }).waitFor({ state: 'hidden' });
    const normal = ['completed', 'partial', 'blocked', 'needs_input'].includes(status);
    if (normal) {
      assert.equal(await page.locator('.assistant-message-heading strong').last().innerText(), 'AporiaX');
      await page.locator('.assistant-message-content').getByText(/未完成说明/).waitFor();
      assert.equal(await page.locator('.witness-current > span').innerText(), '已完成');
      assert.equal(await page.locator('.toast').count(), 0, 'No automatic unfinished/partial/blocked warning');
    }
    if (status === 'failed') await page.locator('.toast').filter({ hasText: '运行失败' }).waitFor();
    await page.locator('.thread-view-tabs').getByRole('button', { name: '执行记录', exact: true }).click();
    await page.locator('.route-activity').waitFor();
    const state = page.locator('.ra-stat-state');
    assert.equal(await state.count(), normal ? 1 : 0, 'Only a normal final reply has a visible task-status card');
    if (normal) {
      assert.equal(await state.locator('.ra-state').innerText(), '已完成');
      assert.equal(await state.locator('.ra-state-caption').count(), 0);
      assert.equal(await state.getByText(/未验证|部分完成|受阻|等待补充信息/).count(), 0);
    }
    await page.waitForFunction(() => window.resultQA.saved.some(t => t.messages.some(m => m.role === 'assistant' && m.status !== 'running')));
    const saved = await page.evaluate(() => window.resultQA.saved[0].messages.findLast(m => m.role === 'assistant'));
    assert.equal(saved.status, status === 'empty' ? 'completed' : status === 'runtime-blocked' ? 'blocked' : status, 'Raw outcome retained');
    assert.equal(saved.selfCheck.delivery.status, 'unverified', 'UI completion must not turn verification into a pass');
    assert.equal(await page.evaluate(() => window.resultQA.notifications.length), status === 'completed' ? 1 : 0);
    if (status === 'partial') {
      await page.getByRole('button', { name: '打开工作侧栏', exact: true }).click();
      await page.getByRole('button', { name: '打开内容', exact: true }).click();
      await page.getByRole('menuitem', { name: '侧边聊天', exact: true }).click();
      await page.locator('.side-chat').waitFor();
      assert.equal(await page.locator('.side-chat-status-trigger > span').last().innerText(), '已完成');
    }
    assert.deepEqual(errors, []);
    await context.close(); console.log(`PASS ${theme}/${status}: quiet reply-based status, raw evidence retained.`);
  }
} finally {
  await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve));
}
