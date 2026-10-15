import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { themeTokens } from '../shared/appearance.js';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 540, height: 850 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await mkdir('.tmp/qa', { recursive: true });
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/workbench-tools-refined.html');
  const action = name => page.getByRole('button', { name, exact: true });
  const setKind = async kind => page.evaluate(kind => window.toolsFixture.kind(kind), kind);
  for (const theme of ['light', 'dark', 'custom']) {
    await page.evaluate(({ theme, tokens }) => {
      const root = document.documentElement; root.dataset.theme = theme === 'light' ? 'light' : 'dark';
      if (theme === 'custom') { root.dataset.customTheme = 'refined'; for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value); }
      else { delete root.dataset.customTheme; root.removeAttribute('style'); }
    }, { theme, tokens: themeTokens({ base: 'dark', colors: { accent: '#31c48d', background: '#0a1410', panel: '#12201a', text: '#e6f2e8' } }) });
    await setKind('git');
    await page.locator('.git-file-row').first().waitFor();
    await page.getByRole('textbox', { name: '提交说明', exact: true }).fill('保留的提交草稿，不提交');
    await page.locator('.git-file-open').first().click();
    await page.getByText('const theme = "shared";', { exact: false }).waitFor();
    for (const selector of ['.git-toolbar', '.git-diff', '.git-commit']) assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
    await page.screenshot({ path: `.tmp/qa/git-refined-${theme}.png` });
    await action('历史').click();
    await page.locator('.git-history article').first().waitFor();
    assert.equal(await page.locator('.git-history article').first().evaluate(el => getComputedStyle(el).borderBottomWidth), '0px');
    await setKind('browser');
    await page.getByRole('textbox', { name: '网址', exact: true }).fill('example.invalid/demo');
    assert.equal(await action('前往').count(), 0);
    assert.equal(await page.getByTitle('控制台', { exact: true }).count(), 0);
    await page.getByRole('textbox', { name: '网址', exact: true }).press('Enter');
    await page.waitForFunction(() => window.toolsFixture.calls.some(call => call.action === 'navigate' && call.url === 'https://example.invalid/demo'));
    await page.getByTitle('后退', { exact: true }).click();
    await page.getByTitle('刷新', { exact: true }).click();
    await page.getByRole('textbox', { name: '网址', exact: true }).press('F12');
    await page.getByText('Starlight preview ready', { exact: true }).waitFor();
    assert.equal(await page.locator('.workbench-console').evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
    assert.equal(await page.locator('.workbench-console-list').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'console no longer inverts the theme gray ramp');
    assert.equal(await page.locator('.workbench-console-row.is-info .workbench-console-text').evaluate(el => getComputedStyle(el).color), await page.locator('.workbench-console-bar').evaluate(el => getComputedStyle(el).color), 'normal log text stays readable like its heading');
    await page.screenshot({ path: `.tmp/qa/browser-refined-${theme}.png` });
    await page.getByRole('textbox', { name: '网址', exact: true }).press('Control+Shift+I');
    await page.locator('.workbench-console').waitFor({ state: 'detached' });
    await page.getByRole('textbox', { name: '网址', exact: true }).press('Control+Shift+J');
    await page.locator('.workbench-console').waitFor();
    await page.evaluate(() => window.toolsFixture.nativeConsole());
    await page.locator('.workbench-console').waitFor({ state: 'detached' });
    await page.evaluate(() => window.toolsFixture.nativeConsole());
    await page.locator('.workbench-console').waitFor();
    await page.evaluate(() => window.toolsFixture.covered(true));
    await page.getByRole('textbox', { name: '网址', exact: true }).press('F12');
    assert.equal(await page.locator('.workbench-console').count(), 1, 'covered browser does not handle shortcuts');
    await page.evaluate(() => window.toolsFixture.covered(false));
    const bounds = await page.locator('.workbench-host').boundingBox();
    assert.ok(bounds.width > 100 && bounds.height > 100);
    assert.ok((await page.evaluate(() => window.toolsFixture.bounds)).some(item => item.width === bounds.width && item.height === bounds.height), 'native host receives actual layout bounds');
    await page.evaluate(() => window.toolsFixture.owner('agent'));
    assert.equal(await page.getByRole('textbox', { name: '网址', exact: true }).isDisabled(), true);
    await action('接管').click();
    await page.evaluate(() => window.toolsFixture.owner('user'));
    await setKind('terminal');
    await page.locator('.xterm').waitFor();
    await page.waitForFunction(() => window.toolsFixture.terminal()?.term.buffer.active.length > 4);
    await page.screenshot({ path: `.tmp/qa/terminal-refined-${theme}.png` });
    await action('终端菜单').click();
    assert.equal(await page.locator('.terminal-menu').evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
    await page.screenshot({ path: `.tmp/qa/terminal-refined-menu-${theme}.png` });
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 320, height: 700 });
  for (const kind of ['git', 'browser', 'terminal']) {
    await setKind(kind);
    const selector = kind === 'git' ? '.workbench-git' : kind === 'browser' ? '.workbench-browser' : '.terminal-pane';
    await page.locator(selector).waitFor();
    assert.equal(await page.locator(selector).evaluate(el => el.scrollWidth <= el.clientWidth), true, `${kind}: no narrow horizontal overflow`);
    if (kind === 'browser') {
      const toolbar = await page.locator('.workbench-browser .workbench-toolbar').boundingBox();
      assert.equal(await page.getByRole('textbox', { name: '网址', exact: true }).evaluate((el, right) => el.getBoundingClientRect().right <= right, toolbar.x + toolbar.width), true);
    }
  }
  const mutations = await page.evaluate(() => window.toolsFixture.calls.filter(call => call.action === 'git' && ['stage', 'unstage', 'commit', 'push', 'pull'].includes(call.operation)));
  assert.deepEqual(mutations, [], 'UI check does not mutate any Git repository');
  assert.deepEqual(errors, []);
  console.log('PASS tool redesign: line-free Git/diff/history, preserved draft, browser navigation/console/takeover and native bounds, real xterm/menu, light/dark/custom and narrow layouts; mocked transports only.');
} finally { await browser.close(); await server.close(); }
