import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
const baseline = process.argv.includes('--baseline');
const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const base = server.resolvedUrls.local[0];
  await mkdir('.tmp/qa', { recursive: true });
  await page.goto(base + 'tests/fixtures/extension-library.html');
  await page.locator('.extensions-heading h3').waitFor();
  if (baseline) assert.match(await page.locator('.extensions-heading h3').innerText(), /新的方法/);
  else {
    assert.equal(await page.locator('.extensions-heading h3').innerText(), 'Skills 和 MCP');
    assert.equal(await page.locator('.extensions-heading > span, .extensions-heading > p').count(), 0);
  }
  await page.locator('.extensions-heading').screenshot({ path: `.tmp/qa/extensions-heading-${baseline ? 'baseline' : 'reduced'}.png` });
  await page.getByRole('button', { name: '已安装', exact: true }).click();
  await page.getByText('缺少环境变量: GITHUB_MCP_TOKEN').waitFor();
  await page.getByRole('button', { name: '来源与权限', exact: true }).click();
  assert.equal(await page.locator('.extensions-tabs button.active').innerText(), '来源与权限');
  await page.goto(base + 'tests/fixtures/route-activity.html');
  await page.locator('.ra-run-trigger').waitFor();
  assert.equal(await page.locator('.ra-eyebrow').count(), baseline ? 1 : 0);
  assert.equal(await page.locator('.ra-retention').count(), baseline ? 1 : 0);
  await page.getByRole('button', { name: '选择任务轮次', exact: true }).click();
  assert.equal(await page.locator('.ra-run-list button').count(), 2);
  await page.locator('.ra-run-list button').last().click();
  await page.getByRole('button', { name: '回到最新一轮', exact: true }).click();
  await page.evaluate(() => window.routeFixture.setRetention(8));
  await page.locator('.ra-retention').filter({ hasText: '更早的工具记录' }).waitFor();
  if (!baseline) assert.doesNotMatch(await page.locator('.ra-retention').innerText(), /最新记录在上|不代表完成百分比/);
  await page.evaluate(() => window.routeFixture.setRetention(0));
  await page.locator('.route-activity').screenshot({ path: `.tmp/qa/activity-copy-${baseline ? 'baseline' : 'reduced'}.png` });
  await page.goto(base + 'tests/fixtures/composer-workbench.html');
  await page.locator('.composer textarea').waitFor();
  assert.equal(await page.locator('.composer-hint').count(), baseline ? 1 : 0);
  const composer = page.locator('.composer textarea');
  await composer.fill('快捷键功能保留'); await page.keyboard.press('Shift+Enter');
  assert.match(await composer.inputValue(), /\n/);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.fixtureSendCount === 1);
  await page.locator('.composer').locator('..').screenshot({ path: `.tmp/qa/composer-copy-${baseline ? 'baseline' : 'reduced'}.png` });
  for (const [state, expected] of [['running', '任务运行中'], ['paused', '任务已暂停'], ['locked', '先登录 Cloud']]) {
    await page.goto(base + `tests/fixtures/composer-workbench.html?hintState=${state}`);
    await page.locator('.composer-hint').waitFor();
    assert.match(await page.locator('.composer-hint').innerText(), new RegExp(expected));
  }
  await page.goto(base + 'tests/fixtures/extension-library.html?theme=dark');
  await page.locator('.extensions-heading h3').waitFor();
  await page.locator('.extensions-heading').screenshot({ path: `.tmp/qa/extensions-heading-${baseline ? 'baseline' : 'reduced'}-dark.png` });
  assert.deepEqual(errors, []);
  console.log(`${baseline ? 'BASELINE' : 'PASS'} specified headings/hints, run selection, retention warning, Enter/Shift+Enter, running/paused/no-model notices, extension tabs/error states, light/dark, no real model requests.`);
} finally { await browser.close(); await server.httpServer.close(); }
