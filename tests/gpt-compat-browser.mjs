import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, bypassCSP: true });
  page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.clear(); localStorage.setItem('aporiax.language.v1', 'zh-CN'); localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'gpt-ui', welcomeDismissed: true }));
    const state = window.gptFixture = { calls: [], listeners: [] };
    const provider = { id: 'own-gpt', name: 'Own GPT', source: 'user-provider', models: [{ id: 'gpt-6.1-sol', name: 'GPT fixture', shortName: 'GPT fixture', supportsThinking: true, supportsTools: true }] };
    const task = { id: 'gpt-ui', title: 'GPT 流式与档位测试', workspacePath: '', providerId: provider.id, modelId: 'gpt-6.1-sol', effort: 'xhigh', messages: [] };
    window.desktop = {
      theme: { set: async () => {} }, account: { get: async () => ({ status: 'anonymous' }) },
      providers: { list: async () => [provider] }, tasks: { load: async () => [task], save: async tasks => { state.tasks = tasks; } },
      sandbox: { status: async () => ({ localAvailable: true }) },
      workbench: { subscribe: () => () => {}, request: async input => input.action === 'list' ? [] : true },
      harness: { recoverableRuns: async () => [], onEvent: listener => { state.listeners.push(listener); return () => { state.listeners = state.listeners.filter(value => value !== listener); }; },
        run: async request => {
          state.calls.push(request);
          const emit = event => state.listeners.forEach(listener => listener({ ...event, runId: request.runId }));
          emit({ type: 'response.delta', delta: 'B' }); emit({ type: 'response.delta', delta: 'A' });
          emit({ type: 'response.text.reconciled', content: 'AB' });
          await new Promise(resolve => setTimeout(resolve, 120));
          return { content: 'AB', status: 'completed', steps: [], changes: [], route: [] };
        } },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  const trigger = page.getByRole('button', { name: '切换思考强度', exact: true });
  await trigger.waitFor(); assert.match(await trigger.innerText(), /XHIGH/i);
  await trigger.click();
  const slider = page.getByRole('slider', { name: '思考强度', exact: true });
  assert.equal(await slider.getAttribute('max'), '4', 'five real GPT-6.1 Sol levels');
  await slider.press('End'); assert.equal(await slider.getAttribute('aria-valuetext'), 'Max');
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: '任务输入', exact: true }).fill('hi');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => window.gptFixture.calls.length === 1 && document.querySelector('.assistant-message')?.textContent.includes('AB'));
  await page.waitForFunction(() => window.gptFixture.tasks?.[0]?.messages?.some(message => message.role === 'assistant' && message.status === 'completed'));
  const result = await page.evaluate(() => ({ request: { effort: window.gptFixture.calls[0].effort, providerId: window.gptFixture.calls[0].providerId },
    answer: window.gptFixture.tasks[0].messages.filter(message => message.role === 'assistant').at(-1), calls: window.gptFixture.calls.length }));
  assert.equal(result.request.effort, 'max'); assert.equal(result.request.providerId, 'own-gpt'); assert.equal(result.calls, 1);
  assert.equal(result.answer.content, 'AB');
  assert(!(result.answer.progressUpdates || []).some(update => update.content === 'BA'), 'display-order correction is not a new work phase');
  assert.deepEqual(errors, []);
  console.log('PASS browser: GPT has five real levels, Max is sent as max, buffered deltas reconcile without duplicate text/progress or another request. Mock model only.');
} finally { await browser.close(); await server.close(); }
