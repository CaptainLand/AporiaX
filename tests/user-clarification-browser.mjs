import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } }); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/user-clarification.html');
  await page.getByRole('heading', { name: '这份报告面向谁？' }).waitFor();
  const submit = page.getByRole('button', { name: '提交并继续' });
  assert.equal(await page.locator('input:checked').count(), 0, 'Recommended must not be selected automatically');
  assert.equal(await submit.isDisabled(), true);
  await page.getByRole('radio', { name: /内部团队/ }).check();
  assert.equal(await submit.isEnabled(), true);
  await mkdir('.tmp/user-clarification', { recursive: true });
  await page.screenshot({ path: '.tmp/user-clarification/card-light.png', fullPage: true });
  await submit.click();
  await page.locator('.clarification-answer').filter({ hasText: '内部团队' }).waitFor();
  assert.equal(await page.evaluate(() => window.clarificationFixture.calls.length), 1);
  await page.evaluate(() => window.clarificationFixture.reset());
  await page.getByRole('radio', { name: '自己填写' }).check();
  await page.getByRole('textbox', { name: '你的回答' }).fill('仅内部使用，不要发布。');
  await page.evaluate(() => { window.clarificationFixture.fail = true; });
  await submit.click(); await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('textbox').inputValue(), '仅内部使用，不要发布。');
  await page.evaluate(() => { window.clarificationFixture.fail = false; });
  await submit.click(); await page.locator('.clarification-answer').filter({ hasText: '仅内部使用，不要发布。' }).waitFor();
  await page.evaluate(() => window.clarificationFixture.reset({ options: [] }));
  assert.equal(await page.getByRole('radio').count(), 0);
  await page.getByRole('textbox').fill('   '); assert.equal(await submit.isDisabled(), true);
  await page.getByRole('textbox').fill('一个特别长的标题和详细要求。'.repeat(20));
  await page.setViewportSize({ width: 390, height: 850 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  assert.equal(await page.locator('.clarification-card').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.screenshot({ path: '.tmp/user-clarification/card-dark-narrow.png', fullPage: true });
  await page.getByRole('button', { name: '停止任务' }).click();
  await page.locator('header').filter({ hasText: '已取消' }).waitFor();
  assert.equal(await page.evaluate(() => window.clarificationFixture.stopped), true);
  await page.evaluate(() => window.clarificationFixture.reset({ active: false }));
  await page.getByRole('button', { name: '继续任务并回答' }).click();
  await submit.waitFor();
  assert.equal(await page.evaluate(() => window.clarificationFixture.retried), true);
  // Exercise the actual application navigation used by the desktop reminder.
  // Vite injects CSS in development; production keeps the existing strict CSP.
  const app = await browser.newPage({ viewport: { width: 1200, height: 900 }, bypassCSP: true });
  app.setDefaultTimeout(10000);
  app.on('pageerror', error => errors.push(error.message));
  await app.addInitScript(() => {
    localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ welcomeDismissed: true, taskId: 'other', view: 'dialogue' }));
    const question = { id: 'actual-question', runId: 'actual-run', taskId: 'actual-task', status: 'pending', question: '真实页面上的提问', reason: '需要确认任务范围。', options: [], ordinal: 1, limit: 2 };
    const tasks = [
      { id: 'other', title: '另一项任务', messages: [], permission: 'read-only' },
      { id: 'actual-task', title: '等待回答的任务', permission: 'read-only', messages: [{ id: 'reply', role: 'assistant', status: 'interrupted', content: '', clarifications: [question] }] },
    ];
    window.desktop = {
      theme: { set: async () => {} }, providers: { list: async () => [] },
      tasks: { load: async () => tasks, save: async () => {} },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
      notifications: { onTaskRequested: fn => { window.openQuestionTask = fn; return () => {}; } },
      sandbox: { status: async () => ({ localAvailable: true }) },
      workbench: { request: async ({ action }) => action === 'list' ? [] : true, subscribe: () => () => {} },
      sideChat: { request: async () => ({ messages: [] }), subscribe: () => () => {} },
    };
  });
  await app.goto(server.resolvedUrls.local[0]);
  if (await app.locator('.ax-welcome__enter').isVisible()) await app.locator('.ax-welcome__enter').click();
  await app.waitForFunction(() => typeof window.openQuestionTask === 'function');
  await app.evaluate(() => window.openQuestionTask({ taskId: 'actual-task', clarificationId: 'actual-question' }));
  await app.locator('#clarification-actual-question').waitFor({ state: 'visible' });
  await app.waitForFunction(() => document.activeElement?.closest('#clarification-actual-question'));
  await app.getByRole('button', { name: '执行记录', exact: true }).click();
  await app.locator('#clarification-actual-question').waitFor({ state: 'hidden' });
  await app.evaluate(() => window.openQuestionTask({ taskId: 'actual-task', clarificationId: 'actual-question' }));
  await app.locator('#clarification-actual-question').waitFor({ state: 'visible' });
  await app.waitForFunction(() => document.activeElement?.closest('#clarification-actual-question'));
  assert.equal(await app.locator('#clarification-actual-question button').evaluate(element => element === document.activeElement), true);
  await app.screenshot({ path: '.tmp/user-clarification/app-navigation.png', fullPage: true });
  console.log('PASS full app: reminder switches tasks and returns from execution records to the exact question');
  assert.deepEqual(errors, []);
  console.log('PASS browser: hook integration, options/custom/free text, explicit submit, retry without input loss, cancel, recovery, narrow/dark');
} finally { await browser?.close(); await server.close(); }
