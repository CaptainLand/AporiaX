import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';

const server = await createServer({ configFile: false, plugins: [react()], cacheDir: '.tmp/file-search-vite',
  optimizeDeps: { entries: ['tests/fixtures/file-search.html'] }, server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 640, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.searchFixture = { calls: [], pending: {}, opened: [], request(input) {
      this.calls.push(input);
      if (input.action === 'cancel-search') return Promise.resolve(true);
      return new Promise((resolve, reject) => { this.pending[input.query] = { resolve, reject }; });
    } };
  });
  for (const theme of ['dark', 'light']) {
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/file-search.html?theme=${theme}`);
    const input = page.getByRole('textbox', { name: '工作区文件搜索' });
    await input.fill('account');
    await page.getByRole('status').filter({ hasText: '正在查找文件' }).waitFor();
    await page.waitForFunction(() => window.searchFixture.pending.account);
    await input.fill('settings');
    await page.waitForFunction(() => window.searchFixture.pending.settings);
    const calls = await page.evaluate(() => window.searchFixture.calls);
    assert.ok(calls.some(call => call.action === 'cancel-search' && call.searchId === calls.find(call => call.query === 'account').searchId));
    await page.evaluate(() => {
      window.searchFixture.pending.settings.resolve({ entries: [{ path: 'src/Settings.jsx', name: 'Settings.jsx', type: 'file' }], complete: true, truncated: false });
      window.searchFixture.pending.account.resolve({ entries: [{ path: 'old.jsx', name: 'old.jsx' }], complete: true, truncated: false });
    });
    await page.getByRole('button', { name: 'Settings.jsx' }).waitFor();
    assert.equal(await page.getByText('old.jsx', { exact: true }).count(), 0, 'Late responses never overwrite the new query');
    await page.getByRole('button', { name: 'Settings.jsx' }).dblclick();
    assert.deepEqual(await page.evaluate(() => window.searchFixture.opened), ['src/Settings.jsx']);
    await input.fill('missing');
    await page.waitForFunction(() => window.searchFixture.pending.missing);
    await page.evaluate(() => window.searchFixture.pending.missing.resolve({ entries: [], truncated: true, complete: false }));
    await page.getByText('尚未找到匹配文件，请缩小范围后重试。', { exact: true }).waitFor();
    assert.equal(await page.getByText('没有匹配的文件', { exact: true }).count(), 0);
    await input.fill('slow');
    await page.waitForFunction(() => window.searchFixture.pending.slow);
    await page.evaluate(() => window.searchFixture.pending.slow.reject(Error('搜索超过 15 秒，请缩小目录或增加文件筛选后重试。')));
    await page.getByRole('status').filter({ hasText: '搜索超过 15 秒' }).waitFor();
    await input.fill('');
    await page.getByText('文件树', { exact: true }).waitFor();
  }
  assert.deepEqual(errors, []);
  console.log('PASS filename search UI: loading, cancellation, stale responses, file opening, truthful partial results, timeout recovery and light/dark themes.');
} finally {
  await browser?.close();
  await server.close();
}
