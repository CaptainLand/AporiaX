import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const output = '.tmp/model-recovery-qa';
await mkdir(output, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const emit = (event, elapsedMs = 0) => page.evaluate(({ event, elapsedMs }) => window.operationProgress(event, elapsedMs), { event, elapsedMs });
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/task-operation-progress.html');
  await page.locator('.witness-panel').waitFor();
  const state = { type: 'response.recovery.status', responseId: 'fixture-stream', maxAttempts: 3, connection: 'open' };
  await emit({ type: 'response.progress', stage: 'receiving', generatedChars: 15719, outputTokens: 4419, outputTokensEstimated: true });
  await emit({ ...state, state: 'checking', attempt: 1, idleMs: 180_000 }, 180_000);
  await page.locator('.witness-heading > b').filter({ hasText: '恢复检查 1/3' }).waitFor();
  assert.match(await page.locator('.witness-current').innerText(), /连续 3 分钟未收到新增模型数据/);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.locator('.witness-panel').screenshot({ path: `${output}/checking-${theme}.png` });
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await emit({ ...state, state: 'checking', attempt, idleMs: attempt * 180_000 }, 180_000);
    await emit({ ...state, state: 'waiting', attempt, idleMs: attempt * 180_000, disposition: 'unsupported' });
  }
  await page.locator('.witness-heading > b').filter({ hasText: '等待模型数据' }).waitFor();
  assert.equal(await page.locator('.witness-panel').getAttribute('data-status'), 'running');
  const text = await page.locator('.witness-current').innerText();
  assert.match(text, /不再自动重试/); assert.match(text, /已有工作已保留/);
  assert(!text.includes('失败')); assert(!text.includes('正在思考'));
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.locator('.witness-panel').screenshot({ path: `${output}/waiting-third-${theme}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.locator('.witness-panel').evaluate(el => el.scrollWidth <= el.clientWidth));
  await page.locator('.witness-panel').screenshot({ path: `${output}/waiting-third-narrow.png` });
  await page.setViewportSize({ width: 1100, height: 900 });
  await emit({ ...state, state: 'waiting', attempt: 3, connection: 'closed' });
  await page.locator('.witness-current p').filter({ hasText: '连接已断开' }).waitFor();
  assert.equal(await page.locator('.witness-panel').getAttribute('data-status'), 'running');
  await page.locator('.witness-panel').screenshot({ path: `${output}/disconnected-dark.png` });
  await emit({ ...state, state: 'receiving', attempt: 0, disposition: 'resumed' });
  await page.locator('.witness-ledger').filter({ hasText: '已恢复接收模型数据' }).waitFor();
  assert(!await page.locator('.witness-current').innerText().then(text => text.includes('长时间未收到')));
  assert.equal(await page.locator('.witness-panel').getAttribute('data-status'), 'running');
  assert.deepEqual(errors, []);
  console.log('PASS real Witness component: recovery 1/3, third remains running, no false failure/thinking label, closed connection and late resumption; light/dark, 390px screenshots. Synthetic events only.');
} finally { await browser.close(); await server.close(); }
