import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const server = await createServer({ configFile: false, cacheDir: '.tmp/conversation-progress-vite',
  optimizeDeps: { entries: ['tests/fixtures/conversation-progress.html'] },
  server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/conversation-progress.html`);
  const disclosures = page.locator('.assistant-progress-disclosure');
  await disclosures.nth(1).waitFor();
  const history = disclosures.first();
  const active = disclosures.nth(1);
  const assertOpen = async (locator, expected, reason) => {
    await page.waitForFunction(({ index, expected }) => {
      const element = document.querySelectorAll('.assistant-progress-disclosure')[index];
      return element && element.open === expected;
    }, { index: await locator.evaluate(element => [...document.querySelectorAll('.assistant-progress-disclosure')].indexOf(element)), expected });
    assert.equal(await locator.evaluate(element => element.open), expected, reason);
    assert.equal(await locator.locator('summary').getAttribute('aria-expanded'), String(expected));
    assert.equal(await locator.locator('summary').getAttribute('aria-label'), expected ? '收起任务进展' : '展开任务进展');
    assert.equal(await locator.locator('.assistant-progress-journal').isVisible(), expected);
  };
  const click = name => page.getByRole('button', { name, exact: true }).click();

  await assertOpen(history, false, 'history defaults collapsed');
  await assertOpen(active, true, 'a currently running answer defaults expanded on mount');
  assert.equal(await active.locator('.assistant-progress-entry:visible').count(), 2);
  await click('流式正文');
  await click('追加进展');
  await assertOpen(active, true, 'streaming body and new stages do not collapse progress');
  await active.locator('summary').click();
  await assertOpen(active, false, 'user can collapse while running');
  await click('流式正文');
  await click('追加进展');
  await assertOpen(active, false, 'streaming updates preserve the manual collapse');
  await active.locator('summary').focus();
  await page.keyboard.press('Enter');
  await assertOpen(active, true, 'keyboard can expand while running');
  assert.equal(await active.locator('.assistant-progress-entry:visible').count(), 4, 'all stages expand at once');
  await click('完成本轮');
  await assertOpen(active, false, 'completion automatically collapses an expanded journal');
  await active.locator('summary').focus();
  await page.keyboard.press('Space');
  await assertOpen(active, true, 'completed progress remains available via keyboard');
  await click('流式正文');
  await assertOpen(active, true, 'late final-answer updates do not close manually reopened history');
  await active.locator('summary').click();

  for (const end of ['运行失败', '停止本轮', '仅停止运行标记']) {
    await click('开始新一轮');
    await assertOpen(history, false, 'a new run must not reopen historical progress');
    await assertOpen(active, false, 'the previous turn remains collapsed');
    await click('追加进展');
    const current = disclosures.last();
    await assertOpen(current, true, 'the first progress update in a new run appears expanded');
    await click(end);
    await assertOpen(current, false, `${end} closes progress`);
  }
  // The last fixture message still says "running", but is no longer the active turn.
  const stale = disclosures.last();
  const staleIndex = await stale.evaluate(element => [...document.querySelectorAll('.assistant-progress-disclosure')].indexOf(element));
  await click('开始新一轮');
  await click('追加进展');
  await assertOpen(disclosures.nth(staleIndex), false, 'stale running history is not treated as the active response');
  await assertOpen(disclosures.last(), true, 'only the newest active response defaults open');
  assert.deepEqual(errors, [], 'no browser errors');
  console.log('PASS: running defaults open, manual toggling survives streams, terminal states auto-collapse, history stays independent.');
} finally {
  await browser?.close();
  await server.close();
}
