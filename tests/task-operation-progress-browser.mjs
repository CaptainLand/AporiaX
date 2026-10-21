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
  const track = page.locator('.witness-panel [role="progressbar"]');
  assert.equal(await track.getAttribute('aria-valuenow'), null, 'unknown total is indeterminate');
  assert.equal(await page.locator('.witness-heading > b').innerText(), '正在做');
  assert.equal(await track.locator('span').evaluate(element => getComputedStyle(element).animationName), 'witness-activity');
  const plan = { steps: [{ title: '已处理', status: 'completed' }, { title: '处理中', status: 'in_progress' }] };
  await page.evaluate(plan => window.witnessProgressState({ plan }), plan);
  await page.locator('.witness-heading > b').filter({ hasText: '已完成 1/2 步' }).waitFor();
  assert.equal(await track.getAttribute('aria-valuenow'), '50');
  assert.equal(await track.locator('span').evaluate(element => getComputedStyle(element).animationName), 'none');
  for (const [status, label] of Object.entries({ partial: '部分完成', blocked: '任务受阻', needs_input: '等待补充', failed: '失败', interrupted: '已停止', paused: '已暂停', waiting: '等待确认' })) {
    await page.evaluate(status => window.witnessProgressState({ status: 'running', witness: { status, records: [] } }), status);
    await page.locator('.witness-panel').filter({ has: page.locator('.witness-current > span', { hasText: label }) }).waitFor();
    assert.equal(await track.getAttribute('aria-valuenow'), null);
    assert.equal(await track.locator('span').evaluate(element => getComputedStyle(element).animationName), 'none', 'inactive states do not animate');
    assert.equal((await page.locator('.witness-panel').innerText()).includes('100%'), false);
  }
  await page.evaluate(() => window.witnessProgressState({ status: 'partial', content: '已经输出部分结果。', witness: { status: 'completed', records: [] } }));
  await page.locator('.witness-current > span').filter({ hasText: '部分完成' }).waitFor();
  assert.equal(await page.locator('.witness-heading > b').innerText(), '部分完成', 'reply delivery cannot mark a partial task done');
  await page.evaluate(() => window.witnessProgressState({ status: 'completed', content: '任务完成。', witness: { status: 'running', records: [] } }));
  await page.locator('.witness-heading > b').filter({ hasText: '100%' }).waitFor();
  assert.equal(await track.getAttribute('aria-valuenow'), '100');
  await page.evaluate(() => window.witnessProgressState({ witness: { status: 'running', records: [] } }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await track.locator('span').evaluate(element => getComputedStyle(element).animationName), 'none');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.witness-panel').evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await page.locator('.witness-panel').screenshot({ path: '.tmp/task-operation-qa/progress-indeterminate-narrow.png' });
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/route-activity.html');
  await page.evaluate(() => window.routeFixture.emit({ type: 'response.progress', stage: 'tool-arguments', outputTokens: 1200, inputTokens: 3000 }));
  await page.locator('.ra-current-row').filter({ hasText: '1,200' }).waitFor();
  assert(!await page.locator('.route-activity').innerText().then(text => text.includes('阿珀')));
  assert.deepEqual(errors, []);
  console.log('PASS operation progress UI: output-only Tokens, privacy, honest plan/unknown/terminal states, reply delivery, pause, reduced motion, light/dark and narrow layout.');
} finally { await browser.close(); await server.close(); }
