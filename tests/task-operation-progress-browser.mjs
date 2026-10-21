import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } }); await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } }); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await mkdir('.tmp/task-operation-qa', { recursive: true });
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/task-operation-progress.html');
  await page.locator('.witness-panel').waitFor();
  assert.match(await page.locator('.witness-current').innerText(), /AporiaX 正在思考或工作中/);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.evaluate(() => window.operationProgress({ type: 'response.progress', stage: 'tool-arguments', outputTokens: 12345, inputTokens: 99888, outputTokensEstimated: true, inputTokensEstimated: true, toolName: 'apply_patch', arguments: 'PRIVATE_DO_NOT_DISPLAY' }));
    await page.locator('.witness-current').filter({ hasText: '12,345' }).waitFor();
    const text = await page.locator('.witness-panel').innerText();
    assert.equal(await page.locator('.witness-current p').innerText(), '↓ ≈12,345 Token');
    assert(!text.includes('↑')); assert(!text.includes('99,888'));
    assert.match(await page.locator('.witness-current p').getAttribute('title'), /尚未执行/);
    assert(!text.includes('字符')); assert(!text.includes('阿珀')); assert(!text.includes('PRIVATE_DO_NOT_DISPLAY')); assert(!text.includes('活动信号来自模型响应'));
    await page.locator('.witness-panel').screenshot({ path: `.tmp/task-operation-qa/progress-${theme}.png` });
  }
  await page.evaluate(() => window.operationProgress({ type: 'response.progress', stage: 'text', outputTokens: 12500, inputTokens: 99000, outputTokensEstimated: false, inputTokensEstimated: false }));
  await page.locator('.witness-current').filter({ hasText: '↓ 12,500 Token' }).waitFor();
  assert.equal(await page.locator('.witness-current p').innerText(), '↓ 12,500 Token');
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/route-activity.html');
  await page.evaluate(() => window.routeFixture.emit({ type: 'response.progress', stage: 'tool-arguments', outputTokens: 1200, inputTokens: 3000 }));
  await page.locator('.ra-current-row').filter({ hasText: '1,200' }).waitFor();
  assert(!await page.locator('.route-activity').innerText().then(text => text.includes('阿珀')));
  assert.deepEqual(errors, []);
  console.log('PASS operation progress UI: output-only ↓ Token counters, live estimate marker, reported usage reconciliation, stage tooltip, privacy and light/dark screenshots.');
} finally { await browser.close(); await server.close(); }
