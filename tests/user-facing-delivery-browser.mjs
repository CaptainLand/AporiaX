import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer, preview } from 'vite';
import { chromium } from 'playwright-core';

const production = process.argv.includes('--production');
const server = production ? await preview({ preview: { host: '127.0.0.1', port: 0, open: false } })
  : await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
let browser;
try {
  if (!production) await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  // Dev Vite injects CSS through style tags; production uses CSP-safe links.
  const page = await browser.newPage({ viewport: { width: 1360, height: 950 }, bypassCSP: !production });
  page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    if (!localStorage.getItem('delivery-fixture-started')) {
      localStorage.clear(); localStorage.setItem('delivery-fixture-started', 'yes');
      localStorage.setItem('aporiax.language.v1', 'zh-CN'); localStorage.setItem('aporiax.theme.v2', 'light');
      localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'delivery-ui', welcomeDismissed: true }));
    }
    const task = { id: 'delivery-ui', title: '回复展示检查', workspaceName: 'Fixture', workspacePath: 'D:/Fixture',
      providerId: 'fixture', modelId: 'fixture', messages: [], createdAt: '2026-10-21T00:00:00Z' };
    window.desktop = {
      theme: { set: async () => {} }, account: { get: async () => ({ status: 'anonymous' }) },
      providers: { list: async () => [{ id: 'fixture', name: 'Fixture', models: [{ id: 'fixture', name: 'Fixture', supportsTools: true }] }] },
      tasks: { load: async () => JSON.parse(localStorage.getItem('delivery-fixture-tasks') || 'null') || [task],
        save: async tasks => { localStorage.setItem('delivery-fixture-tasks', JSON.stringify(tasks)); } },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [], run: async () => {
        window.fixtureRuns = (window.fixtureRuns || 0) + 1;
        return { status: 'completed', replyDelivered: true, content: ['计算器做好了，直接打开 calc.html 就能用。支持常用运算和键盘输入，没有覆盖原来的文件。', '预览服务在任务结束后会停止；之后请直接打开文件。'].join(String.fromCharCode(10, 10)),
          deliveryDetails: ['## 具体分析', '', '第 194 行的计算需要统一单位。', '', '```js', 'const angle = value / Math.PI;', '```', '', '仅检查代码，未运行浏览器；实际效果仍需验证。', '', '<script>window.UNSAFE_DETAILS = true</script>'].join(String.fromCharCode(10)),
          steps: [], changes: [], subagents: [] };
      } },
      sandbox: { status: async () => ({ localAvailable: true }) }, workspace: { listTree: async () => ({ entries: [] }) },
      workbench: { subscribe: () => () => {}, request: async input => input.action === 'list' ? [] : true },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  const input = page.getByRole('textbox', { name: '任务输入', exact: true });
  await input.fill('合成展示测试，不请求真实模型。'); await input.press('Enter');
  const disclosure = page.locator('.assistant-delivery-details');
  await disclosure.waitFor();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('delivery-fixture-tasks') || '[]').some(task => task.messages?.some(message => message.deliveryDetails)));
  assert.equal(await page.evaluate(() => window.fixtureRuns), 1, 'the fixture submits only one synthetic turn');
  await page.reload();
  await page.locator('.ax-welcome__enter, .thread-view-tabs').first().waitFor();
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await disclosure.waitFor();
  await mkdir('.tmp/qa/user-facing-delivery', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const summary = disclosure.locator('summary');
    assert.equal(await summary.innerText(), '查看完整回复');
    assert.equal(await disclosure.getAttribute('open'), null, 'details default to collapsed, including after reload');
    assert.equal(await page.getByText('第 194 行的计算需要统一单位。', { exact: true }).isVisible(), false);
    assert.equal(await page.getByText(/仅检查代码，未运行浏览器/).isVisible(), false, 'routine check notes stay in the full reply');
    assert.equal(await page.getByText(/预览服务在任务结束后会停止/).isVisible(), true, 'important usage instructions remain visible');
    await summary.focus(); await page.keyboard.press('Enter');
    assert.equal(await disclosure.getAttribute('open'), '');
    await page.getByText('第 194 行的计算需要统一单位。', { exact: true }).waitFor();
    assert.equal(await page.getByText(/仅检查代码，未运行浏览器/).isVisible(), true, 'full reply retains the unverified scope');
    const text = disclosure.locator('.markdown-message');
    assert.equal(await text.evaluate(el => getComputedStyle(el).fontSize), '14px');
    assert.equal(await page.evaluate(() => window.UNSAFE_DETAILS), undefined, 'details do not execute raw HTML');
    assert.equal(await disclosure.locator('.code-block').count(), 1, 'fenced code retains its component');
    await summary.click();
    await page.locator('.assistant-message').screenshot({ path: `.tmp/qa/user-facing-delivery/${theme}-collapsed.png` });
  }
  await page.setViewportSize({ width: 1000, height: 700 });
  await disclosure.locator('summary').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('.assistant-message').screenshot({ path: '.tmp/qa/user-facing-delivery/dark-expanded.png' });
  assert.deepEqual(errors, []);
  console.log(`PASS ${production ? 'production CSP' : 'dev'} actual app synthetic completion, save/reload, full reply label, folded routine notes, visible usage warning, keyboard, light/dark, narrow viewport and safe Markdown. No real model requests.`);
} finally { await browser?.close(); if (production) await new Promise(resolve => server.httpServer.close(resolve)); else await server.close(); }
